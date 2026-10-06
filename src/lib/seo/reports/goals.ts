import { formatCount, formatPercent } from "@/lib/module-flows/analytics/format";

import type {
  GoalPace,
  GoalPaceResult,
  GoalSeriesPoint,
  SeoGoalMetricKey,
} from "./types";
import { SEO_GOAL_METRIC_KEYS } from "./types";

// SEO hedefleri: katalog, başlıklar ve hedef temposu (docs/search-reports.md
// "Hedefler"). Saf. Hedefler ProjectGoal.metricKey'in beş TAM değerinden
// biriyle tanınır (önek eşleşmesi yok; yapay zekanın önerdiği serbest anahtarlar
// SEO hedefi sayılmaz).

export const SEO_GOAL_METRICS: Readonly<
  Record<
    SeoGoalMetricKey,
    {
      label: string;
      unit: "count" | "percent";
      needs: "brand_split" | "health" | "cwv" | null;
      window: string;
    }
  >
> = {
  "gsc.nonBrandClicks": {
    label: "Non-brand search clicks a month",
    unit: "count",
    needs: "brand_split",
    window: "last 30 days",
  },
  "gsc.clicks": {
    label: "Search clicks a month",
    unit: "count",
    needs: null,
    window: "last 30 days",
  },
  "gsc.top10Queries": {
    label: "Non-brand searches in Google's top 10",
    unit: "count",
    needs: "brand_split",
    window: "last 4 weeks",
  },
  "seo.indexedShare": {
    label: "Pages indexed by Google",
    unit: "percent",
    needs: "health",
    window: "latest estimate",
  },
  "seo.cwvGoodShare": {
    label: "Pages with good Core Web Vitals",
    unit: "percent",
    needs: "cwv",
    window: "latest estimate",
  },
};

// Yalnız tam eşleşme: SEO hedefini tanımanın TEK yolu.
export function isSeoGoalMetric(value: unknown): value is SeoGoalMetricKey {
  return (
    typeof value === "string" &&
    (SEO_GOAL_METRIC_KEYS as readonly string[]).includes(value)
  );
}

const MAX_COUNT_TARGET = 10_000_000;

export function validSeoGoalTarget(
  metric: SeoGoalMetricKey,
  target: number,
): boolean {
  if (!Number.isFinite(target) || target <= 0) return false;
  if (SEO_GOAL_METRICS[metric].unit === "percent") return target <= 100;
  return Number.isInteger(target) && target <= MAX_COUNT_TARGET;
}

export function seoGoalTitle(metric: SeoGoalMetricKey, target: number): string {
  switch (metric) {
    case "gsc.nonBrandClicks":
      return `Reach ${formatCount(target)} non-brand search clicks a month`;
    case "gsc.clicks":
      return `Reach ${formatCount(target)} search clicks a month`;
    case "gsc.top10Queries":
      return `Get ${formatCount(target)} non-brand searches into Google's top 10`;
    case "seo.indexedShare":
      return `Keep ${formatPercent(target)} of pages indexed by Google`;
    case "seo.cwvGoodShare":
      return `Get ${formatPercent(target)} of pages to good Core Web Vitals`;
  }
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

// ProjectGoal'un bitiş tarihi yoktur: ufuk sabit 13 haftadır.
export const PACE_HORIZON_WEEKS = 13;
export const PACE_MIN_POINTS = 6;
export const PACE_Z = 1.645;

export const PACE_LABEL: Readonly<Record<GoalPace, string>> = {
  achieved: "Reached",
  on_track: "On track",
  behind: "Behind",
  at_risk: "At risk",
  unknown: "Not enough data",
};

// x = 0..n−1 üzerinde en küçük kareler doğrusu; n < 2 ise null. residualSd n−2
// serbestlik derecesiyle (n = 2'de 0).
export function linearTrend(values: readonly number[]): {
  slope: number;
  intercept: number;
  residualSd: number;
  n: number;
} | null {
  const n = values.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / n;
  let sxx = 0;
  let sxy = 0;
  values.forEach((value, x) => {
    sxx += (x - xMean) ** 2;
    sxy += (x - xMean) * (value - yMean);
  });
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  let sse = 0;
  values.forEach((value, x) => {
    sse += (value - (intercept + slope * x)) ** 2;
  });
  const residualSd = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return { slope, intercept, residualSd, n };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function unknown(reason: string): GoalPaceResult {
  return {
    pace: "unknown",
    projected: null,
    low: null,
    high: null,
    slopePerWeek: null,
    reason,
  };
}

// Son ≤ 13 haftalık noktaya doğru çizilir, 13 hafta ileri taşınır ve %90'lık
// aralıkla (±1,645 se) hedefe karşı okunur:
//   aralığın altı ≥ hedef → on_track; üstü < hedef → behind (kırmızı); aksi
//   halde at_risk (sarı). Web (GA) tempo sözlüğüyle aynı: "Behind" daha kötü.
// Karar, gösterilen (1 ondalık) değerlerle verilir.
export function goalPace(input: {
  current: number | null;
  target: number | null;
  series: readonly GoalSeriesPoint[];
  max?: number | null;
}): GoalPaceResult {
  const { current, target } = input;
  if (current === null || !Number.isFinite(current)) return unknown("no_value");
  if (target === null || !Number.isFinite(target)) return unknown("no_target");
  if (current >= target) {
    return {
      pace: "achieved",
      projected: null,
      low: null,
      high: null,
      slopePerWeek: null,
      reason: null,
    };
  }
  if (input.series.length < PACE_MIN_POINTS) return unknown("short_history");

  const values = [...input.series]
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-PACE_HORIZON_WEEKS)
    .map((point) => point.value);
  const fit = linearTrend(values);
  if (!fit) return unknown("short_history");

  const n = fit.n;
  const xMean = (n - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < n; x++) sxx += (x - xMean) ** 2;
  const xh = n - 1 + PACE_HORIZON_WEEKS;
  const projected = fit.intercept + fit.slope * xh;
  const se = fit.residualSd * Math.sqrt(1 + 1 / n + (xh - xMean) ** 2 / sxx);

  const upper = input.max ?? null;
  const clamp = (value: number) => {
    const floored = Math.max(0, value);
    return upper === null ? floored : Math.min(upper, floored);
  };
  const projectedValue = round1(clamp(projected));
  const low = round1(clamp(projected - PACE_Z * se));
  const high = round1(clamp(projected + PACE_Z * se));

  const pace: GoalPace =
    low >= target ? "on_track" : high < target ? "behind" : "at_risk";
  return {
    pace,
    projected: projectedValue,
    low,
    high,
    slopePerWeek: Math.round(fit.slope * 100) / 100,
    reason: null,
  };
}
