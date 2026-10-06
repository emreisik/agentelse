import {
  addDays,
  daysInRange,
  monthEnd,
  monthStart,
} from "@/lib/website-analytics/days";
import { sameWeekdayBaseline } from "@/lib/website-analytics/analysis/baseline";
import { median } from "@/lib/website-analytics/analysis/stats";
import type { GaAnalysisDay } from "@/lib/website-analytics/analysis/types";

import type { ForecastBasis, ForecastMetric, MonthForecastView } from "./types";

// Ay sonu tahmini (docs/website-reports.md "Tahmin"). Nokta tahmini GA-F4
// AN15'in formülüyle aynıdır: ay başından bugüne toplam + kalan her gün için
// aynı haftanın günü medyanı (8 hafta, şüpheli ve tatil günleri hariç, en az
// 3 değer; yoksa o gün 0). Aralık, son 28 günün artıklarından (gerçek − taban)
// çıkar. Eğilim ve yıllık mevsimsellik YOK; hızlı büyüyen ya da küçülen
// sitelerde sistematik sapma beklenir. Saf ve izomorfik.

export const FORECAST_MIN_HISTORY_DAYS = 56;
export const FORECAST_BASELINE_WEEKS = 8;
export const FORECAST_MIN_VALUES = 3;
export const FORECAST_RESIDUAL_DAYS = 28;
export const FORECAST_MIN_RESIDUALS = 14;
export const FORECAST_Z = 1.96;

export function metricValue(
  day: GaAnalysisDay,
  metric: ForecastMetric,
): number {
  switch (metric) {
    case "sessions":
      return day.sessions;
    case "keyEvents":
      return day.keyEvents;
    case "revenue":
      return day.revenue;
  }
}

// Gelir 2 ondalık, sayımlar tam sayı.
function roundMetric(metric: ForecastMetric, value: number): number {
  return metric === "revenue"
    ? Math.round(value * 100) / 100
    : Math.round(value);
}

// Bir günün tabanı: aynı haftanın günü değerlerinin medyanı; yoksa null.
function baselineOf(
  days: readonly GaAnalysisDay[],
  day: string,
  metric: ForecastMetric,
  exclude: ReadonlySet<string>,
): number | null {
  const baseline = sameWeekdayBaseline(
    days,
    day,
    (row) => metricValue(row, metric),
    {
      exclude,
      weeks: FORECAST_BASELINE_WEEKS,
      minValues: FORECAST_MIN_VALUES,
    },
  );
  return baseline ? median(baseline.values) : null;
}

// Örnek standart sapma (n-1); iki değerden azsa null.
function sampleSd(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function viewOf(
  input: {
    metric: ForecastMetric;
    through: string;
    dayOfMonth: number;
    daysInMonth: number;
    monthToDate: number;
  },
  basis: ForecastBasis,
  range: {
    forecast: number | null;
    low: number | null;
    high: number | null;
  },
): MonthForecastView {
  const round = (value: number | null) =>
    value === null ? null : roundMetric(input.metric, value);
  return {
    metric: input.metric,
    month: input.through.slice(0, 7),
    through: input.through,
    dayOfMonth: input.dayOfMonth,
    daysInMonth: input.daysInMonth,
    monthToDate: roundMetric(input.metric, input.monthToDate),
    forecast: round(range.forecast),
    low: round(range.low),
    high: round(range.high),
    basis,
  };
}

export function forecastMonthEnd(input: {
  days: readonly GaAnalysisDay[];
  metric: ForecastMetric;
  through: string;
  exclude: ReadonlySet<string>;
}): MonthForecastView {
  const { days, metric, through, exclude } = input;
  const first = monthStart(through);
  const last = monthEnd(through);
  const daysInMonth = daysInRange(first, last);
  const dayOfMonth = Number(through.slice(8, 10));

  // Şüpheli günler de ay başından bugüne toplama girer (AN15 gibi).
  let monthToDate = 0;
  for (const row of days) {
    if (row.day < first || row.day > through) continue;
    const value = metricValue(row, metric);
    if (Number.isFinite(value)) monthToDate += value;
  }
  const base = { metric, through, dayOfMonth, daysInMonth, monthToDate };
  const empty = { forecast: null, low: null, high: null };

  let firstDay: string | null = null;
  for (const row of days) {
    if (firstDay === null || row.day < firstDay) firstDay = row.day;
  }
  if (
    firstDay === null ||
    daysInRange(firstDay, through) < FORECAST_MIN_HISTORY_DAYS
  ) {
    return viewOf(base, "short_history", empty);
  }
  if (dayOfMonth >= daysInMonth) {
    return viewOf(base, "complete", {
      forecast: monthToDate,
      low: monthToDate,
      high: monthToDate,
    });
  }

  // Kalan günlerin beklentisi: tabanı olmayan gün 0 sayılır (AN15).
  let expected = 0;
  let withBaseline = 0;
  let remaining = 0;
  for (let day = addDays(through, 1); day <= last; day = addDays(day, 1)) {
    remaining += 1;
    const baseline = baselineOf(days, day, metric, exclude);
    if (baseline === null) continue;
    withBaseline += 1;
    expected += baseline;
  }
  if (withBaseline === 0) return viewOf(base, "no_baseline", empty);
  const forecast = monthToDate + expected;

  // Artıklar: bugüne kadarki son 28 uygun gün (hariç değil, tabanı var).
  const present = days
    .filter((row) => row.day <= through && !exclude.has(row.day))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const residuals: number[] = [];
  for (const row of present) {
    if (residuals.length >= FORECAST_RESIDUAL_DAYS) break;
    const baseline = baselineOf(days, row.day, metric, exclude);
    if (baseline === null) continue;
    residuals.push(metricValue(row, metric) - baseline);
  }
  const sd =
    residuals.length >= FORECAST_MIN_RESIDUALS ? sampleSd(residuals) : null;
  if (sd === null) {
    return viewOf(base, "ok", { forecast, low: null, high: null });
  }
  const half = FORECAST_Z * sd * Math.sqrt(remaining);
  return viewOf(base, "ok", {
    forecast,
    low: Math.max(monthToDate, forecast - half),
    high: forecast + half,
  });
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// Geriye dönük sınama: son `months` tam ayın her kontrol noktasında (ayın
// 10'u, 20'si) tahmin yapılır ve ay sonu gerçeğiyle karşılaştırılır. Gerçeği 0
// olan ya da tahmini çıkmayan nokta atlanır. Sahibin mülkünde ≤ %20 hedefi
// prisma/ga-forecast-backtest.ts ile doğrulanır.
export function backtestForecast(input: {
  days: readonly GaAnalysisDay[];
  metric: ForecastMetric;
  exclude: ReadonlySet<string>;
  checkpoints?: readonly number[];
  months?: number;
}): {
  rows: {
    month: string;
    checkpoint: number;
    forecast: number;
    actual: number;
    errorPct: number;
  }[];
  meanAbsErrorPct: number | null;
} {
  const { days, metric, exclude } = input;
  const checkpoints = input.checkpoints ?? [10, 20];
  const monthCount = input.months ?? 6;

  let latest: string | null = null;
  for (const row of days) {
    if (latest === null || row.day > latest) latest = row.day;
  }
  if (latest === null) return { rows: [], meanAbsErrorPct: null };

  // Son tam ay: veri ay sonuna kadar varsa o ay, yoksa bir önceki.
  let cursor =
    latest === monthEnd(latest) ? latest : addDays(monthStart(latest), -1);
  const present = new Set(days.map((row) => row.day));
  const rows: {
    month: string;
    checkpoint: number;
    forecast: number;
    actual: number;
    errorPct: number;
  }[] = [];
  const errors: number[] = [];

  for (let n = 0; n < monthCount; n++) {
    const month = cursor.slice(0, 7);
    const first = monthStart(cursor);
    const daysInMonth = daysInRange(first, monthEnd(cursor));
    cursor = addDays(first, -1);

    let monthDays = 0;
    let actual = 0;
    for (const row of days) {
      if (row.day < first || row.day > `${month}-${pad2(daysInMonth)}`)
        continue;
      monthDays += 1;
      actual += metricValue(row, metric);
    }
    // Eksik günlü ay gerçeği bozar.
    if (monthDays < daysInMonth || !(actual > 0)) continue;

    for (const checkpoint of checkpoints) {
      if (checkpoint >= daysInMonth) continue;
      const through = `${month}-${pad2(checkpoint)}`;
      if (!present.has(through)) continue;
      const view = forecastMonthEnd({
        days: days.filter((row) => row.day <= through),
        metric,
        through,
        exclude,
      });
      if (view.basis !== "ok" || view.forecast === null) continue;
      const errorPct = (Math.abs(view.forecast - actual) / actual) * 100;
      errors.push(errorPct);
      rows.push({
        month,
        checkpoint,
        forecast: view.forecast,
        actual: roundMetric(metric, actual),
        errorPct: Math.round(errorPct * 10) / 10,
      });
    }
  }

  // Eskiden yeniye; aynı ayda küçük kontrol noktası önce.
  rows.sort((a, b) =>
    a.month === b.month
      ? a.checkpoint - b.checkpoint
      : a.month < b.month
        ? -1
        : 1,
  );
  const meanAbsErrorPct =
    errors.length > 0
      ? Math.round(
          (errors.reduce((sum, value) => sum + value, 0) / errors.length) * 10,
        ) / 10
      : null;
  return { rows, meanAbsErrorPct };
}
