import "server-only";

import { Prisma, type GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { GscGrain, GscPeriodKey, GscSearchType } from "@/lib/seo/catalog";
import { dateToDayKey, dayKeyToDate } from "@/lib/seo/dates";
import type { GscDayLike } from "@/lib/seo/totals";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";

// Search Console ambarının tek okuma kapısı (docs/search-analytics.md
// "Okuyucular"): Search sayfası, Brand kartı, Analytics modülü, sohbet
// sağlayıcısı ve SEO hızlı kazanımları buradan okur. Google'a çağrı yapmaz.

export type GscDayRow = GscDayLike & {
  day: string;
  searchType: GscSearchType;
  fresh: boolean;
};

export type GscRankedRow = {
  id: string;
  label: string;
  url: string | null;
  isBrand: boolean;
  clicks: number;
  impressions: number;
  positionWeighted: number;
};

export type GscPeriodCoverage = {
  // Çekilmiş dönem başları (YYYY-MM-DD), eskiden yeniye.
  periods: string[];
  truncated: boolean;
  rowClicks: number;
  rowImpressions: number;
};

// Projenin şu anki birincil bağı; yalnız geçerli kipin (mock/canlı) bağları.
export async function primaryGscLink(
  projectId: string,
): Promise<GscSiteLink | null> {
  return prisma.gscSiteLink.findFirst({
    where: { projectId, isPrimary: true, isMock: gscMockMode() },
    orderBy: { updatedAt: "desc" },
  });
}

export async function readGscDays(
  linkId: string,
  from: string,
  to: string,
  searchType: GscSearchType = "web",
): Promise<GscDayRow[]> {
  if (from > to) return [];
  const rows = await prisma.gscDailyTotal.findMany({
    where: {
      linkId,
      searchType,
      date: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) },
    },
    orderBy: { date: "asc" },
  });
  return rows.map((row) => ({
    day: dateToDayKey(row.date),
    searchType: row.searchType as GscSearchType,
    fresh: row.fresh,
    clicks: row.clicks,
    impressions: row.impressions,
    positionWeighted: row.positionWeighted,
    brandClicks: row.brandClicks,
    brandImpressions: row.brandImpressions,
    brandPositionWeighted: row.brandPositionWeighted,
  }));
}

// Web toplamlarının kapsadığı son gün, kesinleşen son gün ve en eski gün.
export async function gscDataThrough(linkId: string): Promise<{
  through: string | null;
  finalThrough: string | null;
  earliest: string | null;
}> {
  const where = { linkId, searchType: "web" };
  const [latest, latestFinal, oldest] = await Promise.all([
    prisma.gscDailyTotal.findFirst({
      where,
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    prisma.gscDailyTotal.findFirst({
      where: { ...where, fresh: false },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    prisma.gscDailyTotal.findFirst({
      where,
      orderBy: { date: "asc" },
      select: { date: true },
    }),
  ]);
  return {
    through: latest ? dateToDayKey(latest.date) : null,
    finalThrough: latestFinal ? dateToDayKey(latestFinal.date) : null,
    earliest: oldest ? dateToDayKey(oldest.date) : null,
  };
}

type RankedSqlRow = {
  id: string;
  label: string;
  url: string | null;
  isBrand: boolean;
  clicks: bigint | number | null;
  impressions: bigint | number | null;
  positionWeighted: number | null;
};

function rankedRow(row: RankedSqlRow, label: string): GscRankedRow {
  return {
    id: row.id,
    label,
    url: row.url,
    isBrand: row.isBrand,
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    positionWeighted: Number(row.positionWeighted ?? 0),
  };
}

function orderSql(orderBy: "clicks" | "impressions"): Prisma.Sql {
  return orderBy === "impressions"
    ? Prisma.sql`ORDER BY "impressions" DESC, "clicks" DESC, "id" ASC`
    : Prisma.sql`ORDER BY "clicks" DESC, "impressions" DESC, "id" ASC`;
}

// Haftalık özetlerden [weeks.from, weeks.to] Pazartesi'leri arasındaki en
// büyük sorgular (sözlük kimliğine göre toplanmış).
export async function readTopQueries(
  linkId: string,
  weeks: { from: string; to: string },
  options: {
    limit: number;
    brand?: "all" | "brand" | "non-brand";
    orderBy?: "clicks" | "impressions";
  },
): Promise<GscRankedRow[]> {
  const brand =
    options.brand === "brand"
      ? Prisma.sql`AND q."isBrand" = true`
      : options.brand === "non-brand"
        ? Prisma.sql`AND q."isBrand" = false`
        : Prisma.empty;
  const rows = await prisma.$queryRaw<RankedSqlRow[]>`
    SELECT q."id" AS "id",
           q."text" AS "label",
           NULL::text AS "url",
           q."isBrand" AS "isBrand",
           SUM(w."clicks")::bigint AS "clicks",
           SUM(w."impressions")::bigint AS "impressions",
           SUM(w."positionWeighted")::float8 AS "positionWeighted"
      FROM "GscWeeklyQuery" w
      JOIN "GscQuery" q ON q."id" = w."queryId"
     WHERE w."linkId" = ${linkId}
       AND w."weekStart" BETWEEN ${weeks.from}::date AND ${weeks.to}::date
       ${brand}
     GROUP BY q."id", q."text", q."isBrand"
     ${orderSql(options.orderBy ?? "clicks")}
     LIMIT ${Math.max(1, Math.floor(options.limit))}
  `;
  return rows.map((row) => rankedRow(row, row.label));
}

// "https://shop.example.com" + "/a" → "shop.example.com/a" (Domain mülkünde
// alt alan adları ayrı sitelerdir); URL okunamazsa yalnız yol.
function pageLabel(url: string | null, path: string, withHost: boolean) {
  if (!withHost || !url) return path;
  try {
    return `${new URL(url).host}${path}`;
  } catch {
    return path;
  }
}

export async function readTopPages(
  linkId: string,
  weeks: { from: string; to: string },
  options: { limit: number; labelWithHost?: boolean },
): Promise<GscRankedRow[]> {
  const rows = await prisma.$queryRaw<RankedSqlRow[]>`
    SELECT p."id" AS "id",
           p."path" AS "label",
           p."url" AS "url",
           false AS "isBrand",
           SUM(w."clicks")::bigint AS "clicks",
           SUM(w."impressions")::bigint AS "impressions",
           SUM(w."positionWeighted")::float8 AS "positionWeighted"
      FROM "GscWeeklyPage" w
      JOIN "GscPage" p ON p."id" = w."pageId"
     WHERE w."linkId" = ${linkId}
       AND w."weekStart" BETWEEN ${weeks.from}::date AND ${weeks.to}::date
     GROUP BY p."id", p."path", p."url"
     ${orderSql("clicks")}
     LIMIT ${Math.max(1, Math.floor(options.limit))}
  `;
  return rows.map((row) =>
    rankedRow(
      row,
      pageLabel(row.url, row.label, options.labelWithHost ?? false),
    ),
  );
}

// Hangi haftalık/aylık özetlerin çekildiği, kırpılma ve satır toplamları
// (anonim pay için).
export async function readPeriodCoverage(
  linkId: string,
  grain: GscGrain,
  key: GscPeriodKey,
  from: string,
  to: string,
): Promise<GscPeriodCoverage> {
  const rows = await prisma.gscPeriodFetch.findMany({
    where: {
      linkId,
      grain,
      key,
      periodStart: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) },
    },
    orderBy: { periodStart: "asc" },
    select: {
      periodStart: true,
      truncated: true,
      rowClicks: true,
      rowImpressions: true,
    },
  });
  return {
    periods: rows.map((row) => dateToDayKey(row.periodStart)),
    truncated: rows.some((row) => row.truncated),
    rowClicks: rows.reduce((sum, row) => sum + row.rowClicks, 0),
    rowImpressions: rows.reduce((sum, row) => sum + row.rowImpressions, 0),
  };
}
