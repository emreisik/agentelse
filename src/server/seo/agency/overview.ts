import "server-only";

import { Prisma } from "@prisma/client";

import { siteLabel } from "@/lib/module-flows/analytics/catalog";
import { prisma } from "@/lib/prisma";
import { gscToday } from "@/lib/seo/dates";
import { gscAgencyOn, gscBigQueryOn } from "@/lib/seo/agency/flags";
import {
  attentionOf,
  sortAgencyRows,
  summarize,
  type SearchAgencyOverview,
  type SearchAgencyRow,
} from "@/lib/seo/agency/overview";
import type { BqBadge } from "@/lib/seo/agency/types";
import { parseStoredScore } from "@/lib/seo/health/score";
import { SeoInsightFlags } from "@/lib/seo/insight-flags";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";

// Çalışma alanı "Search" genel bakışı (/search, docs/search-agency.md):
// workspace'in bütün Search Console siteleri (birincil ve ikincil) tek
// listede. Yalnız ambardan okur (Google'a çağrı yok). Bağ sayısından
// bağımsız EN FAZLA 7 sorgu: satır başına sorgu yok.

const MAX_LINKS = 200;
// Son 28 gün ve önceki 28 gün; değişim için 56 günün tamamı gerekir.
const WINDOW_DAYS = 28;
const STORED_DAYS_FOR_CHANGE = WINDOW_DAYS * 2;

type SumRow = {
  linkId: string;
  clicks: number;
  impressions: number;
  positionWeighted: number;
  previousClicks: number;
  days: number;
};

function emptyOverview(): SearchAgencyOverview {
  return { rows: [], totals: summarize([]), truncated: false };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const BQ_BADGES: readonly BqBadge[] = [
  "DRAFT",
  "VERIFIED",
  "ACTIVE",
  "PAUSED",
  "ERROR",
  "BUDGET",
];

function badgeOf(status: string | undefined): BqBadge {
  return (BQ_BADGES as readonly string[]).includes(status ?? "")
    ? (status as BqBadge)
    : "OFF";
}

export async function loadSearchAgencyOverview(
  workspaceId: string,
  now: Date = new Date(),
): Promise<SearchAgencyOverview> {
  if (!gscAgencyOn()) return emptyOverview();

  const isMock = gscMockMode();
  // (1) Bağlar: birincil ve ikincil siteler, bu kipin
  const links = await prisma.gscSiteLink.findMany({
    where: {
      workspaceId,
      isMock,
      OR: [{ isPrimary: true }, { isSecondary: true }],
    },
    orderBy: { siteUrl: "asc" },
    take: MAX_LINKS,
  });
  if (links.length === 0) return emptyOverview();

  const linkIds = links.map((link) => link.id);
  const projectIds = [...new Set(links.map((link) => link.projectId))];
  // Motor kaynaklı alanlar (sağlık, fırsat, uyarı) yalnız birincil sitenin.
  const primaries = links.filter((link) => link.isPrimary);
  const primaryIds = primaries.map((link) => link.id);
  const primaryProjectIds = [...new Set(primaries.map((link) => link.projectId))];
  const insightsOn = SeoInsightFlags.userFacing();
  const bigQueryOn = gscBigQueryOn();

  const [sums, projects, sites, findings, alerts, sources] = await Promise.all([
    // (2) Her bağ KENDİ lastFinalDate'inin son 28 günü ve önceki 28 günü
    prisma.$queryRaw<SumRow[]>(Prisma.sql`
      SELECT t."linkId" AS "linkId",
        COALESCE(SUM(t."clicks") FILTER (WHERE t."date" > l."fd" - ${WINDOW_DAYS}::int), 0)::float8 AS "clicks",
        COALESCE(SUM(t."impressions") FILTER (WHERE t."date" > l."fd" - ${WINDOW_DAYS}::int), 0)::float8 AS "impressions",
        COALESCE(SUM(t."positionWeighted") FILTER (WHERE t."date" > l."fd" - ${WINDOW_DAYS}::int), 0)::float8 AS "positionWeighted",
        COALESCE(SUM(t."clicks") FILTER (WHERE t."date" <= l."fd" - ${WINDOW_DAYS}::int), 0)::float8 AS "previousClicks",
        COUNT(*)::int AS "days"
      FROM "GscDailyTotal" t
      JOIN (
        SELECT "id", "lastFinalDate"::date AS "fd"
        FROM "GscSiteLink"
        WHERE "id" = ANY(${linkIds}::text[]) AND "lastFinalDate" IS NOT NULL
      ) l ON l."id" = t."linkId"
      WHERE t."searchType" = 'web'
        AND t."fresh" = false
        AND t."date" > l."fd" - ${STORED_DAYS_FOR_CHANGE}::int
        AND t."date" <= l."fd"
      GROUP BY t."linkId"
    `),
    // (3) Proje adları
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true },
    }),
    // (4) Sağlık puanı (SeoSite proje+kip başına tek satır)
    primaryProjectIds.length > 0
      ? prisma.seoSite.findMany({
          where: { projectId: { in: primaryProjectIds }, isMock },
          select: { projectId: true, healthParts: true },
        })
      : [],
    // (5) Açık fırsatlar: yalnız kullanıcıya açılmış motor varken
    insightsOn && primaryIds.length > 0
      ? prisma.seoFinding.groupBy({
          by: ["linkId"],
          where: {
            linkId: { in: primaryIds },
            status: "OPEN",
            shadow: false,
          },
          _count: { _all: true },
        })
      : null,
    // (6) Açık Search Console / SEO uyarıları (susturulmamış)
    primaryProjectIds.length > 0
      ? prisma.adsAlert.groupBy({
          by: ["projectId", "severity"],
          where: {
            projectId: { in: primaryProjectIds },
            source: { in: ["GSC", "SEO"] },
            status: { in: ["OPEN", "ACKED"] },
            OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }],
          },
          _count: { _all: true },
        })
      : [],
    // (7) BigQuery kaynakları (rozet)
    bigQueryOn
      ? prisma.gscBqSource.findMany({
          where: { projectId: { in: projectIds }, isMock },
          select: { projectId: true, siteUrl: true, status: true },
        })
      : [],
  ]);

  const sumOf = new Map(sums.map((row) => [row.linkId, row]));
  const nameOf = new Map(projects.map((project) => [project.id, project.name]));
  const scoreOf = new Map(
    sites.map((site) => [site.projectId, parseStoredScore(site.healthParts)]),
  );
  const findingsOf = new Map(
    (findings ?? []).map((row) => [row.linkId, row._count._all]),
  );
  const alertCount = (projectId: string, severity: string): number =>
    alerts
      .filter((row) => row.projectId === projectId && row.severity === severity)
      .reduce((sum, row) => sum + row._count._all, 0);
  const badgeOfSite = new Map(
    sources.map((source) => [`${source.projectId}|${source.siteUrl}`, source.status]),
  );
  const today = gscToday(now);

  const rows = links.map((link): SearchAgencyRow => {
    const sum = sumOf.get(link.id);
    const hasChange = sum !== undefined && sum.days >= STORED_DAYS_FOR_CHANGE;
    const clicks = sum ? sum.clicks : null;
    const previousClicks = hasChange ? sum.previousClicks : null;
    const clicksChangePct =
      hasChange && sum.previousClicks > 0
        ? round1(((sum.clicks - sum.previousClicks) / sum.previousClicks) * 100)
        : null;
    const primary = link.isPrimary;
    const score = primary ? (scoreOf.get(link.projectId) ?? null) : null;
    const critical = primary ? alertCount(link.projectId, "CRITICAL") : 0;
    const warn = primary ? alertCount(link.projectId, "WARN") : 0;
    const bigQuery = badgeOf(badgeOfSite.get(`${link.projectId}|${link.siteUrl}`));

    const row: SearchAgencyRow = {
      linkId: link.id,
      projectId: link.projectId,
      projectName: nameOf.get(link.projectId) ?? link.projectId,
      siteUrl: link.siteUrl,
      siteLabel: siteLabel(link.siteUrl),
      role: primary ? "PRIMARY" : "SECONDARY",
      isMock: link.isMock,
      health: link.health,
      healthReason: link.healthReason,
      finalThrough: link.lastFinalDate,
      backfillDone: link.backfillDoneAt !== null,
      clicks,
      previousClicks,
      clicksChangePct,
      impressions: sum ? sum.impressions : null,
      position:
        sum && sum.impressions > 0
          ? round1(sum.positionWeighted / sum.impressions)
          : null,
      healthScore: score?.value ?? null,
      healthCapped: score?.cappedByCritical ?? false,
      openOpportunities:
        primary && insightsOn ? (findingsOf.get(link.id) ?? 0) : null,
      critical,
      warn,
      bigQuery,
      attention: 0,
      attentionReasons: [],
    };
    const attention = attentionOf(row, today);
    row.attention = attention.score;
    row.attentionReasons = attention.reasons;
    return row;
  });

  return {
    rows: sortAgencyRows(rows),
    totals: summarize(rows),
    truncated: links.length === MAX_LINKS,
  };
}
