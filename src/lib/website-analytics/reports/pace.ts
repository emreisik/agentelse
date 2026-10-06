import {
  addDays,
  daysInRange,
  monthEnd,
  monthStart,
} from "@/lib/website-analytics/days";
import { sameWeekdayBaseline } from "@/lib/website-analytics/analysis/baseline";
import { median } from "@/lib/website-analytics/analysis/stats";
import type {
  GaAnalysisDay,
  GaWebsiteGoalKey,
} from "@/lib/website-analytics/analysis/types";

import {
  FORECAST_BASELINE_WEEKS,
  FORECAST_MIN_VALUES,
  metricValue,
} from "./forecast";
import { goalMetricOf, roundGoalValue } from "./goal-keys";
import type {
  ForecastBasis,
  ForecastMetric,
  GoalPace,
  GoalProgressView,
} from "./types";

// Hedef hızı (docs/website-reports.md "Hedefler"). Hız saklanmaz: okuma
// anında hedefin GÜNCEL değeriyle hesaplanır, böylece Brand Brain'de düzenlenen
// hedef hemen yansır. Saf ve izomorfik.

export const PACE_ON_TRACK = 0.9;
export const PACE_AT_RISK = 0.7;
export const PACE_MIN_DAY = 5;

// Ayın `through` gününe kadar beklenen payı: haftanın günü ağırlıklı. Ağırlık,
// ayın her günü için aynı haftanın günü medyanıdır; tabanı olmayan gün
// tabanı olanların ortalamasını alır, hiç taban yoksa ağırlıklar eşittir.
export function expectedShareToDate(input: {
  days: readonly GaAnalysisDay[];
  metric: ForecastMetric;
  through: string;
  exclude: ReadonlySet<string>;
}): number | null {
  const { days, metric, through, exclude } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through)) return null;
  const first = monthStart(through);
  const last = monthEnd(through);
  const dayCount = daysInRange(first, last);

  const raw: (number | null)[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
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
    raw.push(baseline ? median(baseline.values) : null);
  }
  const known = raw.filter((value): value is number => value !== null);
  const mean =
    known.length > 0
      ? known.reduce((sum, value) => sum + value, 0) / known.length
      : 0;
  let weights = raw.map((value) => value ?? mean);
  // Tüm ağırlıklar 0 ya da hiç yoksa her gün eşit sayılır.
  if (!(weights.reduce((sum, value) => sum + value, 0) > 0)) {
    weights = weights.map(() => 1);
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  const elapsed = Math.min(Number(through.slice(8, 10)), dayCount);
  const done = weights.slice(0, elapsed).reduce((sum, value) => sum + value, 0);
  const share = Math.min(1, Math.max(0, done / total));
  return Math.round(share * 10_000) / 10_000;
}

export function goalPace(input: {
  target: number | null;
  monthToDate: number;
  forecast: number | null;
  expectedToDate: number | null;
  dayOfMonth: number;
}): { pace: GoalPace; ratio: number | null } {
  const { target, monthToDate, forecast, expectedToDate, dayOfMonth } = input;
  if (target === null || !Number.isFinite(target) || target <= 0) {
    return { pace: "unknown", ratio: null };
  }
  // Hedefe varılmışsa tahmine bakılmaz.
  if (monthToDate >= target) {
    return {
      pace: "achieved",
      ratio: Math.round((monthToDate / target) * 10_000) / 10_000,
    };
  }
  if (dayOfMonth < PACE_MIN_DAY) return { pace: "early", ratio: null };
  const raw =
    forecast !== null
      ? forecast / target
      : expectedToDate !== null && expectedToDate > 0
        ? monthToDate / expectedToDate
        : null;
  if (raw === null || !Number.isFinite(raw)) {
    return { pace: "unknown", ratio: null };
  }
  const ratio = Math.round(raw * 10_000) / 10_000;
  // Sınıflama gösterilen (yuvarlanmış) orana göre yapılır.
  const pace: GoalPace =
    ratio >= PACE_ON_TRACK
      ? "on_track"
      : ratio >= PACE_AT_RISK
        ? "at_risk"
        : "behind";
  return { pace, ratio };
}

export function paceLabel(pace: GoalPace): string {
  switch (pace) {
    case "achieved":
      return "Achieved";
    case "on_track":
      return "On track";
    case "at_risk":
      return "At risk";
    case "behind":
      return "Behind";
    case "early":
      return "Too early to tell";
    case "unknown":
      return "No forecast yet";
  }
}

export function paceTone(pace: GoalPace): "good" | "warn" | "bad" | "neutral" {
  switch (pace) {
    case "achieved":
    case "on_track":
      return "good";
    case "at_risk":
      return "warn";
    case "behind":
      return "bad";
    case "early":
    case "unknown":
      return "neutral";
  }
}

type PaceGoal = {
  id: string;
  title: string;
  status: string;
  metricKey: GaWebsiteGoalKey;
  targetValue: number | null;
};

export function progressViewOf(input: {
  goal: PaceGoal;
  progress: {
    month: string;
    through: string;
    dayOfMonth: number;
    daysInMonth: number;
    monthToDate: number;
    expectedShare: number | null;
    forecast: number | null;
    forecastLow: number | null;
    forecastHigh: number | null;
    forecastBasis: ForecastBasis;
    updatedAt: string;
  };
}): GoalProgressView {
  const { goal, progress } = input;
  const target = goal.targetValue;
  const expectedToDate =
    progress.expectedShare !== null && target !== null
      ? progress.expectedShare * target
      : null;
  const { pace, ratio } = goalPace({
    target,
    monthToDate: progress.monthToDate,
    forecast: progress.forecast,
    expectedToDate,
    dayOfMonth: progress.dayOfMonth,
  });
  return {
    goalId: goal.id,
    title: goal.title,
    status: goal.status,
    metricKey: goal.metricKey,
    target,
    month: progress.month,
    through: progress.through,
    dayOfMonth: progress.dayOfMonth,
    daysInMonth: progress.daysInMonth,
    monthToDate: progress.monthToDate,
    expectedToDate,
    forecast: progress.forecast,
    forecastLow: progress.forecastLow,
    forecastHigh: progress.forecastHigh,
    forecastBasis: progress.forecastBasis,
    pace,
    paceRatio: ratio,
    updatedAt: progress.updatedAt,
  };
}

// Biten ayın sonucu: aylık raporda hedefler yuvarlanan ilerleme satırlarından
// değil, ayın günlük toplamlarından hesaplanır.
export function finalGoalProgress(input: {
  goals: readonly PaceGoal[];
  month: string;
  totals: Readonly<Record<ForecastMetric, number>>;
  updatedAt: string;
}): GoalProgressView[] {
  const { month, totals, updatedAt } = input;
  const first = `${month}-01`;
  const last = monthEnd(first);
  const daysInMonth = daysInRange(first, last);
  return input.goals.map((goal) => {
    const value = roundGoalValue(
      goal.metricKey,
      totals[goalMetricOf(goal.metricKey)],
    );
    const target = goal.targetValue;
    const { pace, ratio } = goalPace({
      target,
      monthToDate: value,
      forecast: value,
      expectedToDate: target,
      dayOfMonth: daysInMonth,
    });
    return {
      goalId: goal.id,
      title: goal.title,
      status: goal.status,
      metricKey: goal.metricKey,
      target,
      month,
      through: last,
      dayOfMonth: daysInMonth,
      daysInMonth,
      monthToDate: value,
      expectedToDate: target,
      forecast: value,
      forecastLow: value,
      forecastHigh: value,
      forecastBasis: "complete",
      pace,
      paceRatio: ratio,
      updatedAt,
    };
  });
}
