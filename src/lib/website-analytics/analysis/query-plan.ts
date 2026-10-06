import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import { GA_REPORTS } from "@/lib/website-analytics/catalog";
import { addDays, daysInRange } from "@/lib/website-analytics/days";
import {
  DEFAULT_WEBSITE_PERIOD,
  isWebsitePeriod,
  resolveWebsitePeriod,
  type WebsitePeriodKey,
} from "@/lib/website-analytics/periods";

import type { GaRange } from "./types";

// Sohbetin özel Google Analytics sorgusu (query_website_analytics,
// docs/website-insights.md "Sohbet"): istek önce ambara yönlendirilir —
// boyutsuz ya da yalnız tarihli istek GaDailyTotal'dan, bir katalog raporunun
// karşıladığı kırılım dilimlerden — ve ancak hiçbiri karşılamazsa P1 canlı
// runReport'a gider. Canlı istek yalnız GA4 temel metriklerini taşır; türetilmiş
// oranlar (engagementRate, keyEventRate, averageEngagementSeconds) yerelde
// hesaplanır. Saf modül.

export const QUERY_DIMENSIONS = [
  "date",
  "sessionDefaultChannelGroup",
  "sessionSource",
  "sessionMedium",
  "sessionCampaignName",
  "landingPage",
  "pagePath",
  "eventName",
  "deviceCategory",
  "country",
  "newVsReturning",
] as const;
export type QueryDimension = (typeof QUERY_DIMENSIONS)[number];

export const QUERY_METRICS = [
  "sessions",
  "engagedSessions",
  "engagementRate",
  "keyEvents",
  "keyEventRate",
  "totalRevenue",
  "activeUsers",
  "newUsers",
  "screenPageViews",
  "eventCount",
  "averageEngagementSeconds",
] as const;
export type QueryMetric = (typeof QUERY_METRICS)[number];

export const DERIVED_QUERY_METRICS: Readonly<
  Record<
    "engagementRate" | "keyEventRate" | "averageEngagementSeconds",
    readonly string[]
  >
> = {
  engagementRate: ["engagedSessions", "sessions"],
  keyEventRate: ["keyEvents", "sessions"],
  averageEngagementSeconds: ["userEngagementDuration", "sessions"],
};

export type WebsiteQueryArgs = {
  dimensions?: QueryDimension[];
  metrics: QueryMetric[];
  period?: WebsitePeriodKey | "custom";
  from?: string;
  to?: string;
  limit?: number;
  filter?: { dimension: QueryDimension; contains: string };
};

export type WebsiteQueryPlan =
  | { kind: "error"; message: string }
  | {
      kind: "totals";
      range: GaRange;
      grain: "all" | "day" | "week" | "month";
      metrics: WebsiteQueryArgs["metrics"];
    }
  | {
      kind: "slices";
      reportKey: string;
      range: GaRange;
      groupBy: string[];
      baseMetrics: string[];
      metrics: WebsiteQueryArgs["metrics"];
      filter: WebsiteQueryArgs["filter"] | null;
      limit: number;
    }
  | {
      kind: "live";
      range: GaRange;
      request: GaRunReportRequest;
      dimensions: string[];
      metrics: WebsiteQueryArgs["metrics"];
      limit: number;
    };

export const QUERY_MAX_DIMENSIONS = 2;
export const QUERY_MAX_METRICS = 4;
export const QUERY_MAX_ROWS = 20;
export const QUERY_DEFAULT_ROWS = 10;
export const QUERY_MAX_DAYS_BACK = 400;
export const QUERY_FILTER_MAX = 80;

// Ambardaki kırılımlardan hangileri sohbete açık (katalog sırasıyla).
const SLICE_REPORTS = [
  "channel",
  "source_medium",
  "campaign",
  "landing_page",
  "page",
  "events",
  "device_country",
  "new_returning",
] as const;

// Günlük toplamlarda olan metrikler: activeUsers günlerden toplanamaz,
// eventCount günlük toplamda yok.
const TOTALS_BLOCKED = new Set<string>(["activeUsers", "eventCount"]);
// Dilimlerden yalnız tek günlük dönem için okunabilen kullanıcı metrikleri.
const USER_METRICS = new Set<string>(["activeUsers", "newUsers"]);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isDerived(
  metric: string,
): metric is keyof typeof DERIVED_QUERY_METRICS {
  return Object.hasOwn(DERIVED_QUERY_METRICS, metric);
}

// İstenen metriklerin GA4 temel metrikleri, sırası korunarak ve tekrarsız.
export function baseMetricsOf(metrics: readonly string[]): string[] {
  const out: string[] = [];
  for (const metric of metrics) {
    const bases = isDerived(metric) ? DERIVED_QUERY_METRICS[metric] : [metric];
    for (const base of bases) if (!out.includes(base)) out.push(base);
  }
  return out;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return QUERY_DEFAULT_ROWS;
  return Math.min(QUERY_MAX_ROWS, Math.max(1, Math.round(limit)));
}

function rangeOf(
  args: WebsiteQueryArgs,
  today: string,
): { ok: true; range: GaRange } | { ok: false; message: string } {
  const custom =
    args.period === "custom" ||
    (args.period === undefined &&
      (args.from !== undefined || args.to !== undefined));
  if (!custom) {
    const key =
      args.period && isWebsitePeriod(args.period)
        ? args.period
        : DEFAULT_WEBSITE_PERIOD;
    const period = resolveWebsitePeriod(key, today);
    if (period.from > period.to) {
      return { ok: false, message: "This period has no complete day yet." };
    }
    return { ok: true, range: { from: period.from, to: period.to } };
  }
  const { from, to } = args;
  if (!from || !to || !DAY_PATTERN.test(from) || !DAY_PATTERN.test(to)) {
    return {
      ok: false,
      message:
        "A custom period needs both a start and an end date (YYYY-MM-DD).",
    };
  }
  if (from > to) {
    return {
      ok: false,
      message: "The start date must be on or before the end date.",
    };
  }
  if (to > addDays(today, -1)) {
    return {
      ok: false,
      message:
        "The period must end yesterday at the latest: today is still running.",
    };
  }
  if (from < addDays(today, -QUERY_MAX_DAYS_BACK)) {
    return {
      ok: false,
      message: `The period can start at most ${QUERY_MAX_DAYS_BACK} days ago.`,
    };
  }
  return { ok: true, range: { from, to } };
}

function totalsGrain(
  dimensions: readonly string[],
  range: GaRange,
): "all" | "day" | "week" | "month" {
  if (dimensions.length === 0) return "all";
  const days = daysInRange(range.from, range.to);
  if (days <= 20) return "day";
  if (days <= 140) return "week";
  return "month";
}

function filterOf(args: WebsiteQueryArgs): WebsiteQueryArgs["filter"] | null {
  const contains = args.filter?.contains.trim().slice(0, QUERY_FILTER_MAX);
  return args.filter && contains
    ? { dimension: args.filter.dimension, contains }
    : null;
}

// İsteği karşılayan ilk katalog raporu: bütün boyutlar (ve süzgeç boyutu)
// raporda, temel metrikler raporun metriklerinde. Kampanya raporu süzgeçli
// olduğundan (kampanyasız oturumlar yok) yalnız kampanya adı istenince seçilir.
function sliceReportFor(
  dimensions: readonly string[],
  baseMetrics: readonly string[],
  filter: WebsiteQueryArgs["filter"] | null,
): string | null {
  if (dimensions.includes("date")) return null;
  const needed = filter ? [...dimensions, filter.dimension] : [...dimensions];
  for (const key of SLICE_REPORTS) {
    const spec = GA_REPORTS.find((report) => report.key === key);
    if (!spec) continue;
    if (key === "campaign" && !needed.includes("sessionCampaignName")) continue;
    if (!needed.every((name) => spec.dimensions.includes(name))) continue;
    if (!baseMetrics.every((name) => spec.metrics.includes(name))) continue;
    return key;
  }
  return null;
}

export function livePlanOf(
  args: WebsiteQueryArgs,
  range: GaRange,
  limit: number,
): Extract<WebsiteQueryPlan, { kind: "live" }> {
  const dimensions = [...new Set(args.dimensions ?? [])];
  const baseMetrics = baseMetricsOf(args.metrics);
  const filter = filterOf(args);
  const capped = clampLimit(limit);
  const request: GaRunReportRequest = {
    dateRanges: [{ startDate: range.from, endDate: range.to }],
    ...(dimensions.length > 0
      ? { dimensions: dimensions.map((name) => ({ name })) }
      : {}),
    metrics: baseMetrics.map((name) => ({ name })),
    ...(filter
      ? {
          dimensionFilter: {
            filter: {
              fieldName: filter.dimension,
              stringFilter: {
                matchType: "CONTAINS",
                value: filter.contains,
                caseSensitive: false,
              },
            },
          },
        }
      : {}),
    orderBys: [
      { metric: { metricName: baseMetrics[0] ?? "sessions" }, desc: true },
    ],
    limit: capped,
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
  return {
    kind: "live",
    range,
    request,
    dimensions,
    metrics: args.metrics,
    limit: capped,
  };
}

export function planWebsiteQuery(
  args: WebsiteQueryArgs,
  ctx: { today: string },
): WebsiteQueryPlan {
  const dimensions = [...new Set(args.dimensions ?? [])];
  const metrics = [...new Set(args.metrics)];
  if (dimensions.length > QUERY_MAX_DIMENSIONS) {
    return {
      kind: "error",
      message: `Ask for at most ${QUERY_MAX_DIMENSIONS} dimensions.`,
    };
  }
  if (metrics.length === 0 || metrics.length > QUERY_MAX_METRICS) {
    return {
      kind: "error",
      message: `Ask for 1 to ${QUERY_MAX_METRICS} metrics.`,
    };
  }
  if (
    dimensions.some(
      (name) => !(QUERY_DIMENSIONS as readonly string[]).includes(name),
    ) ||
    metrics.some((name) => !(QUERY_METRICS as readonly string[]).includes(name))
  ) {
    return {
      kind: "error",
      message: "Use only the listed dimensions and metrics.",
    };
  }
  const resolved = rangeOf(args, ctx.today);
  if (!resolved.ok) return { kind: "error", message: resolved.message };
  const range = resolved.range;
  const limit = clampLimit(args.limit);
  const filter = filterOf(args);
  const normalized: WebsiteQueryArgs = { ...args, dimensions, metrics };

  if (
    !filter &&
    dimensions.every((name) => name === "date") &&
    !metrics.some((name) => TOTALS_BLOCKED.has(name))
  ) {
    return {
      kind: "totals",
      range,
      grain: totalsGrain(dimensions, range),
      metrics,
    };
  }

  const baseMetrics = baseMetricsOf(metrics);
  const multiDay = daysInRange(range.from, range.to) > 1;
  if (!(multiDay && baseMetrics.some((name) => USER_METRICS.has(name)))) {
    const reportKey = sliceReportFor(dimensions, baseMetrics, filter);
    if (reportKey) {
      return {
        kind: "slices",
        reportKey,
        range,
        groupBy: dimensions,
        baseMetrics,
        metrics,
        filter,
        limit,
      };
    }
  }
  return livePlanOf(normalized, range, limit);
}
