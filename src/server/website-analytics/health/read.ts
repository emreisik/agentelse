import "server-only";

import { cache } from "react";

import { isValidDomain } from "@/lib/domain";
import { siteAlertHref } from "@/lib/monitoring/site-alert-href";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { addDays, safeTimezone } from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";
import {
  GA_CHECKS,
  gaAlertDedupeKey,
  gaCheckKeyOfDedupeKey,
  gaIssueTitle,
  gaLinkIdOfDedupeKey,
} from "@/lib/website-analytics/health/registry";
import { recheckThrottledUntil } from "@/lib/website-analytics/health/schedule";
import { summarizeMeasurement } from "@/lib/website-analytics/health/score";
import {
  parseSuspectDays,
  suspectDaysIn,
} from "@/lib/website-analytics/health/suspect";
import type {
  GaCheckEvidence,
  GaCheckSeverity,
  GaCheckStatus,
} from "@/lib/website-analytics/health/types";
import type {
  GaMeasurementCounters,
  MeasurementCheckView,
  MeasurementHealthView,
  MeasurementSummary,
  WebsiteJourneyFacts,
} from "@/lib/website-analytics/health/view-types";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { Heartbeat } from "@/server/observability/heartbeat";
import { primaryGaLink } from "@/server/website-analytics/store";

// GA-F3 ölçüm sağlığının okuyucuları (docs/measurement-health.md
// "Arayüz"): Website paneli, Integrations puan satırı, Brand kartı noktası,
// sıradaki adımlar ve /health sayaçları. GA_HEALTH kapalıyken hepsi sorgusuz
// null döner (readGaSuspectDays hariç: GA-F4 okur). Operatör sayaçları
// yalnız sayıdır.

const HEARTBEAT_KEY = "ga.health";
const SUSPECT_VIEW_DAYS = 90;
// Değerlendirmesi bu kadar gecikmiş bağ "vadesi geçmiş" sayılır (6 saat + pay).
const STALE_AFTER_MS = 7 * 3_600_000;
const SCORE_GOOD = 80;
const SCORE_FAIR = 50;

const STATUSES: readonly GaCheckStatus[] = ["PASS", "WARN", "FAIL", "UNKNOWN"];
const SEVERITIES: readonly GaCheckSeverity[] = ["INFO", "WARN", "CRITICAL"];

function statusOf(value: string | undefined): GaCheckStatus | null {
  return STATUSES.find((status) => status === value) ?? null;
}

function severityOf(value: string | undefined): GaCheckSeverity | null {
  return SEVERITIES.find((severity) => severity === value) ?? null;
}

function evidenceValue(value: unknown): GaCheckEvidence[string] | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return undefined;
}

// Saklanan kanıt düz nesnedir; tanınmayan alanlar atılır.
function evidenceOf(json: unknown): GaCheckEvidence {
  const evidence: GaCheckEvidence = { reason: "error" };
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return evidence;
  }
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    const value = evidenceValue(raw);
    if (value !== undefined) evidence[key] = value;
  }
  if (typeof evidence.reason !== "string") evidence.reason = "error";
  return evidence;
}

function reasonOf(evidence: GaCheckEvidence): string | null {
  return typeof evidence.reason === "string" ? evidence.reason : null;
}

export async function loadMeasurementHealth(
  projectId: string,
  now: Date = new Date(),
): Promise<MeasurementHealthView | null> {
  if (!gaHealthEnabled()) return null;
  const link = await primaryGaLink(projectId);
  if (!link) return null;

  const [rows, run, alerts] = await Promise.all([
    prisma.gaHealthCheck.findMany({ where: { linkId: link.id } }),
    prisma.gaHealthRun.findUnique({ where: { linkId: link.id } }),
    SiteAlerts.listOpen(projectId, ["GA4"], 50),
  ]);
  const rowByKey = new Map(rows.map((row) => [row.checkKey, row]));
  const alertByDedupe = new Map(
    alerts.map((alert) => [alert.dedupeKey, alert]),
  );
  const fallbackCheckedAt = (run?.evaluatedAt ?? now).toISOString();

  const checks: MeasurementCheckView[] = GA_CHECKS.map((def) => {
    const row = rowByKey.get(def.key);
    const status = statusOf(row?.status) ?? "UNKNOWN";
    const severity = severityOf(row?.severity) ?? def.defaultSeverity;
    const evidence: GaCheckEvidence = row
      ? evidenceOf(row.evidence)
      : { reason: "not_checked" };
    return {
      key: def.key,
      code: def.code,
      title: gaIssueTitle(def.key, status, reasonOf(evidence)),
      category: def.category,
      status,
      severity,
      evidence,
      guideId: def.guideId,
      alertId:
        alertByDedupe.get(gaAlertDedupeKey(link.id, def.key))?.id ?? null,
      firstFailedAt: row?.firstFailedAt?.toISOString() ?? null,
      lastCheckedAt: row?.lastCheckedAt.toISOString() ?? fallbackCheckedAt,
    };
  });

  const timeZone = safeTimezone(link.timeZone);
  const today = dayKeyInTimezone(now, timeZone);
  return {
    propertyId: link.propertyId,
    summary: summarizeMeasurement({
      score: link.healthScore,
      results: checks,
      evaluatedAt: run?.evaluatedAt ?? null,
    }),
    checks,
    suspectDays: suspectDaysIn(
      parseSuspectDays(run?.suspectDays ?? null),
      addDays(today, -SUSPECT_VIEW_DAYS),
      addDays(today, -1),
    ),
    recheckAvailableAt:
      recheckThrottledUntil(
        run?.recheckRequestedAt ?? null,
        now,
      )?.toISOString() ?? null,
    timeZone,
    siteCheckedAt: run?.siteCheckedAt?.toISOString() ?? null,
  };
}

// Bir bağın özeti: tek GaHealthRun okuması (puan bağdan) + tek kontrol
// okuması; hiç değerlendirilmemişse null.
async function summaryForLink(
  linkId: string,
): Promise<MeasurementSummary | null> {
  const [run, rows] = await Promise.all([
    prisma.gaHealthRun.findUnique({
      where: { linkId },
      select: { evaluatedAt: true, link: { select: { healthScore: true } } },
    }),
    prisma.gaHealthCheck.findMany({
      where: { linkId },
      select: { status: true, severity: true },
    }),
  ]);
  if (!run?.evaluatedAt) return null;
  const results = rows.flatMap((row) => {
    const status = statusOf(row.status);
    const severity = severityOf(row.severity);
    return status && severity ? [{ status, severity }] : [];
  });
  return summarizeMeasurement({
    score: run.link.healthScore,
    results,
    evaluatedAt: run.evaluatedAt,
  });
}

export async function loadMeasurementSummary(
  projectId: string,
): Promise<MeasurementSummary | null> {
  if (!gaHealthEnabled()) return null;
  const link = await primaryGaLink(projectId);
  return link ? summaryForLink(link.id) : null;
}

export async function loadMeasurementSummaryForLink(
  linkId: string,
): Promise<MeasurementSummary | null> {
  if (!gaHealthEnabled()) return null;
  return summaryForLink(linkId);
}

// GA-F4 (anomali ve atıf) için şüpheli günler; bayrağa bağlı değil.
export async function readGaSuspectDays(
  linkId: string,
  from: string,
  to: string,
): Promise<Map<string, string[]>> {
  const run = await prisma.gaHealthRun.findUnique({
    where: { linkId },
    select: { suspectDays: true },
  });
  const days = parseSuspectDays(run?.suspectDays ?? null);
  const result = new Map<string, string[]>();
  for (const day of suspectDaysIn(days, from, to)) {
    result.set(day, days[day] ?? []);
  }
  return result;
}

const MH5_FIX_TITLES: Readonly<Record<string, string>> = {
  no_key_events: "Fix tracking: no key events are set up in Google Analytics.",
  only_purchase: "Fix tracking: only purchases are tracked as key events.",
};

// Sıradaki adımlar: GA bağlı mı, alan adı var mı, düzeltilecek ölçüm
// sorunu (birincil bağın açık CRITICAL uyarısı, yoksa MH5).
export const loadWebsiteJourneyFacts = cache(
  async (projectId: string): Promise<WebsiteJourneyFacts | null> => {
    if (!gaHealthEnabled()) return null;
    const [project, link, credential] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: { domain: true },
      }),
      primaryGaLink(projectId),
      prisma.integrationCredential.findUnique({
        where: {
          projectId_provider: {
            projectId,
            provider: GOOGLE_PROVIDER.analytics,
          },
        },
        select: { status: true },
      }),
    ]);
    const hasDomain = Boolean(project?.domain && isValidDomain(project.domain));
    const connected =
      credential?.status === "ACTIVE" || credential?.status === "EXPIRED";
    const facts: WebsiteJourneyFacts = {
      analytics: connected ? "connected" : "not_connected",
      hasDomain,
      fix: null,
    };
    if (!connected || !link) return facts;

    const alerts = await SiteAlerts.listOpen(projectId, ["GA4"], 10);
    const critical = alerts.find(
      (alert) =>
        alert.severity === "CRITICAL" &&
        gaLinkIdOfDedupeKey(alert.dedupeKey) === link.id,
    );
    if (critical) {
      return {
        ...facts,
        fix: {
          checkKey: gaCheckKeyOfDedupeKey(critical.dedupeKey) ?? "MH24",
          title: critical.title,
          href: siteAlertHref({
            source: "GA4",
            projectId,
            websitePage: GaFlags.websitePage(),
          }),
          critical: true,
        },
      };
    }

    const mh5 = await prisma.gaHealthCheck.findUnique({
      where: { linkId_checkKey: { linkId: link.id, checkKey: "MH5" } },
      select: { status: true, evidence: true },
    });
    const reason = mh5 ? reasonOf(evidenceOf(mh5.evidence)) : null;
    const title = reason ? MH5_FIX_TITLES[reason] : undefined;
    if (mh5?.status !== "WARN" || !title) return facts;
    return {
      ...facts,
      fix: {
        checkKey: "MH5",
        title,
        href: siteAlertHref({
          source: "GA4",
          projectId,
          websitePage: GaFlags.websitePage(),
        }),
        critical: false,
      },
    };
  },
);

function minutesSince(at: Date | null, now: Date): number | null {
  return at
    ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000))
    : null;
}

// /health "Google Analytics measurement checks": yalnız sayılar.
export async function loadGaMeasurementCounters(
  now: Date = new Date(),
): Promise<GaMeasurementCounters | null> {
  if (!gaHealthEnabled()) return null;

  const [links, checkGroups, alertGroups, heartbeat] = await Promise.all([
    prisma.gaPropertyLink.findMany({
      where: { isPrimary: true },
      select: {
        lastMetadataAt: true,
        healthScore: true,
        healthRun: { select: { evaluatedAt: true } },
      },
    }),
    prisma.gaHealthCheck.groupBy({
      by: ["status"],
      where: { link: { isPrimary: true } },
      _count: { _all: true },
    }),
    prisma.adsAlert.groupBy({
      by: ["severity"],
      where: { source: "GA4", status: { in: ["OPEN", "ACKED"] } },
      _count: { _all: true },
    }),
    Heartbeat.read(HEARTBEAT_KEY),
  ]);

  const staleBefore = now.getTime() - STALE_AFTER_MS;
  const scoreBuckets = { good: 0, fair: 0, poor: 0, none: 0 };
  let linksChecked = 0;
  let linksDue = 0;
  for (const link of links) {
    const evaluatedAt = link.healthRun?.evaluatedAt ?? null;
    if (evaluatedAt) linksChecked += 1;
    if (
      link.lastMetadataAt &&
      (!evaluatedAt || evaluatedAt.getTime() < staleBefore)
    ) {
      linksDue += 1;
    }
    const score = link.healthScore;
    if (score === null) scoreBuckets.none += 1;
    else if (score >= SCORE_GOOD) scoreBuckets.good += 1;
    else if (score >= SCORE_FAIR) scoreBuckets.fair += 1;
    else scoreBuckets.poor += 1;
  }
  const checkCount = (status: string) =>
    checkGroups.find((row) => row.status === status)?._count._all ?? 0;
  const alertCount = (severity: string) =>
    alertGroups.find((row) => row.severity === severity)?._count._all ?? 0;

  return {
    linksChecked,
    linksDue,
    checksFailing: checkCount("FAIL"),
    checksWarning: checkCount("WARN"),
    checksUnknown: checkCount("UNKNOWN"),
    alertsCritical: alertCount("CRITICAL"),
    alertsWarn: alertCount("WARN"),
    scoreBuckets,
    lastRunMinutesAgo: minutesSince(heartbeat?.lastOkAt ?? null, now),
  };
}
