import "server-only";

import type { GscSiteLink } from "@prisma/client";

import { siteLabel } from "@/lib/module-flows/analytics/catalog";
import {
  effectiveBrandTerms,
  parseBrandTermsConfig,
} from "@/lib/seo/brand-terms";
import {
  addDays,
  dayKeyToDate,
  googleWindowStart,
  gscToday,
  weekEndOf,
} from "@/lib/seo/dates";
import {
  resolveSearchPeriod,
  type SearchPeriod,
  type SearchPeriodKey,
  type SearchWeeks,
} from "@/lib/seo/periods";
import {
  anonymousShare,
  averagePosition,
  ctrPercent,
  sumGscDays,
  type GscSplit,
  type GscTotals,
} from "@/lib/seo/totals";

import { brandSplitStatus, type BrandSplitStatus } from "./brand-terms";
import {
  gscDataThrough,
  primaryGscLink,
  readGscDays,
  readPeriodCoverage,
  readTopPages,
  readTopQueries,
  type GscDayRow,
  type GscPeriodCoverage,
  type GscRankedRow,
} from "./store";

// "Search" sayfasının verisi (docs/search-analytics.md "Arayüz", SC-F2 v1):
// kesin günlerden karşılaştırmalı KPI'lar (marka ayrımı hazırsa markasız
// tıklamalar önde), taze günlerle trend, tam haftalardan sorgu ve sayfa
// tabloları, anonim pay, notlar ve arşiv notu. Yalnız ambardan okur; web
// araması gösterilir.

export type SearchKpiKey =
  | "nonBrandClicks"
  | "brandClicks"
  | "clicks"
  | "impressions"
  | "ctr"
  | "position";

export type SearchKpiFormat = "count" | "percent" | "position";

export type SearchKpi = {
  key: SearchKpiKey;
  label: string;
  value: number | null;
  previous: number | null;
  format: SearchKpiFormat;
  lowerIsBetter: boolean;
};

export type SearchTrendPoint = {
  day: string;
  clicks: number;
  nonBrandClicks: number | null;
  fresh: boolean;
};

export type SearchTableRow = {
  label: string;
  href: string | null;
  isBrand: boolean;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
};

export type SearchTable = {
  rows: SearchTableRow[];
  weeks: SearchWeeks;
  aggregation: "By property" | "By page";
  truncated: boolean;
  notes: string[];
};

export type SearchQueryFilter = "all" | "non-brand" | "brand";

const QUERY_FILTERS: readonly SearchQueryFilter[] = [
  "all",
  "non-brand",
  "brand",
];

export function isSearchQueryFilter(
  value: unknown,
): value is SearchQueryFilter {
  return QUERY_FILTERS.some((filter) => filter === value);
}

export type SearchLinkInfo = {
  siteUrl: string;
  siteLabel: string;
  propertyType: string | null;
  permissionLevel: string | null;
  domainMatch: boolean | null;
  health: string;
  healthReason: string | null;
  dataThrough: string | null;
  finalThrough: string | null;
  earliest: string | null;
  googleWindowStart: string;
  backfillDone: boolean;
  archive: boolean;
  brandTerms: string[];
  brandSplit: BrandSplitStatus;
  isMock: boolean;
};

export type SearchReport = {
  link: SearchLinkInfo;
  period: SearchPeriod;
  coverage: { days: number; expected: number };
  kpis: SearchKpi[];
  trend: SearchTrendPoint[];
  previousTrend: number[];
  queries: SearchTable;
  pages: SearchTable;
  queryFilter: SearchQueryFilter;
  anonymousShare: number | null;
  notes: string[];
  archiveNote: string | null;
};

export type SearchReportState =
  | { state: "not_connected" }
  | { state: "waiting"; link: SearchLinkInfo }
  | { state: "ready"; report: SearchReport };

const TOP_ROWS = 25;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// "2026-10-03" → "Oct 3".
function monthDay(day: string): string {
  const date = dayKeyToDate(day);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

// "2025-06-14" → "Jun 2025".
function monthYear(day: string): string {
  const date = dayKeyToDate(day);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function linkInfo(
  link: GscSiteLink,
  through: {
    through: string | null;
    finalThrough: string | null;
    earliest: string | null;
  },
  now: Date,
): SearchLinkInfo {
  return {
    siteUrl: link.siteUrl,
    siteLabel: siteLabel(link.siteUrl),
    propertyType: link.propertyType,
    permissionLevel: link.permissionLevel,
    domainMatch: link.domainMatch,
    health: link.health,
    healthReason: link.healthReason,
    dataThrough: through.through,
    finalThrough: through.finalThrough,
    earliest: through.earliest,
    googleWindowStart: googleWindowStart(gscToday(now)),
    backfillDone: link.backfillDoneAt !== null,
    archive: link.archive,
    brandTerms: effectiveBrandTerms(parseBrandTermsConfig(link.brandTerms)),
    brandSplit: brandSplitStatus(link),
    isMock: link.isMock,
  };
}

// Integrations kartı ve Search sayfasının başlığı ("Final data through …").
export async function readSearchLinkInfo(
  projectId: string,
  now: Date = new Date(),
): Promise<SearchLinkInfo | null> {
  const link = await primaryGscLink(projectId);
  if (!link) return null;
  return linkInfo(link, await gscDataThrough(link.id), now);
}

function kpi(
  key: SearchKpiKey,
  label: string,
  format: SearchKpiFormat,
  value: number | null,
  previous: number | null,
  lowerIsBetter = false,
): SearchKpi {
  return { key, label, value, previous, format, lowerIsBetter };
}

function kpis(
  current: GscSplit,
  previous: GscSplit | null,
  brandOk: boolean,
): SearchKpi[] {
  const list: SearchKpi[] = [];
  if (brandOk) {
    list.push(
      kpi(
        "nonBrandClicks",
        "Non-brand clicks",
        "count",
        current.nonBrand?.clicks ?? null,
        previous?.nonBrand?.clicks ?? null,
      ),
      kpi(
        "brandClicks",
        "Brand clicks",
        "count",
        current.brand?.clicks ?? null,
        previous?.brand?.clicks ?? null,
      ),
    );
  }
  const before: GscTotals | null = previous ? previous.total : null;
  list.push(
    kpi(
      "clicks",
      brandOk ? "Total clicks" : "Clicks",
      "count",
      current.total.clicks,
      before ? before.clicks : null,
    ),
    kpi(
      "impressions",
      "Impressions",
      "count",
      current.total.impressions,
      before ? before.impressions : null,
    ),
    kpi(
      "ctr",
      "CTR",
      "percent",
      ctrPercent(current.total),
      before ? ctrPercent(before) : null,
    ),
    kpi(
      "position",
      "Avg. position",
      "position",
      averagePosition(current.total),
      before ? averagePosition(before) : null,
      true,
    ),
  );
  return list;
}

function trendPoint(row: GscDayRow, brandOk: boolean): SearchTrendPoint {
  return {
    day: row.day,
    clicks: row.clicks,
    nonBrandClicks:
      brandOk && row.brandClicks !== null
        ? Math.max(0, row.clicks - row.brandClicks)
        : null,
    fresh: row.fresh,
  };
}

const TRUNCATED_NOTE =
  "Google returns at most 50,000 rows a day, so the smallest searches are missing.";

function table(
  rows: GscRankedRow[],
  weeks: SearchWeeks,
  coverage: GscPeriodCoverage,
  aggregation: SearchTable["aggregation"],
  withHref: boolean,
): SearchTable {
  const notes: string[] = [];
  if (coverage.periods.length < weeks.count) {
    notes.push("Some weeks are still loading.");
  }
  if (coverage.truncated) notes.push(TRUNCATED_NOTE);
  return {
    rows: rows.map((row) => ({
      label: row.label,
      href: withHref ? row.url : null,
      isBrand: row.isBrand,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: ctrPercent(row),
      position: averagePosition(row),
    })),
    weeks,
    aggregation,
    truncated: coverage.truncated,
    notes,
  };
}

function brandNotes(status: BrandSplitStatus, brandOk: boolean): string[] {
  if (brandOk)
    return ["Non-brand clicks include searches Google doesn't show."];
  if (status === "none") {
    return ["Add brand terms to split brand and non-brand clicks."];
  }
  if (status === "error") {
    return [
      "Your brand terms couldn't be used to split clicks. Edit them below.",
    ];
  }
  // pending ya da hazır ama dönemin bir günü marka değerinden yoksun.
  return ["Brand and non-brand clicks are being calculated."];
}

function archiveNoteOf(info: SearchLinkInfo): string {
  if (info.earliest && info.earliest < info.googleWindowStart) {
    return `Older than Google keeps (archived by Agentelse): history since ${monthYear(info.earliest)}.`;
  }
  if (info.archive)
    return "Agentelse keeps your history beyond Google's 16 months.";
  return "Agentelse keeps the last 16 months, like Google.";
}

export async function buildSearchReport(
  projectId: string,
  periodKey: SearchPeriodKey,
  options: { queryFilter?: SearchQueryFilter; now?: Date } = {},
): Promise<SearchReportState> {
  const now = options.now ?? new Date();
  const queryFilter = options.queryFilter ?? "all";
  const link = await primaryGscLink(projectId);
  if (!link) return { state: "not_connected" };
  const through = await gscDataThrough(link.id);
  const info = linkInfo(link, through, now);
  const finalThrough = info.finalThrough;
  if (!finalThrough) return { state: "waiting", link: info };

  const period = resolveSearchPeriod(periodKey, finalThrough);
  const { weeks } = period;
  const weeksTo = weekEndOf(weeks.to);
  const freshTo =
    through.through && through.through > finalThrough ? through.through : null;
  const [
    currentRows,
    previousRows,
    freshRows,
    queryCoverage,
    pageCoverage,
    queryRows,
    pageRows,
    weekDays,
  ] = await Promise.all([
    readGscDays(link.id, period.from, period.to),
    readGscDays(link.id, period.previous.from, period.previous.to),
    freshTo
      ? readGscDays(link.id, addDays(finalThrough, 1), freshTo)
      : Promise.resolve([] as GscDayRow[]),
    readPeriodCoverage(link.id, "WEEK", "query", weeks.from, weeks.to),
    readPeriodCoverage(link.id, "WEEK", "page", weeks.from, weeks.to),
    readTopQueries(link.id, weeks, { limit: TOP_ROWS, brand: queryFilter }),
    readTopPages(link.id, weeks, {
      limit: TOP_ROWS,
      labelWithHost: link.propertyType === "DOMAIN",
    }),
    readGscDays(link.id, weeks.from, weeksTo),
  ]);

  // KPI'lar yalnız kesin günlerden.
  const finalRows = currentRows.filter((row) => !row.fresh);
  const current = sumGscDays(finalRows);
  const previousComplete = previousRows.length >= period.days;
  const previous = previousComplete ? sumGscDays(previousRows) : null;
  const brandOk = info.brandSplit === "ready" && current.brand !== null;

  // Anonim pay: haftalar eksiksiz ve hiçbiri kırpılmamışsa (kırpılmış satır
  // toplamı görünmeyeni olduğundan büyük gösterirdi).
  const weeksComplete = queryCoverage.periods.length >= weeks.count;
  const daysComplete = weekDays.length >= weeks.count * 7;
  const share =
    weeksComplete && daysComplete && !queryCoverage.truncated
      ? anonymousShare(
          weekDays.reduce((sum, row) => sum + row.clicks, 0),
          queryCoverage.rowClicks,
        )
      : null;

  const notes: string[] = [];
  if (freshRows.length > 0) {
    notes.push(
      `Days after ${monthDay(finalThrough)} are fresh and may change.`,
    );
  }
  if (finalRows.length < period.days) {
    notes.push(
      info.backfillDone
        ? "Some days in this period have no data."
        : "Older data is still loading from Search Console.",
    );
  }
  notes.push(...brandNotes(info.brandSplit, brandOk));
  notes.push(
    "Average position is Google's average top position for your site, not a rank tracker.",
  );

  return {
    state: "ready",
    report: {
      link: info,
      period,
      coverage: { days: finalRows.length, expected: period.days },
      kpis: kpis(current, previous, brandOk),
      trend: [...finalRows, ...freshRows].map((row) =>
        trendPoint(row, brandOk),
      ),
      previousTrend: previousRows.map((row) => row.clicks),
      queries: table(queryRows, weeks, queryCoverage, "By property", false),
      pages: table(pageRows, weeks, pageCoverage, "By page", true),
      queryFilter,
      anonymousShare: share,
      notes,
      archiveNote: archiveNoteOf(info),
    },
  };
}
