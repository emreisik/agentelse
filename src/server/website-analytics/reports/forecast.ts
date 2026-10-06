import "server-only";

import type {
  GaAnalysisDay,
} from "@/lib/website-analytics/analysis/types";
import { addDays } from "@/lib/website-analytics/days";
import { forecastMonthEnd } from "@/lib/website-analytics/reports/forecast";
import type {
  ForecastMetric,
  MonthForecastView,
} from "@/lib/website-analytics/reports/types";
import {
  loadAnalysisDays,
  loadExcludedDays,
} from "@/server/website-analytics/analysis/inputs";

// Ay sonu tahmini için ambar okuması (Google'a çağrı yok): [through-399,
// through] günleri ve hariç tutulacak günler (şüpheli ∪ tatil). Tahmin
// formülü saf kütüphanededir (lib/website-analytics/reports/forecast.ts).

const HISTORY_DAYS = 399;
const RECENT_REVENUE_DAYS = 28;

export async function loadForecastContext(input: {
  linkId: string;
  through: string;
  country: string | null;
}): Promise<{ days: GaAnalysisDay[]; exclude: Set<string> }> {
  const range = { from: addDays(input.through, -HISTORY_DAYS), to: input.through };
  const [days, excluded] = await Promise.all([
    loadAnalysisDays(input.linkId, range),
    loadExcludedDays(input.linkId, input.country, range),
  ]);
  return {
    days,
    exclude: new Set([...excluded.suspect, ...excluded.holidays]),
  };
}

// Gelir tahmini yalnız sitenin son 28 günde geliri varsa üretilir.
export function forecastMetricsOf(
  days: readonly GaAnalysisDay[],
  through: string,
): ForecastMetric[] {
  const since = addDays(through, -(RECENT_REVENUE_DAYS - 1));
  const recentRevenue = days
    .filter((day) => day.day >= since && day.day <= through)
    .reduce((sum, day) => sum + day.revenue, 0);
  return recentRevenue > 0
    ? ["sessions", "keyEvents", "revenue"]
    : ["sessions", "keyEvents"];
}

export async function loadMonthForecasts(input: {
  linkId: string;
  through: string;
  country: string | null;
}): Promise<MonthForecastView[]> {
  const { days, exclude } = await loadForecastContext(input);
  return forecastMetricsOf(days, input.through).map((metric) =>
    forecastMonthEnd({ days, metric, through: input.through, exclude }),
  );
}
