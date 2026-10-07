import "server-only";

import type {
  GaHealthCheck,
  GaHealthRun,
  GaPropertyLink,
  Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { gaDisabledReports } from "@/lib/website-analytics/catalog-state";
import {
  addDays,
  hourInTimezone,
  safeTimezone,
} from "@/lib/website-analytics/days";
import type {
  GaLane,
  GaServerErrors,
  StoredGaQuota,
} from "@/lib/website-analytics/governor";
import { sameWeekdayMedian } from "@/lib/website-analytics/health/baseline";
import {
  evaluateGaChecks,
  evaluateGaRealtimeCheck,
} from "@/lib/website-analytics/health/evaluate";
import { piiProbeRange } from "@/lib/website-analytics/health/pii-probe";
import {
  nextRealtimeState,
  realtimeProbeDue,
} from "@/lib/website-analytics/health/realtime-state";
import {
  GA_ALERT_KINDS,
  gaAlertable,
  gaAlertDedupeKey,
  gaCheckDef,
  gaIssueTitle,
  isGaCheckKey,
  unknownKeepsAlertOpen,
} from "@/lib/website-analytics/health/registry";
import {
  GA_PII_PROBE_EVERY_MS,
  GA_SITE_SCAN_EVERY_MS,
  completeThroughOf,
  gaHealthFingerprint,
  weeklyProbeDue,
} from "@/lib/website-analytics/health/schedule";
import { measurementScore } from "@/lib/website-analytics/health/score";
import { siteTagTargets } from "@/lib/website-analytics/health/site-targets";
import { parseGaRealtimeState } from "@/lib/website-analytics/health/stored";
import {
  mergeSuspectDays,
  parseSuspectDays,
} from "@/lib/website-analytics/health/suspect";
import { mockSiteTagResult } from "@/lib/website-analytics/health/tag-scan";
import {
  GA_CHECK_KEYS,
  type GaCheckKey,
  type GaCheckResult,
  type GaCheckSeverity,
  type GaCheckStatus,
  type GaPiiProbeResult,
  type GaRealtimeState,
  type GaSiteTagResult,
} from "@/lib/website-analytics/health/types";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { gaAgencyEnabled } from "@/lib/website-analytics/agency/flags";
import { gaEngineLinkWhere } from "@/lib/website-analytics/agency/scope";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { readDailyTotals } from "@/server/website-analytics/store";
import type { GaSyncContext } from "@/server/website-analytics/sync/context";
import { GaQuotaDeferred } from "@/server/website-analytics/sync/requests";

import { healthDaysOf, loadGaHealthInputs } from "./inputs";
import { runPiiProbe, runRealtimeProbe } from "./probes";
import { scanSiteTags } from "./site-tag";

// GA-F3 bağ değerlendirmesi (docs/measurement-health.md "Çalışma"): girdiler
// ambardan okunur, vadesi gelen yoklamalar (haftalık PII, gün içi realtime,
// haftalık site taraması) koşar, saf kontroller değerlendirilir; sonuçlar
// GaHealthCheck'e, puan GaPropertyLink.healthScore'a, şüpheli günler ve
// yoklama durumları GaHealthRun'a yazılır; uyarılar SiteAlerts'e gider.
// Çağıran (runner.ts) GaHealthRun kilidini almıştır; burada tek güncellemeyle
// bırakılır. Loglarda Google sayıları, yollar ve başlıklar yok.

export type GaHealthEvaluation = {
  score: number | null;
  results: GaCheckResult[];
  siteScanned: boolean;
};

type ProbeCredential = { id: string; status: string; encryptedSecret: string };

// Kullanıcının düzeltmesi gereken bağ durumları: yoklama denenmez.
const NO_ACCESS_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

const STATUSES: readonly GaCheckStatus[] = ["PASS", "WARN", "FAIL", "UNKNOWN"];
const SEVERITIES: readonly GaCheckSeverity[] = ["INFO", "WARN", "CRITICAL"];

function isStatus(value: string): value is GaCheckStatus {
  return (STATUSES as readonly string[]).includes(value);
}

function isSeverity(value: string): value is GaCheckSeverity {
  return (SEVERITIES as readonly string[]).includes(value);
}

// Bağ tarafı (sorgusuz): sağlıklı bağ + kota bloğu yok. Kimliği etkin
// olmayan bağı GaSync zaten AUTH'a çeker.
export function gaLinkReachable(
  link: Pick<GaPropertyLink, "health" | "rateLimitedUntil">,
  now: Date,
): boolean {
  if (NO_ACCESS_HEALTH.has(link.health)) return false;
  return !(link.rateLimitedUntil && link.rateLimitedUntil > now);
}

// Google'a yoklama yapılabilir mi: etkin kimlik + ulaşılabilir bağ.
export function gaProbeAccess(
  link: Pick<GaPropertyLink, "health" | "rateLimitedUntil">,
  credential: { status: string; encryptedSecret: string } | null,
  now: Date,
): boolean {
  if (!credential || credential.status !== "ACTIVE") return false;
  if (!credential.encryptedSecret) return false;
  return gaLinkReachable(link, now);
}

type ProbeAccess = {
  // Kimlik ilk soruda okunur (yoklama vadesi yoksa hiç okunmaz).
  allowed: () => Promise<boolean>;
  // Erişim token'ı tembel ve tur başına bir kez.
  token: () => Promise<string>;
};

function probeAccess(link: GaPropertyLink, now: Date): ProbeAccess {
  let credential: ProbeCredential | null | undefined;
  let pending: Promise<string> | null = null;
  return {
    async allowed() {
      if (credential === undefined) {
        credential = await prisma.integrationCredential.findUnique({
          where: { id: link.credentialId },
          select: { id: true, status: true, encryptedSecret: true },
        });
      }
      return gaProbeAccess(link, credential, now);
    },
    token() {
      if (!credential) {
        return Promise.reject(new Error("Google Analytics is not connected"));
      }
      pending ??= gaMockMode()
        ? Promise.resolve("mock-access-token")
        : getFreshGoogleAccessToken(credential);
      return pending;
    },
  };
}

// GaSync.syncLink ile aynı bağlam; kota/sunucu hatası/blok durumu
// runGaRequests içinde mülkün bütün bağlarına yazılır.
function syncContext(
  link: GaPropertyLink,
  accessToken: string,
  now: Date,
  lane: GaLane,
): GaSyncContext {
  const timeZone = safeTimezone(link.timeZone);
  return {
    link,
    accessToken,
    timeZone,
    today: dayKeyInTimezone(now, timeZone),
    now,
    lane,
    disabled: gaDisabledReports(link.catalog),
    quota: (link.lastQuota ?? null) as StoredGaQuota | null,
    serverErrors: (link.serverErrorsHour ?? null) as GaServerErrors | null,
    rateLimitedUntil: link.rateLimitedUntil,
  };
}

// Hata etiketi yalnız sınıf adı (mesajda Google verisi olabilir).
function probeError(probe: string, link: GaPropertyLink, error: unknown) {
  const klass = error instanceof GoogleApiError ? error.errorClass : "UNKNOWN";
  console.warn(
    `[ga-health] ${probe} probe failed for property ${link.propertyId}: ${klass}`,
  );
  return `${probe}: ${klass}`;
}

// Yoklama yapılmayan turda yalnız beklenen gün içi hacim tazelenir; gün
// değiştiyse durum bugünden yeniden başlar.
function withExpected(
  state: GaRealtimeState | null,
  today: string,
  expected: number | null,
): GaRealtimeState {
  if (state && state.day === today) return { ...state, expected };
  return {
    v: 1,
    day: today,
    zeros: 0,
    checks: 0,
    lastAt: null,
    lastActive: null,
    expected,
  };
}

async function realtimeStep(
  link: GaPropertyLink,
  state: GaRealtimeState | null,
  input: {
    today: string;
    hour: number;
    now: Date;
    expected: number | null;
    force: boolean;
    access: ProbeAccess;
  },
): Promise<{ state: GaRealtimeState; error: string | null }> {
  const due = realtimeProbeDue(state, {
    today: input.today,
    hour: input.hour,
    now: input.now,
    expectedDailySessions: input.expected,
    force: input.force,
  });
  if (!due || !(await input.access.allowed())) {
    return {
      state: withExpected(state, input.today, input.expected),
      error: null,
    };
  }
  try {
    const activeUsers = await runRealtimeProbe(
      await input.access.token(),
      link.propertyId,
    );
    return {
      state: nextRealtimeState(state, {
        today: input.today,
        now: input.now,
        activeUsers,
        expected: input.expected,
      }),
      error: null,
    };
  } catch (error) {
    // Hata: önceki durum korunur.
    return {
      state: state ?? withExpected(null, input.today, input.expected),
      error: probeError("realtime", link, error),
    };
  }
}

type PreviousRow = Pick<
  GaHealthCheck,
  "status" | "severity" | "firstFailedAt" | "lastChangedAt"
>;

// Saf: satırın firstFailedAt / lastChangedAt geçişi. WARN/FAIL'e girişte
// firstFailedAt şimdi, sürdükçe korunur, PASS'te null, UNKNOWN'da değişmez.
// lastChangedAt yeni satırda ya da durum/önem değişince şimdi.
export function checkRowTransition(
  previous: PreviousRow | null,
  result: Pick<GaCheckResult, "status" | "severity">,
  now: Date,
): { firstFailedAt: Date | null; lastChangedAt: Date } {
  const failing = result.status === "WARN" || result.status === "FAIL";
  const wasFailing = previous?.status === "WARN" || previous?.status === "FAIL";
  let firstFailedAt: Date | null;
  if (result.status === "PASS") firstFailedAt = null;
  else if (result.status === "UNKNOWN")
    firstFailedAt = previous?.firstFailedAt ?? null;
  else if (failing && wasFailing)
    firstFailedAt = previous?.firstFailedAt ?? now;
  else firstFailedAt = now;
  const changed =
    !previous ||
    previous.status !== result.status ||
    previous.severity !== result.severity;
  return {
    firstFailedAt,
    lastChangedAt: changed ? now : previous.lastChangedAt,
  };
}

async function writeCheckRow(
  tx: Prisma.TransactionClient,
  link: GaPropertyLink,
  result: GaCheckResult,
  previous: PreviousRow | null,
  now: Date,
): Promise<void> {
  const def = gaCheckDef(result.key);
  const transition = checkRowTransition(previous, result, now);
  const fields = {
    status: result.status,
    severity: result.severity,
    evidence: result.evidence as Prisma.InputJsonValue,
    guideId: def.guideId,
    lastCheckedAt: now,
    firstFailedAt: transition.firstFailedAt,
    lastChangedAt: transition.lastChangedAt,
  };
  await tx.gaHealthCheck.upsert({
    where: { linkId_checkKey: { linkId: link.id, checkKey: result.key } },
    create: {
      linkId: link.id,
      projectId: link.projectId,
      checkKey: result.key,
      ...fields,
    },
    update: fields,
  });
}

function reasonOf(result: GaCheckResult): string | null {
  const reason = result.evidence.reason;
  return typeof reason === "string" ? reason : null;
}

async function raiseAlert(
  link: GaPropertyLink,
  result: GaCheckResult,
  now: Date,
): Promise<void> {
  const def = gaCheckDef(result.key);
  try {
    await SiteAlerts.raise(
      {
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        source: "GA4",
        kind: def.alertKind,
        severity: result.severity,
        dedupeKey: gaAlertDedupeKey(link.id, result.key),
        title: gaIssueTitle(result.key, result.status, reasonOf(result)),
        detail: null,
        data: { checkKey: result.key, linkId: link.id },
      },
      now,
    );
  } catch (error) {
    // Uyarı yazılamadı: açık kalır sayılır (yanlışlıkla çözülmesin).
    console.error(
      `[ga-health] alert ${def.alertKind} could not be raised:`,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

// GA-F8: bir mülkün değerlendirmesi projenin ÖBÜR motor bağlarının açık
// uyarısını çözmesin. Emekli/kaldırılmış bağların uyarıları (artık motor bağı
// değil) çözülmeye devam eder; bu yüzden "kendi öneki" değil "diğer motor
// bağlarının önekleri" dışlanır. GA_AGENCY kapalıyken sorgu yok, liste boş.
async function otherEngineAlertPrefixes(
  link: GaPropertyLink,
): Promise<string[]> {
  if (!gaAgencyEnabled()) return [];
  const others = await prisma.gaPropertyLink.findMany({
    where: {
      projectId: link.projectId,
      id: { not: link.id },
      ...gaEngineLinkWhere(),
    },
    select: { id: true },
  });
  return others.map((other) => `ga4:${other.id}:`);
}

// Uyarılar: WARN/CRITICAL önemli WARN/FAIL açılır; UNKNOWN en çok 48 saat
// açık tutar (MH1_RT hiç). Ardından proje genelinde resolveMissing: önceki
// birincil bağın uyarıları da burada çözülür.
export async function syncAlerts(
  link: GaPropertyLink,
  results: readonly GaCheckResult[],
  previous: ReadonlyMap<string, PreviousRow>,
  now: Date,
): Promise<void> {
  const stillOpen = new Set<string>();
  for (const result of results) {
    const dedupeKey = gaAlertDedupeKey(link.id, result.key);
    if (gaAlertable(result)) {
      await raiseAlert(link, result, now);
      stillOpen.add(dedupeKey);
      continue;
    }
    const row = previous.get(result.key) ?? null;
    if (
      result.status === "UNKNOWN" &&
      unknownKeepsAlertOpen(
        result.key,
        row ? { status: row.status, lastChangedAt: row.lastChangedAt } : null,
        now,
      )
    ) {
      stillOpen.add(dedupeKey);
    }
  }
  const prefixes = await otherEngineAlertPrefixes(link);
  await SiteAlerts.resolveMissing(
    {
      projectId: link.projectId,
      source: "GA4",
      kinds: [...GA_ALERT_KINDS],
      stillOpen,
      ...(prefixes.length > 0 ? { excludeDedupePrefixes: prefixes } : {}),
    },
    now,
  );
}

function leaseWhere(run: GaHealthRun): Prisma.GaHealthRunWhereInput {
  return run.leaseOwner
    ? { id: run.id, leaseOwner: run.leaseOwner }
    : { id: run.id };
}

export async function evaluateGaLink(
  link: GaPropertyLink,
  run: GaHealthRun,
  options: { now: Date; force: boolean; allowSite: boolean },
): Promise<GaHealthEvaluation> {
  const { now, force } = options;
  const inputs = await loadGaHealthInputs(link, run, now);
  const errors: string[] = [];

  const access = probeAccess(link, now);

  // a) Haftalık PII yoklaması ("I fixed it": bugünün aralığı, P1).
  let piiProbe: GaPiiProbeResult | null = inputs.piiProbe;
  let piiCheckedAt: Date | null = null;
  if (
    weeklyProbeDue(run.piiCheckedAt, now, GA_PII_PROBE_EVERY_MS, force) &&
    (await access.allowed())
  ) {
    try {
      const range = piiProbeRange({
        today: inputs.today,
        force,
        previous: inputs.piiProbe,
      });
      const ctx = syncContext(
        link,
        await access.token(),
        now,
        force ? "P1" : "P2",
      );
      piiProbe = await runPiiProbe(ctx, { ...range, forced: force });
      piiCheckedAt = now;
    } catch (error) {
      // Kota payı yetmedi: bir sonraki tura kalır (hata sayılmaz).
      if (!(error instanceof GaQuotaDeferred)) {
        errors.push(probeError("pii", link, error));
      }
    }
  }

  // b) Gün içi realtime (MH1_RT).
  const suspect = new Set(inputs.suspectDays);
  const expected = sameWeekdayMedian(inputs.days, inputs.today, suspect).median;
  const realtime = await realtimeStep(link, inputs.realtime, {
    today: inputs.today,
    hour: inputs.propertyHour,
    now,
    expected,
    force,
    access,
  });
  if (realtime.error) errors.push(realtime.error);

  // c) Haftalık site taraması (yalnız Project.domain; mock modda ağ yok).
  let siteTag: GaSiteTagResult | null = inputs.siteTag;
  let siteCheckedAt: Date | null = null;
  let siteScanned = false;
  if (
    options.allowSite &&
    weeklyProbeDue(run.siteCheckedAt, now, GA_SITE_SCAN_EVERY_MS, force)
  ) {
    try {
      const at = now.toISOString();
      const expectedId = link.measurementId;
      const targets = siteTagTargets({
        projectDomain: inputs.project.domain,
        streamUri: link.streamUri,
        landingPaths: inputs.window28.landing
          .map((row) => row.key[0] ?? "")
          .filter(Boolean),
      });
      if (!targets) {
        siteTag = mockSiteTagResult({ at, host: null, expectedId });
      } else if (gaMockMode()) {
        siteTag = mockSiteTagResult({ at, host: targets.host, expectedId });
      } else {
        siteTag = await scanSiteTags({
          host: targets.host,
          paths: targets.paths,
          expectedId,
          now,
        });
        // Tick başına en çok bir gerçek tarama (runner).
        siteScanned = true;
      }
      siteCheckedAt = now;
    } catch (error) {
      errors.push(probeError("site", link, error));
    }
  }

  const results = evaluateGaChecks({
    ...inputs,
    siteTag,
    piiProbe,
    realtime: realtime.state,
  });
  const score = measurementScore(results);

  const previous = await prisma.$transaction(
    async (tx) => {
      const rows = await tx.gaHealthCheck.findMany({
        where: { linkId: link.id },
        select: {
          checkKey: true,
          status: true,
          severity: true,
          firstFailedAt: true,
          lastChangedAt: true,
        },
      });
      const byKey = new Map(rows.map((row) => [row.checkKey, row]));
      for (const result of results) {
        await writeCheckRow(
          tx,
          link,
          result,
          byKey.get(result.key) ?? null,
          now,
        );
      }
      await tx.gaHealthCheck.deleteMany({
        where: { linkId: link.id, checkKey: { notIn: [...GA_CHECK_KEYS] } },
      });
      await tx.gaPropertyLink.updateMany({
        where: { id: link.id },
        data: { healthScore: score },
      });
      return byKey;
    },
    { timeout: 30_000 },
  );

  await syncAlerts(link, results, previous, now);

  await prisma.gaHealthRun.updateMany({
    where: leaseWhere(run),
    data: {
      fingerprint: gaHealthFingerprint({
        today: inputs.today,
        lastDailyDate: link.lastDailyDate,
        lastMetadataAt: link.lastMetadataAt,
      }),
      evaluatedAt: now,
      leaseUntil: null,
      leaseOwner: null,
      ...(siteCheckedAt
        ? {
            siteCheckedAt,
            siteTag: siteTag as unknown as Prisma.InputJsonValue,
          }
        : {}),
      ...(piiCheckedAt
        ? {
            piiCheckedAt,
            piiProbe: piiProbe as unknown as Prisma.InputJsonValue,
          }
        : {}),
      realtime: realtime.state as unknown as Prisma.InputJsonValue,
      suspectDays: mergeSuspectDays(
        parseSuspectDays(run.suspectDays),
        results,
        {
          today: inputs.today,
        },
      ) as Prisma.InputJsonValue,
      lastError: errors.length > 0 ? errors.join("; ").slice(0, 300) : null,
    },
  });

  return { score, results, siteScanned };
}

// Saklanan satırlardan puan; tam değerlendirme hiç yapılmadıysa null
// (güncellenmez).
function scoreFromRows(
  rows: { checkKey: string; status: string; severity: string }[],
): { score: number | null } | null {
  const results: Pick<GaCheckResult, "key" | "status" | "severity">[] = [];
  for (const row of rows) {
    if (!isGaCheckKey(row.checkKey)) continue;
    if (!isStatus(row.status) || !isSeverity(row.severity)) continue;
    results.push({
      key: row.checkKey,
      status: row.status,
      severity: row.severity,
    });
  }
  if (results.length < GA_CHECK_KEYS.length) return null;
  return { score: measurementScore(results) };
}

// Saatlik yalnız-realtime yolu: yalnız GaHealthRun.realtime, MH1_RT satırı,
// puan ve GA_MH1_RT uyarısı. evaluatedAt ve parmak izi değişmez.
export async function evaluateGaRealtime(
  link: GaPropertyLink,
  run: GaHealthRun,
  now: Date,
): Promise<void> {
  const timeZone = safeTimezone(link.timeZone);
  const today = dayKeyInTimezone(now, timeZone);
  const yesterday = addDays(today, -1);
  const totals = await readDailyTotals(link.id, addDays(today, -70), yesterday);
  const days = healthDaysOf(
    totals,
    completeThroughOf(link.lastDailyDate),
    yesterday,
  );
  const suspect = new Set(Object.keys(parseSuspectDays(run.suspectDays)));
  const expected = sameWeekdayMedian(days, today, suspect).median;

  const realtime = await realtimeStep(
    link,
    parseGaRealtimeState(run.realtime),
    {
      today,
      hour: hourInTimezone(now, timeZone),
      now,
      expected,
      force: false,
      access: probeAccess(link, now),
    },
  );

  const key: GaCheckKey = "MH1_RT";
  const result = evaluateGaRealtimeCheck({ today, realtime: realtime.state });
  await prisma.$transaction(async (tx) => {
    const row = await tx.gaHealthCheck.findUnique({
      where: { linkId_checkKey: { linkId: link.id, checkKey: key } },
      select: {
        status: true,
        severity: true,
        firstFailedAt: true,
        lastChangedAt: true,
      },
    });
    await writeCheckRow(tx, link, result, row, now);
    const rows = await tx.gaHealthCheck.findMany({
      where: { linkId: link.id },
      select: { checkKey: true, status: true, severity: true },
    });
    const scored = scoreFromRows(rows);
    if (scored) {
      await tx.gaPropertyLink.updateMany({
        where: { id: link.id },
        data: { healthScore: scored.score },
      });
    }
  });

  const dedupeKey = gaAlertDedupeKey(link.id, key);
  const alertable = gaAlertable(result);
  if (alertable) await raiseAlert(link, result, now);
  const prefixes = await otherEngineAlertPrefixes(link);
  await SiteAlerts.resolveMissing(
    {
      projectId: link.projectId,
      source: "GA4",
      kinds: [gaCheckDef(key).alertKind],
      stillOpen: alertable ? new Set([dedupeKey]) : new Set<string>(),
      ...(prefixes.length > 0 ? { excludeDedupePrefixes: prefixes } : {}),
    },
    now,
  );

  await prisma.gaHealthRun.updateMany({
    where: leaseWhere(run),
    data: {
      realtime: realtime.state as unknown as Prisma.InputJsonValue,
      leaseUntil: null,
      leaseOwner: null,
      ...(realtime.error ? { lastError: realtime.error } : {}),
    },
  });
}
