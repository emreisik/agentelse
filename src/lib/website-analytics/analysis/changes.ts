import { addDays } from "@/lib/website-analytics/days";

import { daysIn } from "./baseline";
import { decompose, decompositionRows } from "./decompose";
import { GaSubjects, periodOf } from "./keys";
import { poissonRateTest } from "./stats";
import type {
  An2Evidence,
  GaAnalysisDay,
  GaDecompositionMetric,
  GaFindingCandidate,
  GaPeriod,
  GaRange,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

// AN2: dönem değişimi ve ayrıştırması (docs/google-analytics-plan.md §6.2;
// ayrıntı docs/website-insights.md "AN2"). WoW (geçen hafta), YoY (geçen
// yılın aynı haftası, veri varsa) ve MoM (gün başına normalleştirilmiş).
// Fark kanallara ve site geneli ilk 10 giriş sayfasına ayrılır; residual
// kırpılan satırları taşıdığından bileşenler her zaman toplam farka eşittir.
// Bulgu yalnız anlamlı değişimde yazılır (Poisson p < 0.05 ve |Δ%| ≥ 10),
// iki aralıkta da tatil ya da şüpheli gün yoksa ve WoW geçen yılın aynı
// haftasıyla örtüşmüyorsa. Yön göstergesi olan değişimler sohbetteki
// explain_website_change'e kalır. Saf.

export type GaChangeSignificance =
  "significant" | "not_significant" | "low_volume";

const MIN_KEY_EVENTS = 30;
const MIN_COUNTS = 20;
const MIN_TRANSACTIONS = 10;
const P_THRESHOLD = 0.05;
const MIN_CHANGE_PCT = 10;
const WARN_DROP_PCT = 25;
// Kayan nokta payı: %10 sınırı tam 10 olarak okunur.
const EPSILON = 1e-9;

// channel ve landing tabloları: [sessions, engagedSessions, keyEvents, totalRevenue, …]
const VALUE_INDEX: Record<GaDecompositionMetric, number> = {
  sessions: 0,
  keyEvents: 2,
  revenue: 3,
};

function totalOf(
  tables: GaWindowTables,
  metric: GaDecompositionMetric,
): number {
  switch (metric) {
    case "sessions":
      return tables.totals.sessions;
    case "keyEvents":
      return tables.totals.keyEvents;
    case "revenue":
      return tables.totals.revenue;
  }
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

function rangeOf(tables: GaWindowTables): GaRange {
  return { from: tables.from, to: tables.to };
}

export function explainChange(input: {
  metric: GaDecompositionMetric | "auto";
  comparison: "wow" | "mom" | "yoy" | "custom";
  current: GaWindowTables;
  previous: GaWindowTables;
  perDay: boolean;
  holidays: readonly string[];
  suspectDays: readonly string[];
  seasonal: { lastYearChangePct: number } | null;
  preliminary?: boolean;
}): { evidence: An2Evidence; significance: GaChangeSignificance } {
  const { current, previous } = input;
  // KE az ise (iki dönemde de < 30) ziyaret ölçülür.
  const fewKeyEvents =
    Math.max(current.totals.keyEvents, previous.totals.keyEvents) <
    MIN_KEY_EVENTS;
  let metric: GaDecompositionMetric;
  let metricReason: An2Evidence["metricReason"] = "requested";
  if (input.metric === "auto") {
    metric = fewKeyEvents ? "sessions" : "keyEvents";
  } else if (input.metric === "keyEvents" && fewKeyEvents) {
    metric = "sessions";
    metricReason = "low_key_events";
  } else {
    metric = input.metric;
  }

  const currentTotal = totalOf(current, metric);
  const previousTotal = totalOf(previous, metric);
  const perDay = input.perDay
    ? { before: previous.days, after: current.days }
    : undefined;
  const index = { sessions: 0, value: VALUE_INDEX[metric] };

  const channels = decompose({
    metric,
    dimension: "channel",
    rows: decompositionRows(previous.channel, current.channel, index),
    totalBefore: previousTotal,
    totalAfter: currentTotal,
    perDay,
  });
  // Sayfa toplamları da pencere toplamıdır: residual kırpılan sayfaları taşır.
  const pages =
    previous.landing.length > 0 && current.landing.length > 0
      ? decompose({
          metric,
          dimension: "landingPage",
          rows: decompositionRows(previous.landing, current.landing, index),
          totalBefore: previousTotal,
          totalAfter: currentTotal,
          perDay,
        })
      : null;

  // Değişim gün başına normalleştirilmiş değerlerden (perDay yoksa ham).
  const change = channels.delta;
  const changePct =
    channels.before > 0 ? (change / channels.before) * 100 : null;

  // Gelirde test işlem sayısı üzerindendir.
  const counts =
    metric === "revenue"
      ? {
          after: current.totals.transactions,
          before: previous.totals.transactions,
        }
      : { after: currentTotal, before: previousTotal };
  const test = poissonRateTest(
    counts.after,
    counts.before,
    current.days,
    previous.days,
  );
  const lowVolume =
    counts.after + counts.before < MIN_COUNTS ||
    (metric === "revenue" &&
      counts.after < MIN_TRANSACTIONS &&
      counts.before < MIN_TRANSACTIONS);
  const significance: GaChangeSignificance = lowVolume
    ? "low_volume"
    : test !== null &&
        test.p < P_THRESHOLD &&
        changePct !== null &&
        Math.abs(changePct) >= MIN_CHANGE_PCT - EPSILON
      ? "significant"
      : "not_significant";

  const evidence: An2Evidence = {
    v: 1,
    rule: "AN2",
    comparison: input.comparison === "custom" ? "wow" : input.comparison,
    metric,
    metricReason,
    current: {
      from: current.from,
      to: current.to,
      days: current.days,
      total: currentTotal,
    },
    previous: {
      from: previous.from,
      to: previous.to,
      days: previous.days,
      total: previousTotal,
    },
    change,
    changePct,
    z: test?.z ?? null,
    p: test?.p ?? null,
    channels,
    pages,
    holidays: [...input.holidays].sort(),
    suspectDays: [...input.suspectDays].sort(),
    seasonal: input.seasonal,
    preliminary: input.preliminary ?? false,
  };
  return { evidence, significance };
}

// Geçen yılın hizalı haftası (−364) ile ondan önceki hafta (−371).
export function seasonalWow(
  days: readonly GaAnalysisDay[],
  week: { monday: string; sunday: string },
  metric: GaDecompositionMetric,
): { lastYearChangePct: number } | null {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const pick = pickOf(metric);
  const sumWeek = (monday: string): number | null => {
    let sum = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      const day = byDay.get(addDays(monday, offset));
      if (!day) return null;
      sum += pick(day);
    }
    return sum;
  };
  const current = sumWeek(addDays(week.monday, -364));
  const previous = sumWeek(addDays(week.monday, -371));
  if (current === null || previous === null || previous <= 0) return null;
  return { lastYearChangePct: ((current - previous) / previous) * 100 };
}

function seasonalMatches(evidence: An2Evidence): boolean {
  const { seasonal, changePct } = evidence;
  if (!seasonal || changePct === null) return false;
  return (
    Math.sign(seasonal.lastYearChangePct) === Math.sign(changePct) &&
    Math.abs(seasonal.lastYearChangePct) >= 0.5 * Math.abs(changePct)
  );
}

function preliminaryOf(
  days: readonly GaAnalysisDay[],
  range: GaRange,
): boolean {
  return days.some(
    (day) => day.day >= range.from && day.day <= range.to && !day.isFinal,
  );
}

function candidateOf(
  evidence: An2Evidence,
  period: GaPeriod,
): GaFindingCandidate {
  const drop =
    evidence.changePct !== null && evidence.changePct <= -WARN_DROP_PCT;
  // MoM'da değişim gün başınadır; pay da gün başına önceki değere göre.
  const previousBase = evidence.channels.before;
  return {
    ruleKey: "AN2",
    kind: "CHANGE",
    subject: GaSubjects.change(evidence.metric, evidence.comparison),
    period,
    severity: drop ? "WARN" : "INFO",
    confidence: "SIGNIFICANT",
    evidence,
    impact: null,
    impactShare: Math.abs(evidence.change) / Math.max(1, previousBase),
  };
}

export function evaluateChanges(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate[] {
  const comparisons: {
    comparison: "wow" | "yoy" | "mom";
    current: GaWindowTables;
    previous: GaWindowTables;
    perDay: boolean;
    period: GaPeriod;
  }[] = [
    {
      comparison: "wow",
      current: input.current,
      previous: input.previous,
      perDay: false,
      period: periodOf("WEEK", rangeOf(input.current), "wow"),
    },
  ];
  if (input.lastYear) {
    comparisons.push({
      comparison: "yoy",
      current: input.current,
      previous: input.lastYear,
      perDay: false,
      period: periodOf("WEEK", rangeOf(input.current), "yoy"),
    });
  }
  if (input.month) {
    comparisons.push({
      comparison: "mom",
      current: input.month.current,
      previous: input.month.previous,
      perDay: true,
      period: periodOf("MONTH", rangeOf(input.month.current), "mom"),
    });
  }

  const candidates: GaFindingCandidate[] = [];
  for (const item of comparisons) {
    const ranges = [rangeOf(item.current), rangeOf(item.previous)];
    const holidays = ranges.flatMap((range) => daysIn(range, input.holidays));
    const suspectDays = ranges.flatMap((range) => daysIn(range, input.suspect));
    const result = explainChange({
      metric: "auto",
      comparison: item.comparison,
      current: item.current,
      previous: item.previous,
      perDay: item.perDay,
      holidays: [...new Set(holidays)],
      suspectDays: [...new Set(suspectDays)],
      seasonal: null,
      preliminary: preliminaryOf(input.days, rangeOf(item.current)),
    });
    const evidence: An2Evidence =
      item.comparison === "wow"
        ? {
            ...result.evidence,
            seasonal: seasonalWow(
              input.days,
              input.week,
              result.evidence.metric,
            ),
          }
        : result.evidence;
    if (result.significance !== "significant") continue;
    if (evidence.holidays.length > 0 || evidence.suspectDays.length > 0) {
      continue;
    }
    if (item.comparison === "wow" && seasonalMatches(evidence)) continue;
    candidates.push(candidateOf(evidence, item.period));
  }
  return candidates;
}
