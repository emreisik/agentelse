import "server-only";

import { prisma } from "@/lib/prisma";
import { gaAgencyEnabled } from "@/lib/website-analytics/agency/flags";
import {
  overviewMetrics,
  sortOverviewRows,
  type WebsitesOverviewRow,
} from "@/lib/website-analytics/agency/overview";
import { gaEngineLinkWhere } from "@/lib/website-analytics/agency/scope";
import { addDays, dateToDayKey } from "@/lib/website-analytics/days";
import { gaLinkIdOfDedupeKey } from "@/lib/website-analytics/health/registry";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";

// Workspace "Websites" görünümünün verisi (GA-F8, /websites): workspace'in
// bütün GA4 mülkleri tek listede. Yalnız kendi ambarımızdan ve sayaçlardan
// okur (Google'a çağrı yok); sorgular toplu, satır başına sorgu yok.

const MAX_LINKS = 200;
// Günlük toplamlar bu kadar gün geriye okunur: son 7 + önceki 7 gün ve
// bağın son gününün bugünden en çok 45 gün eski olabilmesi için pay.
const DAILY_LOOKBACK_DAYS = 60;

function serviceLevelOf(value: string | null): "360" | "standard" | null {
  if (value === "GOOGLE_ANALYTICS_360") return "360";
  if (value === "GOOGLE_ANALYTICS_STANDARD") return "standard";
  return null;
}

// Agentelse'in bu mülkte yaptığı doğrulanmış değişiklik sayısı (GA-F7:
// GaConfigChange VERIFIED ve noop=false). GaConfigChange modeline dokunan TEK yer.
export async function loadAgentelseChangeCounts(
  linkIds: readonly string[],
): Promise<Map<string, number>> {
  if (linkIds.length === 0) return new Map();
  const rows = await prisma.gaConfigChange.groupBy({
    by: ["linkId"],
    where: { linkId: { in: [...linkIds] }, status: "VERIFIED", noop: false },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.linkId, row._count._all]));
}

function bigQueryStatusOf(
  status: string | undefined,
): WebsitesOverviewRow["bigQuery"] {
  if (status === "OK") return "ok";
  if (status === "ERROR") return "error";
  if (status === "PENDING") return "pending";
  return "off";
}

export async function loadWebsitesOverview(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ rows: WebsitesOverviewRow[]; truncated: boolean }> {
  if (!gaAgencyEnabled()) return { rows: [], truncated: false };

  const links = await prisma.gaPropertyLink.findMany({
    where: { workspaceId, isMock: gaMockMode(), ...gaEngineLinkWhere() },
    select: {
      id: true,
      projectId: true,
      credentialId: true,
      propertyId: true,
      propertyName: true,
      isPrimary: true,
      serviceLevel: true,
      currencyCode: true,
      health: true,
      healthReason: true,
      healthScore: true,
      lastDailyDate: true,
      isMock: true,
    },
    take: MAX_LINKS,
    orderBy: [
      { projectId: "asc" },
      { isPrimary: "desc" },
      { propertyName: "asc" },
    ],
  });
  if (links.length === 0) return { rows: [], truncated: false };

  const linkIds = links.map((link) => link.id);
  const projectIds = [...new Set(links.map((link) => link.projectId))];
  const credentialIds = [...new Set(links.map((link) => link.credentialId))];
  const since = new Date(
    `${addDays(dateToDayKey(now), -DAILY_LOOKBACK_DAYS)}T00:00:00.000Z`,
  );

  const [
    projects,
    credentials,
    totals,
    findings,
    alerts,
    changes,
    bigQuery,
    shares,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true, status: true },
    }),
    prisma.integrationCredential.findMany({
      where: { id: { in: credentialIds } },
      select: { id: true, status: true },
    }),
    prisma.gaDailyTotal.findMany({
      where: { linkId: { in: linkIds }, date: { gte: since } },
      select: {
        linkId: true,
        date: true,
        sessions: true,
        keyEvents: true,
        revenueMicros: true,
      },
    }),
    prisma.gaFinding.groupBy({
      by: ["linkId"],
      where: { linkId: { in: linkIds }, status: "OPEN", mode: "live" },
      _count: { _all: true },
    }),
    prisma.adsAlert.findMany({
      where: {
        workspaceId,
        source: "GA4",
        status: { in: ["OPEN", "ACKED"] },
      },
      select: { severity: true, dedupeKey: true },
    }),
    loadAgentelseChangeCounts(linkIds),
    prisma.gaBigQuerySource.findMany({
      where: { linkId: { in: linkIds } },
      select: { linkId: true, status: true },
    }),
    prisma.reportShare.groupBy({
      by: ["projectId"],
      where: {
        workspaceId,
        kind: "WEBSITE",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      _count: true,
    }),
  ]);

  const projectOf = new Map(projects.map((project) => [project.id, project]));
  const credentialStatus = new Map(
    credentials.map((credential) => [credential.id, credential.status]),
  );
  const daysOf = new Map<
    string,
    { day: string; sessions: number; keyEvents: number; revenueMicros: bigint }[]
  >();
  for (const total of totals) {
    const list = daysOf.get(total.linkId) ?? [];
    list.push({
      day: dateToDayKey(total.date),
      sessions: total.sessions,
      keyEvents: total.keyEvents,
      revenueMicros: total.revenueMicros,
    });
    daysOf.set(total.linkId, list);
  }
  const findingsOf = new Map(
    findings.map((row) => [row.linkId, row._count._all]),
  );
  const alertsOf = new Map<string, { critical: number; warn: number }>();
  for (const alert of alerts) {
    const linkId = gaLinkIdOfDedupeKey(alert.dedupeKey);
    if (!linkId) continue;
    const entry = alertsOf.get(linkId) ?? { critical: 0, warn: 0 };
    if (alert.severity === "CRITICAL") entry.critical += 1;
    else if (alert.severity === "WARN") entry.warn += 1;
    alertsOf.set(linkId, entry);
  }
  const bigQueryOf = new Map(bigQuery.map((row) => [row.linkId, row.status]));
  const sharesOf = new Map(
    shares.map((row) => [row.projectId, row._count]),
  );
  const today = dateToDayKey(now);

  const rows: WebsitesOverviewRow[] = links.map((link) => {
    const project = projectOf.get(link.projectId);
    const status = credentialStatus.get(link.credentialId);
    const connection: WebsitesOverviewRow["connection"] =
      status === undefined
        ? "unknown"
        : status !== "ACTIVE" || link.health === "AUTH"
          ? "needs_reconnect"
          : "ok";
    const alertCounts = alertsOf.get(link.id);
    return {
      linkId: link.id,
      projectId: link.projectId,
      projectName: project?.name ?? link.projectId,
      projectStatus: project?.status ?? "UNKNOWN",
      propertyId: link.propertyId,
      propertyName: link.propertyName,
      role: link.isPrimary ? "main" : "extra",
      serviceLevel: serviceLevelOf(link.serviceLevel),
      currency: link.currencyCode,
      health: link.health,
      healthReason: link.healthReason,
      connection,
      measurementScore: link.healthScore,
      dataThrough: link.lastDailyDate,
      ...overviewMetrics(
        daysOf.get(link.id) ?? [],
        link.lastDailyDate,
        today,
      ),
      openFindings: findingsOf.get(link.id) ?? 0,
      alertsCritical: alertCounts?.critical ?? 0,
      alertsWarn: alertCounts?.warn ?? 0,
      agentelseChanges: changes.get(link.id) ?? 0,
      bigQuery: bigQueryStatusOf(bigQueryOf.get(link.id)),
      // Müşteri bağlantıları proje düzeyindedir: yalnız ana mülk satırında sayılır.
      activeShares: link.isPrimary ? (sharesOf.get(link.projectId) ?? 0) : 0,
      isMock: link.isMock,
    };
  });

  return {
    rows: sortOverviewRows(rows, today),
    truncated: links.length === MAX_LINKS,
  };
}
