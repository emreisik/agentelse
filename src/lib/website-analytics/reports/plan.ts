import { daysInRange, monthEnd } from "@/lib/website-analytics/days";

import {
  WEBSITE_GOAL_KEYS,
  WEBSITE_GOAL_LABEL,
  goalFormatOf,
  goalMetricOf,
  roundGoalValue,
  type GaWebsiteGoalKey,
} from "./goal-keys";
import { WEBSITE_REPORT_COPY, monthLabel, reportTitle } from "./copy";
import { reportHrefs } from "./ids";
import { previousMonthKey } from "./schedule";
import {
  bestConvertingPages,
  channelQualityTable,
  findingSnap,
  forecastSnaps,
} from "./sections";
import {
  REPORT_CAPS,
  WEBSITE_REPORT_CARD_KIND,
  type PlanBody,
  type PlanMonthTotals,
  type PlanReportInput,
  type PlanTargetProposal,
  type WebsiteReportCardData,
} from "./types";

// Gelecek ay planı (docs/website-reports.md "Plan"). Önerilen hedef = son 3
// tam ayın günlük ortalaması × hedef ayın gün sayısı × mevsimsellik × +%10;
// aralık +%10 ile +%15 arasıdır. Hedefi kullanıcı "Use these targets" ile
// yazar; burada yalnız öneri hesaplanır. Saf ve izomorfik.

export const PLAN_MIN_MONTHS = 2;
export const PLAN_BASELINE_MONTHS = 3;
export const PLAN_UPLIFT_LOW = 0.1;
export const PLAN_UPLIFT_HIGH = 0.15;
export const PLAN_SEASONAL_MIN = 0.7;
export const PLAN_SEASONAL_MAX = 1.4;

// Tabanı bu değerin altında kalan ölçüm için hedef önerilmez (aylık).
const MIN_BASELINE = {
  "web.sessions": 30,
  "web.key_events": 10,
  "web.revenue": 0,
} as const satisfies Record<GaWebsiteGoalKey, number>;

// İki anlamlı basamağa yuvarlar: 3,287 → 3,300; 0'a düşmez (değer > 0 ise).
export function niceTarget(value: number, format: "count" | "money"): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
  const rounded = Math.round(value / magnitude) * magnitude;
  if (format === "count") return Math.max(1, Math.round(rounded));
  const money = Math.round(rounded * 100) / 100;
  return money > 0 ? money : 0.01;
}

type PlanGoal = {
  id: string;
  metricKey: GaWebsiteGoalKey;
  targetValue: number | null;
};

function monthDaily(
  month: PlanMonthTotals,
  metric: "sessions" | "keyEvents" | "revenue",
): number {
  return month[metric] / month.daysInMonth;
}

function isComplete(month: PlanMonthTotals): boolean {
  return month.daysInMonth > 0 && month.days === month.daysInMonth;
}

// Geçen yılın hedef ayı ile ondan önceki 3 ayın günlük ortalamaları; hepsi
// tam değilse mevsimsellik yok (null).
function seasonalFactor(
  month: string,
  metric: "sessions" | "keyEvents" | "revenue",
  byMonth: ReadonlyMap<string, PlanMonthTotals>,
): { factor: number; pct: number } | null {
  const year = Number(month.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  const lastYearKey = `${year - 1}${month.slice(4)}`;
  const lastYear = byMonth.get(lastYearKey);
  if (!lastYear) return null;
  const before: PlanMonthTotals[] = [];
  let key = lastYearKey;
  for (let step = 0; step < PLAN_BASELINE_MONTHS; step++) {
    key = previousMonthKey(key);
    const row = byMonth.get(key);
    if (!row) return null;
    before.push(row);
  }
  const mean =
    before.reduce((sum, row) => sum + monthDaily(row, metric), 0) /
    before.length;
  if (!(mean > 0)) return null;
  const raw = monthDaily(lastYear, metric) / mean;
  const factor = Math.min(PLAN_SEASONAL_MAX, Math.max(PLAN_SEASONAL_MIN, raw));
  return { factor, pct: Math.round((factor - 1) * 1000) / 10 };
}

export function proposeTargets(input: {
  month: string;
  months: readonly PlanMonthTotals[];
  goals: readonly PlanGoal[];
}): { proposals: PlanTargetProposal[]; note: string | null } {
  const complete = input.months.filter(isComplete);
  const byMonth = new Map(complete.map((row) => [row.month, row]));
  const base = complete
    .filter((row) => row.month < input.month)
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
    .slice(-PLAN_BASELINE_MONTHS);
  if (base.length < PLAN_MIN_MONTHS) {
    return { proposals: [], note: WEBSITE_REPORT_COPY.planNeedMonths };
  }
  const targetDays = daysInRange(
    `${input.month}-01`,
    monthEnd(`${input.month}-01`),
  );

  const proposals: PlanTargetProposal[] = [];
  for (const key of WEBSITE_GOAL_KEYS) {
    const metric = goalMetricOf(key);
    const daily =
      base.reduce((sum, row) => sum + monthDaily(row, metric), 0) / base.length;
    const baseline = daily * targetDays;
    // Oturum 30, anahtar olay 10 altında kalan taban atlanır; gelir > 0 olmalı.
    if (key === "web.revenue" ? !(baseline > 0) : baseline < MIN_BASELINE[key]) {
      continue;
    }
    const seasonal = seasonalFactor(input.month, metric, byMonth);
    const factor = seasonal?.factor ?? 1;
    const realistic = baseline * factor;
    const format = goalFormatOf(key);
    const round = (value: number) => roundGoalValue(key, value);
    const low = round(realistic * (1 + PLAN_UPLIFT_LOW));
    const high = round(realistic * (1 + PLAN_UPLIFT_HIGH));
    const goal = input.goals.find((row) => row.metricKey === key);
    proposals.push({
      metricKey: key,
      label: WEBSITE_GOAL_LABEL[key],
      format,
      baseline: round(baseline),
      baselineMonths: base.length,
      seasonalPct: seasonal?.pct ?? null,
      realistic: round(realistic),
      low,
      high,
      suggested: niceTarget(low, format),
      currentGoal: goal ? { goalId: goal.id, target: goal.targetValue } : null,
    });
  }
  return {
    proposals,
    note: proposals.length === 0 ? WEBSITE_REPORT_COPY.planNoMetrics : null,
  };
}

export function buildPlanCard(input: PlanReportInput): WebsiteReportCardData {
  const { link } = input;
  const hrefs = reportHrefs(link.projectId, input.websitePage);
  const { proposals, note } = proposeTargets({
    month: input.month,
    months: input.months,
    goals: input.goals,
  });
  const body: PlanBody = {
    variant: "plan",
    month: input.month,
    proposals: proposals.slice(0, REPORT_CAPS.proposals),
    proposalNote: note,
    topFindings: input.findings
      .slice(0, REPORT_CAPS.opportunities)
      .map((view) =>
        findingSnap(view, {
          currency: link.currency,
          timeZone: link.timeZone,
          href: hrefs.finding(view.id),
        }),
      ),
    bestPages: bestConvertingPages(input.window28.landing, {
      limit: REPORT_CAPS.bestPages,
    }),
    channelQuality: channelQualityTable(
      input.window28.channel,
      input.window28.totals,
    ),
    forecasts: forecastSnaps(input.forecasts),
  };
  return {
    kind: WEBSITE_REPORT_CARD_KIND,
    v: 1,
    variant: "plan",
    title: reportTitle("plan", { month: input.month }),
    projectId: link.projectId,
    linkId: link.linkId,
    propertyName: link.propertyName,
    periodLabel: monthLabel(input.month),
    timeZone: link.timeZone,
    currency: link.currency,
    builtAt: input.builtAt,
    dataThrough: link.dataThrough === "" ? null : link.dataThrough,
    preliminary: false,
    isMock: link.isMock,
    body,
    narrative: null,
    narrativeNote: null,
  };
}
