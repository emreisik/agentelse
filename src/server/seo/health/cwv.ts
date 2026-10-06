import "server-only";

import { Prisma, type SeoCwv } from "@prisma/client";

import {
  CRUX_REQUESTS_PER_MINUTE,
  CWV_EVERY_MS,
  KEY_PAGE_COUNT,
} from "@/lib/seo/audit-constants";
import {
  cwvOverall,
  type CwvMetricKey,
  type CwvRating,
  type CwvRecord,
} from "@/lib/seo/cwv";
import { dateToDayKey, dayKeyToDate } from "@/lib/seo/dates";
import { createMinuteLimiter } from "@/lib/seo/governor";
import {
  cwvEnabled,
  seoGlobalWorkAllowedHere,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "@/lib/seo/health-flags";
import { prisma } from "@/lib/prisma";
import {
  CruxBlockedError,
  queryCruxHistory,
  queryCruxRecord,
} from "@/server/integrations/crux/crux-api";
import { Heartbeat } from "@/server/observability/heartbeat";
import { keyPagesFor } from "@/server/seo/site/key-pages";
import { SeoSites } from "@/server/seo/site/sites";

// Haftalık Core Web Vitals (docs/search-health.md "Core Web Vitals", SK7 (a)):
// `seo-cwv` tick adımı. Site başına origin'in PHONE + DESKTOP kaydı ve
// geçmişi (History API), ayrıca kilit sayfaların URL kayıtları (en çok 20).
// Değerler CrUX'un döndürdüğü gibi SeoCwv'ye yazılır; 404 = veri yok.
// cwvCheckedAt veri olmasa da yazılır (bir hafta sonra yeniden denenir).
// GOOGLE_API_KEY yoksa adım uyur (mock kipi anahtarsız çalışır). CrUX
// herkese açık veridir; uyarıları kaynak 'SEO'dur.

const HEARTBEAT_KEY = "seo.cwv";
const FORM_FACTORS = ["PHONE", "DESKTOP"] as const;

// Süreç içi dakika sınırı (bütün siteler ortak).
const cruxLimiter = createMinuteLimiter(CRUX_REQUESTS_PER_MINUTE);

class CruxLimitReached extends Error {
  constructor() {
    super("Chrome UX Report per-minute limit reached");
    this.name = "CruxLimitReached";
  }
}

function takeSlot(): void {
  if (!cruxLimiter.take("crux", Date.now()).ok) throw new CruxLimitReached();
}

export type CwvView = {
  formFactor: "PHONE" | "DESKTOP";
  p75: Record<CwvMetricKey, number | null>;
  overall: CwvRating | null;
  collectionPeriod: string;
};

export type CwvSummary = {
  origin: string;
  checkedAt: Date | null;
  phone: CwvView | null;
  desktop: CwvView | null;
  history: { phone: CwvRecord[]; desktop: CwvRecord[] };
  urls: { url: string; phone: CwvView | null; desktop: CwvView | null }[];
};

type RecordFn = typeof queryCruxRecord;
type HistoryFn = typeof queryCruxHistory;

function cwvRow(
  site: { id: string; projectId: string },
  scope: "ORIGIN" | "URL",
  target: string,
  record: CwvRecord,
  now: Date,
) {
  return {
    siteId: site.id,
    projectId: site.projectId,
    isMock: seoMockMode(),
    scope,
    target,
    formFactor: record.formFactor,
    collectionPeriod: record.collectionPeriod,
    periodEnd: dayKeyToDate(record.periodEnd),
    lcpP75: record.p75.lcp,
    inpP75: record.p75.inp,
    clsP75: record.p75.cls,
    fcpP75: record.p75.fcp,
    ttfbP75: record.p75.ttfb,
    histogram:
      Object.keys(record.histogram).length > 0
        ? (record.histogram as Prisma.InputJsonValue)
        : Prisma.DbNull,
    fetchedAt: now,
  };
}

// Kayıt (RECORD) satırı kaynağını RECORD yapar; geçmiş (HISTORY) satırı
// aynı dönemdeki RECORD satırının kaynağını değiştirmez (benzersiz anahtar
// kaynağı içermez).
async function upsertCwv(
  data: ReturnType<typeof cwvRow>,
  source: "RECORD" | "HISTORY",
): Promise<void> {
  const where = {
    siteId_scope_target_formFactor_collectionPeriod: {
      siteId: data.siteId,
      scope: data.scope,
      target: data.target,
      formFactor: data.formFactor,
      collectionPeriod: data.collectionPeriod,
    },
  };
  await prisma.seoCwv.upsert({
    where,
    create: { ...data, source },
    update: source === "RECORD" ? { ...data, source } : data,
  });
}

async function collectSite(
  siteId: string,
  now: Date,
  deps: { record: RecordFn; history: HistoryFn },
): Promise<number> {
  const site = await prisma.seoSite.findUnique({ where: { id: siteId } });
  if (!site || !site.origin || site.isMock !== seoMockMode()) return 0;
  if (!seoWorkAllowedFor(site.projectId)) return 0;
  const origin = site.origin;
  let written = 0;

  for (const formFactor of FORM_FACTORS) {
    takeSlot();
    const history = await deps.history({ origin }, formFactor);
    for (const entry of history) {
      await upsertCwv(cwvRow(site, "ORIGIN", origin, entry, now), "HISTORY");
      written += 1;
    }
    takeSlot();
    const record = await deps.record({ origin }, formFactor);
    if (record) {
      await upsertCwv(cwvRow(site, "ORIGIN", origin, record, now), "RECORD");
      written += 1;
    }
  }

  const keyPages = (await keyPagesFor(site, now)).slice(0, KEY_PAGE_COUNT);
  for (const page of keyPages) {
    for (const formFactor of FORM_FACTORS) {
      takeSlot();
      const record = await deps.record({ url: page.url }, formFactor);
      if (!record) continue;
      await upsertCwv(cwvRow(site, "URL", page.url, record, now), "RECORD");
      written += 1;
    }
  }

  await prisma.seoSite.updateMany({
    where: { id: site.id },
    data: { cwvCheckedAt: now },
  });
  await SeoSites.markHealthDue(site.id, now);
  return written;
}

async function blocked(now: Date): Promise<void> {
  if (seoGlobalWorkAllowedHere())
    await Heartbeat.ok(HEARTBEAT_KEY, now, "blocked");
}

export const SeoCwvJob = {
  async runDue(limit = 3, now: Date = new Date()): Promise<number> {
    if (!cwvEnabled()) return 0;
    const restricted = seoRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;
    const global = seoGlobalWorkAllowedHere();
    if (global) await Heartbeat.beat(HEARTBEAT_KEY, now);
    const sites = await prisma.seoSite.findMany({
      where: {
        isMock: seoMockMode(),
        origin: { not: null },
        OR: [
          { cwvCheckedAt: null },
          { cwvCheckedAt: { lte: new Date(now.getTime() - CWV_EVERY_MS) } },
        ],
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { cwvCheckedAt: { sort: "asc", nulls: "first" } },
      take: limit,
      select: { id: true, projectId: true },
    });
    let processed = 0;
    for (const site of sites) {
      if (!seoWorkAllowedFor(site.projectId)) continue;
      try {
        await collectSite(site.id, now, {
          record: queryCruxRecord,
          history: queryCruxHistory,
        });
        processed += 1;
      } catch (error) {
        if (error instanceof CruxBlockedError) {
          await blocked(now);
          return processed;
        }
        // Dakika sınırı doldu: tur biter, site sonraki tick'te yeniden denenir.
        if (error instanceof CruxLimitReached) return processed;
        console.error(
          `[seo-cwv] site ${site.id} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  async runSite(
    siteId: string,
    options: { now?: Date; record?: RecordFn; history?: HistoryFn } = {},
  ): Promise<number> {
    const now = options.now ?? new Date();
    try {
      return await collectSite(siteId, now, {
        record: options.record ?? queryCruxRecord,
        history: options.history ?? queryCruxHistory,
      });
    } catch (error) {
      if (error instanceof CruxBlockedError) {
        await blocked(now);
        return 0;
      }
      if (error instanceof CruxLimitReached) return 0;
      throw error;
    }
  },
};

function toRecord(row: SeoCwv): CwvRecord {
  const histogram =
    row.histogram && typeof row.histogram === "object"
      ? (row.histogram as CwvRecord["histogram"])
      : {};
  return {
    formFactor: row.formFactor === "DESKTOP" ? "DESKTOP" : "PHONE",
    collectionPeriod: row.collectionPeriod,
    periodEnd: dateToDayKey(row.periodEnd),
    p75: {
      lcp: row.lcpP75,
      inp: row.inpP75,
      cls: row.clsP75,
      fcp: row.fcpP75,
      ttfb: row.ttfbP75,
    },
    histogram,
  };
}

function toView(row: SeoCwv | undefined): CwvView | null {
  if (!row) return null;
  const record = toRecord(row);
  return {
    formFactor: record.formFactor,
    p75: record.p75,
    overall: cwvOverall(record.p75),
    collectionPeriod: record.collectionPeriod,
  };
}

// Satırlar periodEnd'e göre artan sıradadır: sonuncusu en yenisi.
function latestRecord(
  rows: readonly SeoCwv[],
  formFactor: "PHONE" | "DESKTOP",
): SeoCwv | undefined {
  return rows
    .filter((row) => row.source === "RECORD" && row.formFactor === formFactor)
    .at(-1);
}

export async function readLatestCwv(
  projectId: string,
): Promise<CwvSummary | null> {
  if (!cwvEnabled()) return null;
  const site = await prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
    select: { id: true, origin: true, cwvCheckedAt: true },
  });
  if (!site) return null;
  const rows = await prisma.seoCwv.findMany({
    where: { siteId: site.id },
    orderBy: [{ periodEnd: "asc" }, { fetchedAt: "asc" }],
  });
  if (rows.length === 0) return null;
  const originRows = rows.filter((row) => row.scope === "ORIGIN");
  // Geçmiş: origin'in bütün dönemleri (son dönem RECORD kaynağıyla yazılmış
  // olabilir; aynı dönem bir kez bulunur).
  const historyOf = (formFactor: "PHONE" | "DESKTOP") =>
    originRows.filter((row) => row.formFactor === formFactor).map(toRecord);

  const urlRows = new Map<string, SeoCwv[]>();
  for (const row of rows) {
    if (row.scope !== "URL") continue;
    urlRows.set(row.target, [...(urlRows.get(row.target) ?? []), row]);
  }
  const urls = [...urlRows.entries()]
    .slice(0, KEY_PAGE_COUNT + 1)
    .map(([url, list]) => ({
      url,
      phone: toView(latestRecord(list, "PHONE")),
      desktop: toView(latestRecord(list, "DESKTOP")),
    }));

  return {
    origin: site.origin ?? originRows[0]?.target ?? "",
    checkedAt: site.cwvCheckedAt,
    phone: toView(latestRecord(originRows, "PHONE")),
    desktop: toView(latestRecord(originRows, "DESKTOP")),
    history: { phone: historyOf("PHONE"), desktop: historyOf("DESKTOP") },
    urls,
  };
}
