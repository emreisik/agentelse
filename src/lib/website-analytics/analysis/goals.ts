import {
  addDays,
  daysInRange,
  monthEnd,
  monthStart,
} from "@/lib/website-analytics/days";

import { sameWeekdayBaseline } from "./baseline";
import { GaSubjects, periodOf } from "./keys";
import { median } from "./stats";
import type {
  An15Evidence,
  GaAnalysisDay,
  GaDailyAnalysisInput,
  GaDecompositionMetric,
  GaFindingCandidate,
  GaWebsiteGoalKey,
} from "./types";

// AN15: aylık hedefe gidiş (docs/google-analytics-plan.md §6.2; ayrıntı
// docs/website-insights.md "AN15"). Hedef değeri mülk saatinde takvim ayı
// hedefidir (ProjectGoal'da dönem sütunu yok; GA-F5 bu hedefleri yaratana
// dek kural uykudadır). Ayın 5'inden önce ya da ayda şüpheli gün varken
// değerlendirilmez. Tahmin = ay başından bugüne toplam + kalan her gün için
// aynı haftanın günü medyanı (8 hafta, tatil ve şüpheli günler hariç). Hız
// < 0.9 ise risk. Saf.

const MIN_DAY_OF_MONTH = 5;
const BASELINE_WEEKS = 8;
const BASELINE_MIN_VALUES = 3;
const PACE_RISK = 0.9;
const PACE_SIGNIFICANT = 0.8;
const PACE_WARN = 0.75;

const GOAL_METRICS: Record<GaWebsiteGoalKey, GaDecompositionMetric> = {
  "web.sessions": "sessions",
  "web.key_events": "keyEvents",
  "web.revenue": "revenue",
};

function metricOfGoal(key: string): GaDecompositionMetric | null {
  return Object.prototype.hasOwnProperty.call(GOAL_METRICS, key)
    ? GOAL_METRICS[key as GaWebsiteGoalKey]
    : null;
}

function pickOf(metric: GaDecompositionMetric): (day: GaAnalysisDay) => number {
  switch (metric) {
    case "sessions":
      return (day) => day.sessions;
    case "keyEvents":
      return (day) => day.keyEvents;
    case "revenue":
      return (day) => day.revenue;
  }
}

export function evaluateGoalPace(input: GaDailyAnalysisInput): {
  candidates: GaFindingCandidate[];
  evaluated: { goalId: string; month: string }[];
} {
  const candidates: GaFindingCandidate[] = [];
  const evaluated: { goalId: string; month: string }[] = [];
  const through = input.targets[input.targets.length - 1];
  if (!through || input.goals.length === 0) return { candidates, evaluated };

  const month = through.slice(0, 7);
  const first = monthStart(through);
  const last = monthEnd(through);
  const dayOfMonth = Number(through.slice(8, 10));
  if (!(dayOfMonth >= MIN_DAY_OF_MONTH)) return { candidates, evaluated };
  // Ayın değerlendirilen kısmında şüpheli gün varsa ay hiç değerlendirilmez.
  for (let day = first; day <= through; day = addDays(day, 1)) {
    if (input.suspect.has(day)) return { candidates, evaluated };
  }

  const exclude = new Set([...input.suspect, ...input.holidays]);
  const daysInMonth = daysInRange(first, last);
  const monthDays = input.days.filter(
    (day) => day.day >= first && day.day <= through,
  );

  for (const goal of input.goals) {
    const metric = metricOfGoal(goal.metricKey);
    if (!metric || !Number.isFinite(goal.target) || goal.target <= 0) continue;
    evaluated.push({ goalId: goal.id, month });

    const pick = pickOf(metric);
    const monthToDate = monthDays.reduce((sum, day) => sum + pick(day), 0);
    let expected = 0;
    for (let day = addDays(through, 1); day <= last; day = addDays(day, 1)) {
      const baseline = sameWeekdayBaseline(input.days, day, pick, {
        exclude,
        weeks: BASELINE_WEEKS,
        minValues: BASELINE_MIN_VALUES,
      });
      expected += (baseline ? median(baseline.values) : null) ?? 0;
    }
    const forecast = monthToDate + expected;
    const paceRatio = forecast / goal.target;
    if (!(paceRatio < PACE_RISK)) continue;

    const perWeek = ((goal.target - forecast) * 7) / daysInMonth;
    const evidence: An15Evidence = {
      v: 1,
      rule: "AN15",
      goalId: goal.id,
      goalTitle: goal.title,
      metricKey: goal.metricKey,
      month,
      target: goal.target,
      monthToDate,
      forecast,
      paceRatio,
      dayOfMonth,
      daysInMonth,
      through,
    };
    candidates.push({
      ruleKey: "AN15",
      kind: "RISK",
      subject: GaSubjects.goal(goal.id),
      period: periodOf("MONTH", { from: first, to: last }),
      severity: paceRatio < PACE_WARN ? "WARN" : "INFO",
      confidence: paceRatio < PACE_SIGNIFICANT ? "SIGNIFICANT" : "DIRECTIONAL",
      evidence,
      impact: {
        metric,
        perWeek,
        low: perWeek,
        high: perWeek,
        directional: true,
      },
      impactShare: (goal.target - forecast) / goal.target,
    });
  }
  return { candidates, evaluated };
}
