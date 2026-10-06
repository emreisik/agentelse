import "server-only";

import { Prisma, type GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  effectiveBrandTerms,
  parseBrandTermsConfig,
} from "@/lib/seo/brand-terms";
import type { GscPeriodKey } from "@/lib/seo/catalog";
import { gscPageKey, isHomepageUrl } from "@/lib/seo/crawl-url";
import {
  addDays,
  addMonths,
  addWeeks,
  dateToDayKey,
  dayKeyToDate,
  lastCompleteMonthStart,
  weekStartOf,
} from "@/lib/seo/dates";
import { SeoFlags } from "@/lib/seo/health-flags";
import type {
  ClusterInfo,
  CrawlFacts,
  CrawlSnapshot,
  IdMetric,
  PageStat,
  PairStat,
  QueryStat,
  RuleSnapshot,
  SeoMetric,
  SeoSeverity,
  WeeklyPairStat,
} from "@/lib/seo/opportunity-types";
import { sumGscDays } from "@/lib/seo/totals";
import { brandSplitStatus } from "@/server/seo/brand-terms";
import { SeoSites } from "@/server/seo/site/sites";
import { readGscDays, readPeriodCoverage } from "@/server/seo/store";

import type { SeoCurves } from "./state";

// Kuralların anlık görüntüsü (docs/search-opportunities.md "Zamanlama"):
// çapa W1'in bitirdiği hafta (GscSiteLink.lastWeeklyWeek). Şimdiki 4 haftanın
// query, page ve query_page özetlerinin üçü de yoksa null (W1 ağır sorguyu
// kuyruğa attıysa koşu no_data döner). Önceki 4 hafta eksikse karşılaştırma
// listeleri boştur. Tarama ve URL Inspection verisi yalnız SEO bayrakları
// açıkken okunur; hata kuralları düşürmez (null). Google'a çağrı yok.

const QUERY_LIMIT = 5_000;
const PAGE_LIMIT = 5_000;
const PAIR_LIMIT = 25_000;
const WEEKLY_PAIR_LIMIT = 20_000;
const WEEKLY_PAIR_MIN_IMPRESSIONS = 50;
const HISTORY_LOOKBACK_WEEKS = 70;
const MONTHS_WINDOW = 15;
const MONTHS_MIN = 6;
const MONTHLY_PAGE_MIN_CLICKS = 10;
const MONTHLY_PAGE_LIMIT = 5_000;
const COUNTRY_TOP = 50;
const CRAWL_PAGE_LIMIT = 5_000;
const CRAWL_LINK_LIMIT = 20_000;
const SO8_MAX_INLINKS = 2;
const SO8_MIN_IMPRESSIONS = 100;
const LOOKUP_CHUNK = 1_000;
const PERIOD_KEYS: readonly GscPeriodKey[] = ["query", "page", "query_page"];

type MetricSqlRow = {
  clicks: bigint | number | null;
  impressions: bigint | number | null;
  positionWeighted: number | null;
};

function metricOf(row: MetricSqlRow): SeoMetric {
  return {
    clicks: Number(row.clicks ?? 0),
    impressions: Number(row.impressions ?? 0),
    positionWeighted: Number(row.positionWeighted ?? 0),
  };
}

function dayKeyOf(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : dateToDayKey(value);
}

function mondays(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addWeeks(from, index));
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

// [from, to] Pazartesi'leri arasında query_page özeti olan haftalar.
export async function pairCoveredWeeks(
  linkId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const coverage = await readPeriodCoverage(
    linkId,
    "WEEK",
    "query_page",
    from,
    to,
  );
  return coverage.periods;
}

type QuerySqlRow = MetricSqlRow & {
  id: string;
  text: string;
  isBrand: boolean;
  intent: string | null;
  language: string | null;
  clusterId: string | null;
  firstSeenWeek: Date | string;
};

async function readQueries(
  linkId: string,
  from: string,
  to: string,
): Promise<QueryStat[]> {
  const rows = await prisma.$queryRaw<QuerySqlRow[]>`
    SELECT q."id" AS "id",
           q."text" AS "text",
           q."isBrand" AS "isBrand",
           q."intent" AS "intent",
           q."language" AS "language",
           q."clusterId" AS "clusterId",
           q."firstSeenWeek" AS "firstSeenWeek",
           SUM(w."clicks")::bigint AS "clicks",
           SUM(w."impressions")::bigint AS "impressions",
           SUM(w."positionWeighted")::float8 AS "positionWeighted"
      FROM "GscWeeklyQuery" w
      JOIN "GscQuery" q ON q."id" = w."queryId"
     WHERE w."linkId" = ${linkId}
       AND w."weekStart" BETWEEN ${from}::date AND ${to}::date
     GROUP BY q."id"
     ORDER BY "impressions" DESC, q."id" ASC
     LIMIT ${QUERY_LIMIT}
  `;
  return rows.map((row) => ({
    ...metricOf(row),
    queryId: row.id,
    text: row.text,
    isBrand: row.isBrand,
    intent: row.intent,
    language: row.language,
    clusterId: row.clusterId,
    firstSeenWeek: dayKeyOf(row.firstSeenWeek),
  }));
}

type IdSqlRow = MetricSqlRow & { id: string };

async function readIdMetrics(
  table: "GscWeeklyQuery" | "GscWeeklyPage",
  linkId: string,
  from: string,
  to: string,
  limit: number,
): Promise<IdMetric[]> {
  const column =
    table === "GscWeeklyQuery" ? Prisma.sql`"queryId"` : Prisma.sql`"pageId"`;
  const rows = await prisma.$queryRaw<IdSqlRow[]>`
    SELECT ${column} AS "id",
           SUM("clicks")::bigint AS "clicks",
           SUM("impressions")::bigint AS "impressions",
           SUM("positionWeighted")::float8 AS "positionWeighted"
      FROM ${Prisma.raw(`"${table}"`)}
     WHERE "linkId" = ${linkId}
       AND "weekStart" BETWEEN ${from}::date AND ${to}::date
     GROUP BY ${column}
     ORDER BY "impressions" DESC, "id" ASC
     LIMIT ${limit}
  `;
  return rows.map((row) => ({ ...metricOf(row), id: row.id }));
}

type PageSqlRow = MetricSqlRow & {
  id: string;
  url: string;
  path: string;
  pageGroup: string | null;
  firstSeenWeek: Date | string;
};

async function readPages(
  linkId: string,
  from: string,
  to: string,
): Promise<PageStat[]> {
  const rows = await prisma.$queryRaw<PageSqlRow[]>`
    SELECT p."id" AS "id",
           p."url" AS "url",
           p."path" AS "path",
           p."pageGroup" AS "pageGroup",
           p."firstSeenWeek" AS "firstSeenWeek",
           SUM(w."clicks")::bigint AS "clicks",
           SUM(w."impressions")::bigint AS "impressions",
           SUM(w."positionWeighted")::float8 AS "positionWeighted"
      FROM "GscWeeklyPage" w
      JOIN "GscPage" p ON p."id" = w."pageId"
     WHERE w."linkId" = ${linkId}
       AND w."weekStart" BETWEEN ${from}::date AND ${to}::date
     GROUP BY p."id"
     ORDER BY "impressions" DESC, p."id" ASC
     LIMIT ${PAGE_LIMIT}
  `;
  return rows.map((row) => ({
    ...metricOf(row),
    pageId: row.id,
    url: row.url,
    path: row.path,
    pageGroup: row.pageGroup,
    firstSeenWeek: dayKeyOf(row.firstSeenWeek),
  }));
}

type PairSqlRow = MetricSqlRow & { queryId: string; pageId: string };

async function readPairs(
  linkId: string,
  from: string,
  to: string,
): Promise<PairStat[]> {
  const rows = await prisma.$queryRaw<PairSqlRow[]>`
    SELECT "queryId", "pageId",
           SUM("clicks")::bigint AS "clicks",
           SUM("impressions")::bigint AS "impressions",
           SUM("positionWeighted")::float8 AS "positionWeighted"
      FROM "GscWeeklyQueryPage"
     WHERE "linkId" = ${linkId}
       AND "weekStart" BETWEEN ${from}::date AND ${to}::date
     GROUP BY "queryId", "pageId"
     ORDER BY "impressions" DESC, "queryId" ASC, "pageId" ASC
     LIMIT ${PAIR_LIMIT}
  `;
  return rows.map((row) => ({
    ...metricOf(row),
    queryId: row.queryId,
    pageId: row.pageId,
  }));
}

type WeeklyPairSqlRow = PairSqlRow & { weekStart: Date | string };

// Yalnız query_page özeti olan haftalar; şimdiki pencerede ≥ 50 gösterim
// alan sorgular.
async function readWeeklyPairs(
  linkId: string,
  weeks: readonly string[],
  current: { from: string; to: string },
): Promise<WeeklyPairStat[]> {
  if (weeks.length === 0) return [];
  const rows = await prisma.$queryRaw<WeeklyPairSqlRow[]>`
    SELECT p."weekStart", p."queryId", p."pageId",
           p."clicks"::bigint AS "clicks",
           p."impressions"::bigint AS "impressions",
           p."positionWeighted"::float8 AS "positionWeighted"
      FROM "GscWeeklyQueryPage" p
     WHERE p."linkId" = ${linkId}
       AND p."weekStart" = ANY(${[...weeks]}::date[])
       AND p."queryId" IN (
         SELECT w."queryId"
           FROM "GscWeeklyQuery" w
          WHERE w."linkId" = ${linkId}
            AND w."weekStart" BETWEEN ${current.from}::date AND ${current.to}::date
          GROUP BY w."queryId"
         HAVING SUM(w."impressions") >= ${WEEKLY_PAIR_MIN_IMPRESSIONS}
       )
     ORDER BY p."impressions" DESC, p."id" ASC
     LIMIT ${WEEKLY_PAIR_LIMIT}
  `;
  return rows.map((row) => ({
    ...metricOf(row),
    queryId: row.queryId,
    pageId: row.pageId,
    weekStart: dayKeyOf(row.weekStart),
  }));
}

type MonthlySqlRow = MetricSqlRow & { pageId: string; month: Date | string };

async function readMonthlyPages(
  linkId: string,
  from: string,
  to: string,
): Promise<(SeoMetric & { pageId: string; month: string })[]> {
  const rows = await prisma.$queryRaw<MonthlySqlRow[]>`
    SELECT m."pageId", m."month",
           m."clicks"::bigint AS "clicks",
           m."impressions"::bigint AS "impressions",
           m."positionWeighted"::float8 AS "positionWeighted"
      FROM "GscMonthlyPage" m
     WHERE m."linkId" = ${linkId}
       AND m."month" BETWEEN ${from}::date AND ${to}::date
       AND m."pageId" IN (
         SELECT x."pageId"
           FROM "GscMonthlyPage" x
          WHERE x."linkId" = ${linkId}
            AND x."month" BETWEEN ${from}::date AND ${to}::date
          GROUP BY x."pageId"
         HAVING MAX(x."clicks") >= ${MONTHLY_PAGE_MIN_CLICKS}
          ORDER BY SUM(x."clicks") DESC, x."pageId" ASC
          LIMIT ${MONTHLY_PAGE_LIMIT}
       )
     ORDER BY m."month" ASC, m."pageId" ASC
  `;
  return rows.map((row) => ({
    ...metricOf(row),
    pageId: row.pageId,
    month: dayKeyOf(row.month),
  }));
}

// Ülke kırılımı: [[key, clicks, impressions, positionWeighted], ...].
function countryRows(value: unknown): [string, number, number][] {
  if (!Array.isArray(value)) return [];
  const rows: [string, number, number][] = [];
  for (const item of value) {
    if (!Array.isArray(item)) continue;
    const [key, clicks, impressions] = item as unknown[];
    if (typeof key !== "string") continue;
    rows.push([
      key,
      typeof clicks === "number" ? clicks : 0,
      typeof impressions === "number" ? impressions : 0,
    ]);
  }
  return rows;
}

async function readCountries(
  linkId: string,
  from: string,
  to: string,
): Promise<RuleSnapshot["countries"]> {
  const slices = await prisma.gscDailySlice.findMany({
    where: {
      linkId,
      kind: "country",
      date: {
        gte: dayKeyToDate(from),
        lte: dayKeyToDate(to),
      },
    },
    select: { rows: true },
  });
  const totals = new Map<string, { clicks: number; impressions: number }>();
  for (const slice of slices) {
    for (const [country, clicks, impressions] of countryRows(slice.rows)) {
      const total = totals.get(country) ?? { clicks: 0, impressions: 0 };
      total.clicks += clicks;
      total.impressions += impressions;
      totals.set(country, total);
    }
  }
  return [...totals.entries()]
    .map(([country, total]) => ({ country, ...total }))
    .sort(
      (a, b) =>
        b.impressions - a.impressions ||
        b.clicks - a.clicks ||
        a.country.localeCompare(b.country),
    )
    .slice(0, COUNTRY_TOP);
}

// GscPage.url → kimlik (W1 anahtarı; gscPageKey ile aynı).
async function gscPageIdsByUrl(
  linkId: string,
  urls: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(urls)];
  const map = new Map<string, string>();
  for (const part of chunks(unique, LOOKUP_CHUNK)) {
    const rows = await prisma.gscPage.findMany({
      where: { linkId, url: { in: part } },
      select: { id: true, url: true },
    });
    for (const row of rows) map.set(row.url, row.id);
  }
  return map;
}

async function readInspections(
  linkId: string,
): Promise<RuleSnapshot["inspections"]> {
  const rows = await prisma.gscUrlInspection.findMany({
    where: { linkId },
    select: { url: true, verdict: true, coverageState: true },
  });
  const keyed = rows.map((row) => ({ ...row, key: gscPageKey(row.url) }));
  const ids = await gscPageIdsByUrl(
    linkId,
    keyed.flatMap((row) => (row.key ? [row.key] : [])),
  );
  return keyed.flatMap((row) => {
    const pageId = row.key ? ids.get(row.key) : undefined;
    return pageId
      ? [{ pageId, verdict: row.verdict, coverageState: row.coverageState }]
      : [];
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function headingsOf(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return stringList((value as { h2?: unknown }).h2);
}

function hreflangOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const lang = (item as { lang?: unknown }).lang;
    return typeof lang === "string" ? [lang] : [];
  });
}

const SEVERITIES: readonly SeoSeverity[] = ["INFO", "WARN", "CRITICAL"];

function issuesOf(value: unknown): CrawlFacts["issues"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { code, severity } = item as { code?: unknown; severity?: unknown };
    if (typeof code !== "string") return [];
    const level = SEVERITIES.find((candidate) => candidate === severity);
    return [{ code, severity: level ?? "INFO" }];
  });
}

async function readCrawl(
  link: GscSiteLink,
  pages: readonly PageStat[],
): Promise<CrawlSnapshot | null> {
  const site = await SeoSites.forProject(link.projectId);
  if (!site) return null;
  const [rows, lastFull] = await Promise.all([
    prisma.seoPage.findMany({
      where: { siteId: site.id, goneAt: null, robotsBlocked: false },
      orderBy: [{ inlinks: "desc" }, { id: "asc" }],
      take: CRAWL_PAGE_LIMIT,
      select: {
        id: true,
        url: true,
        urlHash: true,
        path: true,
        status: true,
        noindex: true,
        indexable: true,
        title: true,
        h1: true,
        headings: true,
        lang: true,
        hreflang: true,
        schemaTypes: true,
        inlinks: true,
        imagesNoAlt: true,
        issues: true,
        depth: true,
      },
    }),
    prisma.seoCrawl.findFirst({
      where: { siteId: site.id, kind: "FULL" },
      orderBy: { startedAt: "desc" },
      select: { status: true },
    }),
  ]);
  const keyOf = new Map(rows.map((row) => [row.id, gscPageKey(row.url)]));
  const ids = await gscPageIdsByUrl(
    link.id,
    [...keyOf.values()].filter((key): key is string => key !== null),
  );
  const gscIdOf = (seoPageId: string): string | null => {
    const key = keyOf.get(seoPageId);
    return key ? (ids.get(key) ?? null) : null;
  };

  const facts: CrawlFacts[] = rows.map((row) => ({
    pageId: gscIdOf(row.id),
    url: row.url,
    path: row.path,
    status: row.status,
    noindex: row.noindex,
    indexable: row.indexable,
    isHomepage: isHomepageUrl(row.url),
    title: row.title,
    h1: row.h1 ? [row.h1] : [],
    h2: headingsOf(row.headings),
    lang: row.lang,
    hreflang: hreflangOf(row.hreflang),
    schemaTypes: row.schemaTypes,
    inlinks: row.inlinks,
    imagesNoAlt: row.imagesNoAlt,
    issues: issuesOf(row.issues),
    depth: row.depth,
  }));

  // SO8 adayları: az iç bağlantılı ve ≥ 100 gösterim alan sayfalar; yalnız
  // onlara gelen bağlantılar okunur.
  const impressions = new Map(
    pages.map((page) => [page.pageId, page.impressions]),
  );
  const byHash = new Map(rows.map((row) => [row.urlHash, row]));
  const candidateHashes = rows
    .filter((row) => {
      if (row.inlinks > SO8_MAX_INLINKS) return false;
      const pageId = gscIdOf(row.id);
      return (
        pageId !== null && (impressions.get(pageId) ?? 0) >= SO8_MIN_IMPRESSIONS
      );
    })
    .map((row) => row.urlHash);
  const links: CrawlSnapshot["links"] = [];
  if (candidateHashes.length > 0) {
    const linkRows = await prisma.seoLink.findMany({
      where: { siteId: site.id, toUrlHash: { in: candidateHashes } },
      take: CRAWL_LINK_LIMIT,
      select: {
        toUrlHash: true,
        from: { select: { id: true, url: true, path: true } },
      },
    });
    const fromIds = await gscPageIdsByUrl(
      link.id,
      linkRows
        .map((row) => gscPageKey(row.from.url))
        .filter((key): key is string => key !== null),
    );
    for (const row of linkRows) {
      const target = byHash.get(row.toUrlHash);
      if (!target) continue;
      const fromKey = gscPageKey(row.from.url);
      links.push({
        fromPageId: fromKey ? (fromIds.get(fromKey) ?? null) : null,
        fromPath: row.from.path,
        toPageId: gscIdOf(target.id),
        toPath: target.path,
      });
    }
  }
  return { complete: lastFull?.status === "DONE", pages: facts, links };
}

// Tek bir okumayı korur: hata kuralları düşürmez.
async function guarded<T>(
  label: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.warn(
      `[seo-opportunities] ${label} unavailable:`,
      error instanceof Error ? error.name : "UnknownError",
    );
    return null;
  }
}

export async function loadRuleSnapshot(input: {
  link: GscSiteLink;
  week: string;
  curves: SeoCurves;
  clusters: ClusterInfo[];
  now: Date;
}): Promise<RuleSnapshot | null> {
  const { link, week } = input;
  const current = { from: addWeeks(week, -3), to: addDays(week, 6) };
  const previous = { from: addWeeks(week, -7), to: addDays(week, -22) };
  const currentWeeks = mondays(current.from, 4);
  const previousWeeks = mondays(previous.from, 4);

  // Kapsam: 8 haftanın üç özeti tek okumada.
  const coverage = await Promise.all(
    PERIOD_KEYS.map((key) =>
      readPeriodCoverage(link.id, "WEEK", key, previous.from, week),
    ),
  );
  const fetched = new Map(
    PERIOD_KEYS.map((key, index) => [
      key,
      new Set(coverage[index]?.periods ?? []),
    ]),
  );
  const hasAll = (weeks: readonly string[]) =>
    PERIOD_KEYS.every((key) =>
      weeks.every((monday) => fetched.get(key)?.has(monday) ?? false),
    );
  if (!hasAll(currentWeeks)) return null;
  const previousComplete = hasAll(previousWeeks);
  const pairWeeks = [...previousWeeks, ...currentWeeks].filter(
    (monday) => fetched.get("query_page")?.has(monday) ?? false,
  );

  // Geçmiş: `week`te biten kesintisiz 'query' haftaları (≤ 70).
  const history = await readPeriodCoverage(
    link.id,
    "WEEK",
    "query",
    addWeeks(week, -(HISTORY_LOOKBACK_WEEKS - 1)),
    week,
  );
  const historySet = new Set(history.periods);
  let historyWeeks = 0;
  while (
    historyWeeks < HISTORY_LOOKBACK_WEEKS &&
    historySet.has(addWeeks(week, -historyWeeks))
  ) {
    historyWeeks += 1;
  }

  // Aylar: son 15 tam ay.
  const lastMonth = lastCompleteMonthStart(link.lastFinalDate ?? current.to);
  const firstMonth = addMonths(lastMonth, -(MONTHS_WINDOW - 1));
  const monthCoverage = await readPeriodCoverage(
    link.id,
    "MONTH",
    "page",
    firstMonth,
    lastMonth,
  );
  const months = monthCoverage.periods;

  const yearAgo = {
    from: addWeeks(current.from, -52),
    to: addDays(addWeeks(week, -52), 6),
  };
  const yearAgoCoverage = await readPeriodCoverage(
    link.id,
    "WEEK",
    "page",
    yearAgo.from,
    addWeeks(week, -52),
  );
  const yearAgoComplete = mondays(yearAgo.from, 4).every((monday) =>
    yearAgoCoverage.periods.includes(monday),
  );

  const [
    project,
    queries,
    previousQueries,
    pages,
    previousPages,
    yearAgoPages,
    pairs,
    previousPairs,
    weeklyPairs,
    monthlyPages,
    webDays,
    imageDays,
    videoDays,
    countries,
  ] = await Promise.all([
    prisma.project.findUnique({
      where: { id: link.projectId },
      select: { language: true, country: true },
    }),
    readQueries(link.id, current.from, current.to),
    previousComplete
      ? readIdMetrics(
          "GscWeeklyQuery",
          link.id,
          previous.from,
          previous.to,
          QUERY_LIMIT,
        )
      : Promise.resolve([]),
    readPages(link.id, current.from, current.to),
    previousComplete
      ? readIdMetrics(
          "GscWeeklyPage",
          link.id,
          previous.from,
          previous.to,
          PAGE_LIMIT,
        )
      : Promise.resolve([]),
    yearAgoComplete
      ? readIdMetrics(
          "GscWeeklyPage",
          link.id,
          yearAgo.from,
          yearAgo.to,
          PAGE_LIMIT,
        )
      : Promise.resolve(null),
    readPairs(link.id, current.from, current.to),
    previousComplete
      ? readPairs(link.id, previous.from, previous.to)
      : Promise.resolve([]),
    readWeeklyPairs(link.id, pairWeeks, current),
    months.length >= MONTHS_MIN
      ? readMonthlyPages(link.id, firstMonth, lastMonth)
      : Promise.resolve(null),
    readGscDays(link.id, previous.from, current.to, "web"),
    readGscDays(link.id, current.from, current.to, "image"),
    readGscDays(link.id, current.from, current.to, "video"),
    readCountries(link.id, current.from, current.to),
  ]);

  // Marka haftaları: bir gün bile eksik ya da marka değeri yoksa null.
  const byWeek = new Map<
    string,
    { days: number; brand: number; complete: boolean; impressions: number }
  >();
  for (const day of webDays) {
    const monday = weekStartOf(day.day);
    const entry = byWeek.get(monday) ?? {
      days: 0,
      brand: 0,
      complete: true,
      impressions: 0,
    };
    entry.days += 1;
    entry.impressions += day.impressions;
    if (day.brandImpressions === null) entry.complete = false;
    else entry.brand += day.brandImpressions;
    byWeek.set(monday, entry);
  }
  const brandWeeks = [...previousWeeks, ...currentWeeks].map((monday) => {
    const entry = byWeek.get(monday);
    return {
      weekStart: monday,
      brandImpressions:
        entry && entry.complete && entry.days === 7 ? entry.brand : null,
      impressions: entry?.impressions ?? 0,
    };
  });

  const finalDays = webDays.filter(
    (day) => !day.fresh && day.day >= current.from && day.day <= current.to,
  );
  const split = sumGscDays(finalDays);
  const sumImpressions = (days: readonly { impressions: number }[]) =>
    days.reduce((sum, day) => sum + day.impressions, 0);

  const inspections = SeoFlags.health()
    ? await guarded("inspections", () => readInspections(link.id))
    : null;
  const crawl = SeoFlags.crawl()
    ? await guarded("crawl", () => readCrawl(link, pages))
    : null;

  return {
    linkId: link.id,
    projectId: link.projectId,
    propertyType: link.propertyType,
    week,
    current,
    previous,
    previousComplete,
    pairWeeks,
    historyWeeks,
    historyMonths: months.length,
    backfillDone: link.backfillDoneAt !== null,
    brandSplitReady: brandSplitStatus(link) === "ready",
    brandTerms: effectiveBrandTerms(parseBrandTermsConfig(link.brandTerms)),
    projectLanguage: project?.language ?? null,
    projectCountry: project?.country ?? null,
    totals: {
      clicks: split.total.clicks,
      impressions: split.total.impressions,
      nonBrandClicks: split.nonBrand?.clicks ?? null,
      nonBrandImpressions: split.nonBrand?.impressions ?? null,
    },
    queries,
    previousQueries,
    pages,
    previousPages,
    yearAgoPages,
    pairs,
    previousPairs,
    weeklyPairs,
    monthlyPages,
    months,
    brandWeeks,
    searchTypes: {
      image: sumImpressions(imageDays),
      video: sumImpressions(videoDays),
    },
    countries,
    inspections,
    crawl,
    clusters: input.clusters,
    curves: input.curves,
  };
}
