import "server-only";

import { Prisma, type GscSiteLink, type SeoSite } from "@prisma/client";

import {
  COVERAGE_SAMPLE_TARGET,
  INSPECTIONS_PER_RUN,
  INSPECTION_RUN_GAP_MS,
} from "@/lib/seo/audit-constants";
import {
  crawlUrlHash,
  inScope,
  normalizeCrawlUrl,
  scopeFromGscSite,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import {
  addWeeks,
  gscToday,
  lastCompleteWeekStart,
  weekStartOf,
} from "@/lib/seo/dates";
import { GscFlags, gscSyncAllowedFor } from "@/lib/seo/flags";
import { nextPacificMidnight } from "@/lib/seo/governor";
import {
  SeoFlags,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "@/lib/seo/health-flags";
import type { ParsedInspection } from "@/lib/seo/inspection";
import {
  dailyP6Target,
  planInspections,
  sampleOrder,
  type InspectionHistory,
  type InspectionReason,
} from "@/lib/seo/inspection-plan";
import { prisma } from "@/lib/prisma";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { gscQuotaKind } from "@/server/integrations/search-console/errors";
import { inspectUrl } from "@/server/integrations/search-console/url-inspection";
import {
  gscDataThrough,
  primaryGscLink,
  readTopPages,
} from "@/server/seo/store";
import {
  appendInspectQueue,
  parseInspectQueue,
  removeFromInspectQueue,
} from "@/server/seo/site/inspect-queue";
import { SeoSites } from "@/server/seo/site/sites";

import { refreshCoverageWeek } from "./coverage";

// Bütçeli URL Inspection örnekleyicisi (docs/search-health.md "URL
// Inspection", SK6 (a)): `gsc-inspect` tick adımı.
// - Bütçe: site başına PT günü 200 inceleme, SeoSite üzerinde tek bir atomik
//   SQL CAS (reserveInspection); tur başına en çok 10.
// - Turlar arası en az 60 sn (inspectLastRunAt): dakikada ≤ 10 her zaman.
// - Öncelik P1–P6 (src/lib/seo/inspection-plan.ts).
// - Kota hatası: RATE/LOAD 15 dk, günlük kota PT gece yarısına kadar duraklatır.
// - Yetki/izin hatası: 6 saat bekler (kullanıcının düzeltmesi gerekir).
// Geliştirme süreci yalnız SEO ve GSC izin listesindeki projelere dokunur
// (gscSyncAllowedFor: Google kotası harcanmaz). Bayraklar kapalıyken hiçbir
// sorgu yapılmaz.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const STOP_WAIT_MS = 6 * HOUR_MS;
const QUOTA_SHORT_WAIT_MS = 15 * 60_000;
const IDLE_WAIT_MS = 15 * 60_000;
const DEFAULT_DEADLINE_MS = 20_000;
const CANDIDATES = 20;
const P2_WINDOW_MS = 14 * DAY_MS;
const P2_ROWS = 200;
const P3_LIMIT = 50;
const P4_PREVIOUS_LIMIT = 200;
const P4_CURRENT_LIMIT = 500;
const P4_MIN_CLICKS = 10;
const P5_LIMIT = 50;

// Kullanıcının düzeltmesi gereken bağ durumları (W1 senkronuyla aynı küme).
const STOPPED_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

const AUTH_CLASSES = new Set<GoogleErrorClass>([
  "AUTH",
  "SCOPE_MISSING",
  "PERMISSION",
  "NOT_FOUND",
  "API_DISABLED",
]);

export type InspectionRunResult = {
  inspected: number;
  stopped:
    null | "budget" | "quota" | "auth" | "deadline" | "no_link" | "not_allowed";
};

type InspectFn = typeof inspectUrl;

// Atomik bütçe: PT günü değiştiyse sayaç 1'den başlar, değilse bütçenin
// altındaysa artar. Tek satır güncellendiyse hak alındı.
export async function reserveInspection(
  siteId: string,
  now: Date,
): Promise<boolean> {
  const day = gscToday(now);
  const affected =
    await prisma.$executeRaw`UPDATE "SeoSite" SET "inspectCount" = CASE WHEN "inspectDay" = ${day} THEN "inspectCount" + 1 ELSE 1 END, "inspectDay" = ${day}, "updatedAt" = ${now} WHERE "id" = ${siteId} AND ("inspectDay" IS DISTINCT FROM ${day} OR "inspectCount" < "inspectBudget")`;
  return affected === 1;
}

type QuotaOutcome =
  | { kind: "pause"; until: Date }
  | { kind: "auth" }
  | { kind: "skip" }
  | { kind: "count" };

// Hata sınıfına göre ne yapılacağı. Günlük kota (ya da dakika demeyen bir
// 429 kota mesajı) PT gece yarısına, dakikalık/yük kotası 15 dakikaya
// erteler.
export function inspectionErrorOutcome(
  error: unknown,
  now: Date,
): QuotaOutcome {
  if (!(error instanceof GoogleApiError)) return { kind: "count" };
  const quota = gscQuotaKind(error);
  if (
    quota === "DAILY" ||
    (error.httpStatus === 429 &&
      /quota/i.test(error.message) &&
      !/minute/i.test(error.message))
  ) {
    return { kind: "pause", until: nextPacificMidnight(now) };
  }
  if (quota === "RATE" || quota === "LOAD") {
    return {
      kind: "pause",
      until: new Date(now.getTime() + QUOTA_SHORT_WAIT_MS),
    };
  }
  if (AUTH_CLASSES.has(error.errorClass)) return { kind: "auth" };
  if (error.errorClass === "VALIDATION") return { kind: "skip" };
  return { kind: "count" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function setSchedule(
  siteId: string,
  data: Prisma.SeoSiteUpdateManyMutationInput,
): Promise<void> {
  await prisma.seoSite.updateMany({ where: { id: siteId }, data });
}

// GSC sayfa adresi → tarama adresi; maskeli ("[") adresler atlanır.
function crawlUrlOf(url: string | null): string | null {
  if (!url || url.includes("[")) return null;
  return normalizeCrawlUrl(url);
}

function hashOf(url: string): string {
  return crawlUrlHash(normalizeCrawlUrl(url) ?? url);
}

type PlanInputs = {
  p1: { url: string; urlHash: string }[];
  p2: { url: string; firstSeenAt: Date }[];
  p3: string[];
  p4: string[];
  p5: string[];
  pool: string[];
  sampledThisWeek: number;
  sampledToday: number;
};

async function loadPlanInputs(
  site: SeoSite,
  link: GscSiteLink,
  now: Date,
  week: string,
): Promise<PlanInputs> {
  const p1 = parseInspectQueue(site.inspectQueue).map((entry) => ({
    url: entry.url,
    urlHash: entry.urlHash,
  }));
  const dayStart = new Date(nextPacificMidnight(now).getTime() - DAY_MS);

  const [p2Rows, through, p5Rows, poolRows, sampledThisWeek, sampledToday] =
    await Promise.all([
      prisma.seoPage.findMany({
        where: {
          siteId: site.id,
          inSitemap: true,
          sitemapFirstSeenAt: {
            not: null,
            gte: new Date(now.getTime() - P2_WINDOW_MS),
          },
        },
        orderBy: { sitemapFirstSeenAt: "desc" },
        take: P2_ROWS,
        select: { url: true, sitemapFirstSeenAt: true },
      }),
      gscDataThrough(link.id),
      prisma.$queryRaw<{ url: string }[]>`
        SELECT "url" FROM "SeoPage"
         WHERE "siteId" = ${site.id}
           AND ("issues" @> '[{"code":"TA7"}]'::jsonb
             OR "issues" @> '[{"code":"TA8"}]'::jsonb)
         ORDER BY "inlinks" DESC, "url" ASC
         LIMIT ${P5_LIMIT}
      `,
      prisma.$queryRaw<{ url: string }[]>`
        SELECT p."url" FROM "SeoPage" p
          LEFT JOIN "GscUrlInspection" i
            ON i."linkId" = ${link.id} AND i."urlHash" = p."urlHash"
         WHERE p."siteId" = ${site.id}
           AND p."inSitemap" = true
           AND (i."sampleWeek" IS NULL OR i."sampleWeek" <> ${week})
      `,
      prisma.gscUrlInspection.count({
        where: { linkId: link.id, sampleWeek: week },
      }),
      prisma.gscUrlInspection.count({
        where: {
          linkId: link.id,
          sampleWeek: week,
          inspectedAt: { gte: dayStart },
        },
      }),
    ]);

  let p3: string[] = [];
  let p4: string[] = [];
  if (through.finalThrough) {
    const lastWeek = lastCompleteWeekStart(through.finalThrough);
    const current = { from: addWeeks(lastWeek, -3), to: lastWeek };
    const previous = {
      from: addWeeks(lastWeek, -7),
      to: addWeeks(lastWeek, -4),
    };
    const [top, previousRows, currentRows] = await Promise.all([
      readTopPages(link.id, current, { limit: P3_LIMIT }),
      readTopPages(link.id, previous, { limit: P4_PREVIOUS_LIMIT }),
      readTopPages(link.id, current, { limit: P4_CURRENT_LIMIT }),
    ]);
    p3 = top
      .map((row) => crawlUrlOf(row.url))
      .filter((url): url is string => url !== null);
    const currentClicks = new Map(
      currentRows.map((row) => [row.url, row.clicks]),
    );
    p4 = previousRows
      .filter(
        (row) =>
          row.clicks >= P4_MIN_CLICKS &&
          (currentClicks.get(row.url) ?? 0) < row.clicks * 0.5,
      )
      .map((row) => crawlUrlOf(row.url))
      .filter((url): url is string => url !== null);
  }

  return {
    p1,
    p2: p2Rows.flatMap((row) =>
      row.sitemapFirstSeenAt
        ? [{ url: row.url, firstSeenAt: row.sitemapFirstSeenAt }]
        : [],
    ),
    p3,
    p4,
    p5: p5Rows.map((row) => row.url),
    pool: poolRows.map((row) => row.url),
    sampledThisWeek,
    sampledToday,
  };
}

async function historyFor(
  linkId: string,
  urls: readonly string[],
): Promise<Map<string, InspectionHistory>> {
  const hashes = [...new Set(urls.map(hashOf))];
  if (hashes.length === 0) return new Map();
  const rows = await prisma.gscUrlInspection.findMany({
    where: { linkId, urlHash: { in: hashes } },
    select: { urlHash: true, inspectedAt: true, inspectCount: true },
  });
  return new Map(
    rows.map((row) => [
      row.urlHash,
      { lastInspectedAt: row.inspectedAt, inspectCount: row.inspectCount },
    ]),
  );
}

// Sonucu (linkId, urlHash) satırına yazar; karar değişince önceki hâl
// `previous`'a geçer (değişmezse eski `previous` korunur).
// Döndürülen: karar değişti mi.
async function storeInspection(input: {
  link: GscSiteLink;
  url: string;
  reason: InspectionReason;
  result: ParsedInspection;
  week: string;
  now: Date;
}): Promise<boolean> {
  const { link, result, now } = input;
  const normalized = normalizeCrawlUrl(input.url) ?? input.url;
  const urlHash = crawlUrlHash(normalized);
  const fields = {
    url: normalized,
    reason: input.reason,
    inspectedAt: now,
    verdict: result.verdict,
    coverageState: result.coverageState,
    indexingState: result.indexingState,
    robotsTxtState: result.robotsTxtState,
    pageFetchState: result.pageFetchState,
    googleCanonical: result.googleCanonical,
    userCanonical: result.userCanonical,
    lastCrawlTime: result.lastCrawlTime,
    crawledAs: result.crawledAs,
    sitemaps: result.sitemaps,
    referringUrls: result.referringUrls,
    richResults: result.richResults ?? Prisma.DbNull,
  };
  const existing = await prisma.gscUrlInspection.findUnique({
    where: { linkId_urlHash: { linkId: link.id, urlHash } },
  });
  if (!existing) {
    try {
      await prisma.gscUrlInspection.create({
        data: {
          ...fields,
          linkId: link.id,
          projectId: link.projectId,
          urlHash,
          sampleWeek: input.reason === "P6" ? input.week : null,
        },
      });
    } catch (error) {
      // Eşzamanlı ikinci yazım (P2002) ya da arada silinen bağ (P2003):
      // sonuç atlanır, bir sonraki turda yeniden incelenir.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" || error.code === "P2003")
      ) {
        return false;
      }
      throw error;
    }
    return false;
  }
  const changed = existing.verdict !== result.verdict;
  await prisma.gscUrlInspection.update({
    where: { id: existing.id },
    data: {
      ...fields,
      inspectCount: { increment: 1 },
      // `previous` yalnız karar değişince yazılır: değişmeyen bir yeniden
      // inceleme (PASS → FAIL → FAIL) değişiklik öncesi hâli silmesin, yoksa
      // SH7 sayfa hâlâ dizinde değilken kendiliğinden kapanır.
      ...(changed
        ? {
            previous: {
              verdict: existing.verdict,
              coverageState: existing.coverageState,
              googleCanonical: existing.googleCanonical,
              inspectedAt: existing.inspectedAt.toISOString(),
            },
            verdictChangedAt: now,
          }
        : {}),
      sampleWeek: input.reason === "P6" ? input.week : existing.sampleWeek,
    },
  });
  return changed;
}

async function accessTokenFor(link: GscSiteLink): Promise<string | null> {
  if (seoMockMode()) return "mock-access-token";
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: link.credentialId },
    select: { id: true, status: true, encryptedSecret: true },
  });
  if (
    !credential ||
    credential.status !== "ACTIVE" ||
    !credential.encryptedSecret
  ) {
    return null;
  }
  return getFreshGoogleAccessToken(credential);
}

async function coverageWeekStale(linkId: string, week: string, now: Date) {
  const latest = await prisma.gscCoverageWeek.findFirst({
    where: { linkId },
    orderBy: { weekStart: "desc" },
    select: { weekStart: true, computedAt: true },
  });
  if (!latest) return true;
  const latestWeek = latest.weekStart.toISOString().slice(0, 10);
  return (
    latestWeek < week || now.getTime() - latest.computedAt.getTime() > DAY_MS
  );
}

async function runSiteClaimed(
  siteId: string,
  now: Date,
  options: { inspect: InspectFn; perRun: number; deadline: number },
): Promise<InspectionRunResult> {
  const site = await prisma.seoSite.findUnique({ where: { id: siteId } });
  if (!site) return { inspected: 0, stopped: "not_allowed" };
  if (
    !seoWorkAllowedFor(site.projectId) ||
    !gscSyncAllowedFor(site.projectId)
  ) {
    await setSchedule(site.id, { inspectNextAt: null });
    return { inspected: 0, stopped: "not_allowed" };
  }

  const retryLater = new Date(now.getTime() + STOP_WAIT_MS);
  const link = await primaryGscLink(site.projectId);
  const scope: CrawlScope | null = link ? scopeFromGscSite(link.siteUrl) : null;
  if (!link || !scope) {
    await setSchedule(site.id, { inspectNextAt: retryLater });
    return { inspected: 0, stopped: "no_link" };
  }
  if (STOPPED_HEALTH.has(link.health)) {
    await setSchedule(site.id, { inspectNextAt: retryLater });
    return { inspected: 0, stopped: "auth" };
  }

  const pauseFor = async (
    error: unknown,
    inspected: number,
  ): Promise<InspectionRunResult | null> => {
    const outcome = inspectionErrorOutcome(error, now);
    if (outcome.kind === "pause") {
      await setSchedule(site.id, {
        inspectPausedUntil: outcome.until,
        inspectNextAt: outcome.until,
      });
      return { inspected, stopped: "quota" };
    }
    if (outcome.kind === "auth") {
      await setSchedule(site.id, { inspectNextAt: retryLater });
      return { inspected, stopped: "auth" };
    }
    return null;
  };

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFor(link);
  } catch (error) {
    const stopped = await pauseFor(error, 0);
    if (stopped) return stopped;
    throw error;
  }
  if (!accessToken) {
    await setSchedule(site.id, { inspectNextAt: retryLater });
    return { inspected: 0, stopped: "auth" };
  }

  const today = gscToday(now);
  const week = weekStartOf(today);
  const remaining =
    site.inspectBudget - (site.inspectDay === today ? site.inspectCount : 0);
  if (remaining <= 0) {
    await setSchedule(site.id, { inspectNextAt: nextPacificMidnight(now) });
    return { inspected: 0, stopped: "budget" };
  }

  const inputs = await loadPlanInputs(site, link, now, week);
  const history = await historyFor(link.id, [
    ...inputs.p2.map((row) => row.url),
    ...inputs.p3,
    ...inputs.p4,
    ...inputs.p5,
  ]);
  const withHistory = (url: string): InspectionHistory =>
    history.get(hashOf(url)) ?? { lastInspectedAt: null, inspectCount: 0 };

  const target = Math.min(
    COVERAGE_SAMPLE_TARGET,
    inputs.pool.length + inputs.sampledThisWeek,
  );
  const dailyTarget = dailyP6Target({
    target,
    sampledThisWeek: inputs.sampledThisWeek,
    sampledToday: inputs.sampledToday,
    today,
    weekStart: week,
  });
  const slots = Math.min(options.perRun, remaining);
  const seed = `${site.id}:${week}`;
  // Haftalık hedefin kalanı kadar örnek havuza girer (aynı tohumla aynı sıra).
  const p6Need = Math.max(0, target - inputs.sampledThisWeek);
  const p1ByUrl = new Map(inputs.p1.map((entry) => [entry.url, entry.urlHash]));

  // Bir fazlası istenir: plan yuvalardan uzunsa iş bitmemiştir.
  const fullPlan = planInspections({
    now,
    slots: slots + 1,
    nonP6Cap: remaining - dailyTarget,
    p1: inputs.p1.map((entry) => entry.url),
    p2: inputs.p2.map((row) => ({ ...row, ...withHistory(row.url) })),
    p3: inputs.p3.map((url) => ({ url, ...withHistory(url) })),
    p4: inputs.p4.map((url) => ({ url, ...withHistory(url) })),
    p5: inputs.p5.map((url) => ({ url, ...withHistory(url) })),
    p6: {
      pool: planPool(inputs.pool, seed, p6Need),
      seed,
    },
  });
  const plan = fullPlan.slice(0, slots);
  const moreWork = fullPlan.length > slots;

  let inspected = 0;
  let p6Ran = false;
  let p1Ran = false;
  let verdictChanged = false;
  let stopped: InspectionRunResult["stopped"] = null;
  const drained: string[] = [];

  for (const item of plan) {
    if (Date.now() >= options.deadline) {
      stopped = "deadline";
      break;
    }
    const p1Hash = item.reason === "P1" ? p1ByUrl.get(item.url) : undefined;
    if (!inScope(item.url, scope)) {
      // Kapsam dışı kuyruk girdisi bir daha denenmez.
      if (p1Hash) drained.push(p1Hash);
      continue;
    }
    if (!(await reserveInspection(site.id, now))) {
      stopped = "budget";
      break;
    }
    try {
      const result = await options.inspect(accessToken, link.siteUrl, item.url);
      if (
        await storeInspection({
          link,
          url: item.url,
          reason: item.reason,
          result,
          week,
          now,
        })
      ) {
        verdictChanged = true;
      }
      inspected += 1;
      if (item.reason === "P6") p6Ran = true;
      if (p1Hash) {
        p1Ran = true;
        drained.push(p1Hash);
      }
    } catch (error) {
      const pause = await pauseFor(error, inspected);
      if (pause) {
        stopped = pause.stopped;
        break;
      }
      if (inspectionErrorOutcome(error, now).kind === "skip") {
        // Google URL'yi reddetti (VALIDATION): hak iade edilmez, URL atlanır.
        if (p1Hash) drained.push(p1Hash);
        continue;
      }
      // Geçici hata: URL atlanır, tur sürer (kalan plan sonraki turda).
      console.warn(
        `[gsc-inspect] inspection failed for site ${site.id}:`,
        errorText(error),
      );
    }
  }

  if (drained.length > 0) await removeFromInspectQueue(site.id, drained);
  if (p6Ran || (await coverageWeekStale(link.id, week, now))) {
    await refreshCoverageWeek(link, now).catch((error: unknown) => {
      console.error(
        `[gsc-inspect] coverage could not be refreshed for site ${site.id}:`,
        errorText(error),
      );
    });
  }
  if (verdictChanged || p1Ran) await SeoSites.markHealthDue(site.id, now);

  if (stopped === "quota" || stopped === "auth") {
    return { inspected, stopped };
  }
  const spent = remaining - inspected <= 0 || stopped === "budget";
  const nextAt = spent
    ? nextPacificMidnight(now)
    : moreWork || stopped === "deadline"
      ? new Date(now.getTime() + INSPECTION_RUN_GAP_MS)
      : new Date(now.getTime() + IDLE_WAIT_MS);
  await setSchedule(site.id, { inspectNextAt: nextAt });
  return { inspected, stopped };
}

// Haftalık örneğe girecek havuz: tohum sırasıyla ilk `need` URL
// (planInspections aynı tohumla yeniden sıralar; alt küme sırayı korur).
function planPool(pool: readonly string[], seed: string, need: number) {
  return need <= 0 ? [] : sampleOrder(pool, seed).slice(0, need);
}

async function claimSite(siteId: string, now: Date): Promise<boolean> {
  const claimed = await prisma.seoSite.updateMany({
    where: {
      id: siteId,
      isMock: seoMockMode(),
      inspectNextAt: { not: null, lte: now },
      AND: [
        {
          OR: [
            { inspectPausedUntil: null },
            { inspectPausedUntil: { lte: now } },
          ],
        },
        {
          OR: [
            { inspectLastRunAt: null },
            {
              inspectLastRunAt: {
                lte: new Date(now.getTime() - INSPECTION_RUN_GAP_MS),
              },
            },
          ],
        },
      ],
    },
    data: {
      inspectLastRunAt: now,
      inspectNextAt: new Date(now.getTime() + INSPECTION_RUN_GAP_MS),
    },
  });
  return claimed.count === 1;
}

async function runSiteInternal(
  siteId: string,
  options: {
    now?: Date;
    inspect?: InspectFn;
    perRun?: number;
    deadlineMs?: number;
  },
): Promise<{ claimed: boolean; result: InspectionRunResult }> {
  const now = options.now ?? new Date();
  if (!(await claimSite(siteId, now))) {
    return { claimed: false, result: { inspected: 0, stopped: null } };
  }
  const result = await runSiteClaimed(siteId, now, {
    inspect: options.inspect ?? inspectUrl,
    perRun: options.perRun ?? INSPECTIONS_PER_RUN,
    deadline: Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS),
  });
  return { claimed: true, result };
}

export const SeoInspection = {
  async runDue(limit = 5, now: Date = new Date()): Promise<number> {
    if (!SeoFlags.health() || !GscFlags.sync()) return 0;
    const restricted = seoRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;
    const candidates = await prisma.seoSite.findMany({
      where: {
        isMock: seoMockMode(),
        inspectNextAt: { not: null, lte: now },
        OR: [
          { inspectPausedUntil: null },
          { inspectPausedUntil: { lte: now } },
        ],
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { inspectNextAt: "asc" },
      take: CANDIDATES,
      select: { id: true },
    });
    let processed = 0;
    for (const candidate of candidates) {
      if (processed >= limit) break;
      try {
        const run = await runSiteInternal(candidate.id, { now });
        if (run.claimed) processed += 1;
      } catch (error) {
        processed += 1;
        console.error(
          `[gsc-inspect] site ${candidate.id} failed:`,
          errorText(error),
        );
      }
    }
    return processed;
  },

  async runSite(
    siteId: string,
    options: {
      now?: Date;
      inspect?: InspectFn;
      perRun?: number;
      deadlineMs?: number;
    } = {},
  ): Promise<InspectionRunResult> {
    return (await runSiteInternal(siteId, options)).result;
  },

  // "Inspect" (P1): kullanıcı ya da bekçi. Adres GSC mülkünün kapsamında
  // olmalı; kuyruğa atomik eklenir ve inspectNextAt en geç bir tur aralığı
  // sonrasına çekilir. Denetim kaydı eylemdedir.
  async requestInspection(input: {
    projectId: string;
    url: string;
    by: "user" | "watchdog";
    now?: Date;
  }): Promise<
    "queued" | "already_queued" | "out_of_scope" | "no_link" | "full"
  > {
    const now = input.now ?? new Date();
    const link = await primaryGscLink(input.projectId);
    const scope = link ? scopeFromGscSite(link.siteUrl) : null;
    if (!link || !scope) return "no_link";
    const normalized = normalizeCrawlUrl(input.url);
    if (!normalized || !inScope(normalized, scope)) return "out_of_scope";
    const site = await SeoSites.forProject(input.projectId);
    if (!site) return "no_link";
    return appendInspectQueue(
      site.id,
      { url: normalized, urlHash: crawlUrlHash(normalized), by: input.by },
      now,
    );
  },
};
