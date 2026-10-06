import { addMonths } from "@/lib/seo/dates";

import { linearTrend } from "./goals";
import type { MonthlyPoint, SearchForecast } from "./types";

// Gelecek ay tıklama tahmini (docs/search-reports.md "Tahmin"). Saf.
// - Mevsimsel: hedeften önceki 15 tam ay varsa (hedef−12, son 3 ay ve bir yıl
//   önceki aynı 3 ay) geçen yılın aynı ayının günlük hızı, son 3 ayın geçen
//   yılın aynı 3 ayına oranıyla ölçeklenir.
// - Aksi halde eğilim: son 3 ayın günlük hız ortalaması + son ≤ 6 ay doğrusunun
//   eğiminin yarısı.
// Aralık: ±max(%15, aynı yöntemin son ≤ 6 aylık geriye dönük sınamasının
// ortalama mutlak yüzde hatası); sınama noktası yoksa %25.

export const FORECAST_MIN_MONTHS = 3;
export const FORECAST_SEASONAL_MONTHS = 15;
export const FORECAST_MIN_ERROR = 0.15;
export const FORECAST_DEFAULT_ERROR = 0.25;
export const FORECAST_BACKTEST_MONTHS = 6;

const TREND_RATE_MONTHS = 3;
const TREND_SLOPE_MONTHS = 6;
const TREND_SLOPE_WEIGHT = 0.5;

// "2026-02-01" → 28.
export function daysInMonth(monthStart: string): number {
  const [year, month] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 0)).getUTCDate();
}

function rateOf(point: MonthlyPoint): number {
  return point.days > 0 ? point.value / point.days : 0;
}

type Method = "seasonal" | "trend";

// Hedef ay için yöntemin günlük hızı; hesaplanamıyorsa null.
function seasonalRate(
  byMonth: ReadonlyMap<string, MonthlyPoint>,
  target: string,
): number | null {
  const sameMonth = byMonth.get(addMonths(target, -12));
  if (!sameMonth || sameMonth.value <= 0) return null;
  let recent = 0;
  let lastYear = 0;
  for (let back = 1; back <= 3; back++) {
    const near = byMonth.get(addMonths(target, -back));
    const far = byMonth.get(addMonths(target, -12 - back));
    if (!near || !far || near.value <= 0 || far.value <= 0) return null;
    recent += near.value;
    lastYear += far.value;
  }
  return rateOf(sameMonth) * (recent / lastYear);
}

function trendRate(points: readonly MonthlyPoint[]): number | null {
  if (points.length < FORECAST_MIN_MONTHS) return null;
  const rates = points.map(rateOf);
  const last = rates.slice(-TREND_RATE_MONTHS);
  const mean = last.reduce((sum, rate) => sum + rate, 0) / last.length;
  const fit = linearTrend(rates.slice(-TREND_SLOPE_MONTHS));
  const slope = fit ? fit.slope : 0;
  return Math.max(0, mean + TREND_SLOPE_WEIGHT * slope);
}

function rateFor(
  method: Method,
  points: readonly MonthlyPoint[],
  target: string,
): number | null {
  if (method === "seasonal") {
    const byMonth = new Map(points.map((point) => [point.month, point]));
    return seasonalRate(byMonth, target);
  }
  return trendRate(points);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function forecastMonth(input: {
  metric: "nonBrandClicks" | "clicks";
  history: readonly MonthlyPoint[];
  target: string;
}): Omit<SearchForecast, "newContent"> | null {
  const points = [...input.history]
    .filter((point) => point.month < input.target)
    .sort((a, b) => a.month.localeCompare(b.month));
  if (points.length < FORECAST_MIN_MONTHS) return null;

  const seasonal = rateFor("seasonal", points, input.target);
  const method: Method = seasonal !== null ? "seasonal" : "trend";
  const rate = seasonal ?? trendRate(points);
  if (rate === null) return null;

  const value = Math.round(rate * daysInMonth(input.target));

  // Geriye dönük sınama: son ≤ 6 ay, yalnız o aydan önceki aylarla ve AYNI
  // yöntemle; hesaplanamayan noktalar atlanır.
  const errors: number[] = [];
  for (const point of points.slice(-FORECAST_BACKTEST_MONTHS)) {
    if (point.value <= 0) continue;
    const before = points.filter((p) => p.month < point.month);
    const predictedRate = rateFor(method, before, point.month);
    if (predictedRate === null) continue;
    const predicted = Math.round(predictedRate * daysInMonth(point.month));
    errors.push(Math.abs(predicted - point.value) / point.value);
  }
  const errorPct =
    errors.length > 0
      ? Math.max(
          FORECAST_MIN_ERROR,
          errors.reduce((sum, e) => sum + e, 0) / errors.length,
        )
      : FORECAST_DEFAULT_ERROR;
  // errorPct 0..1 aralığındadır; düşük sınırı sıfırın altına inmesin diye.
  const error = round3(Math.min(1, errorPct));

  return {
    metric: input.metric,
    month: input.target,
    value,
    low: Math.max(0, Math.round(value * (1 - error))),
    high: Math.round(value * (1 + error)),
    method,
    historyMonths: points.length,
    errorPct: error,
  };
}
