import { addDays } from "@/lib/website-analytics/days";

import { metricOfDay, sameWeekdayBaseline, weeklySums } from "./baseline";
import { decompose, decompositionRows } from "./decompose";
import { GaSubjects, periodOf } from "./keys";
import { median, robustZ } from "./stats";
import type {
  GaAn1DayOutcome,
  GaAnalysisDay,
  GaAnomalyMetric,
  GaAnomalyReading,
  GaDailyAnalysisInput,
  GaDecomposition,
  GaDecompositionMetric,
  GaFindingCandidate,
  GaFindingConfidence,
  GaFindingSeverity,
  GaWeeklyAnalysisInput,
} from "./types";

// AN1: günlük anomali (docs/google-analytics-plan.md §6.2; ayrıntı
// docs/website-insights.md "AN1"). Hedef gün, aynı haftanın gününün son 8
// haftalık medyanına göre robust z ile ölçülür (MAD; küçük sitede Poisson
// tabanı). Tatil ve şüpheli günler tabandan çıkar; hedef gün tatil ya da
// şüpheliyse hiç değerlendirilmez. Geçen yılın aynı hizadaki günü (−364)
// aynı yönde olağandışıysa mevsimsel sayılıp bulgu düşer. Hacmi düşük
// sitelerde günlük kapıdan geçemeyen metrikler haftalık modda (site:week)
// değerlendirilir. Saf; eksik veride boş sonuç döner.

const METRIC_ORDER: readonly GaAnomalyMetric[] = [
  "keyEvents",
  "sessions",
  "revenue",
  "engagedSessions",
  "keyEventRate",
];
const WEEKLY_METRICS: readonly ("keyEvents" | "sessions")[] = [
  "keyEvents",
  "sessions",
];

const BASELINE_WEEKS = 8;
const BASELINE_MIN_VALUES = 4;
const SEASONAL_WEEKS = 4;
const SEASONAL_MIN_VALUES = 3;
const LAST_YEAR_OFFSET = 364;
const Z_DIRECTIONAL = 2;
const Z_SIGNIFICANT = 3;
const MIN_MEDIAN_SESSIONS = 20;
const MIN_MEDIAN_KEY_EVENTS = 3;
const MIN_MEDIAN_TRANSACTIONS = 3;
// Kayan nokta payı: |z| = 2.0 sınırı tam 2 olarak okunur.
const EPSILON = 1e-9;

const WARN_METRICS: ReadonlySet<GaAnomalyMetric> = new Set([
  "keyEvents",
  "sessions",
  "revenue",
]);

function union(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...a, ...b]);
}

function byDayOf(days: readonly GaAnalysisDay[]): Map<string, GaAnalysisDay> {
  return new Map(days.map((day) => [day.day, day]));
}

function baselineMedian(
  days: readonly GaAnalysisDay[],
  target: string,
  pick: (day: GaAnalysisDay) => number | null,
  exclude: ReadonlySet<string>,
  weeks = BASELINE_WEEKS,
  minValues = BASELINE_MIN_VALUES,
): number | null {
  const baseline = sameWeekdayBaseline(days, target, pick, {
    exclude,
    weeks,
    minValues,
  });
  return baseline ? median(baseline.values) : null;
}

// Hacim kapısı: tabandaki medyan oturum/KE/işlem yeterli mi.
export function dailyVolumeGate(
  days: readonly GaAnalysisDay[],
  target: string,
  exclude: ReadonlySet<string>,
): Record<GaAnomalyMetric, boolean> {
  const sessions = baselineMedian(days, target, (d) => d.sessions, exclude);
  const keyEvents = baselineMedian(days, target, (d) => d.keyEvents, exclude);
  const transactions = baselineMedian(
    days,
    target,
    (d) => d.transactions,
    exclude,
  );
  const enoughSessions = sessions !== null && sessions >= MIN_MEDIAN_SESSIONS;
  const enoughKeyEvents =
    keyEvents !== null && keyEvents >= MIN_MEDIAN_KEY_EVENTS;
  return {
    sessions: enoughSessions,
    engagedSessions: enoughSessions,
    keyEvents: enoughKeyEvents,
    revenue: transactions !== null && transactions >= MIN_MEDIAN_TRANSACTIONS,
    keyEventRate: enoughSessions && enoughKeyEvents,
  };
}

// Poisson tabanı: MAD sıfıra yakınken küçük sayıların doğal oynaklığı.
function floorOf(
  metric: GaAnomalyMetric,
  days: readonly GaAnalysisDay[],
  target: string,
  exclude: ReadonlySet<string>,
  weeks: number,
  minValues: number,
): number | null {
  const med = (pick: (day: GaAnalysisDay) => number | null) =>
    baselineMedian(days, target, pick, exclude, weeks, minValues);
  switch (metric) {
    case "sessions":
    case "engagedSessions":
    case "keyEvents": {
      const value = med((d) => metricOfDay(d, metric));
      return value === null ? null : Math.sqrt(Math.max(value, 1));
    }
    case "keyEventRate": {
      const keyEvents = med((d) => d.keyEvents);
      const sessions = med((d) => d.sessions);
      if (keyEvents === null || sessions === null) return null;
      return Math.sqrt(Math.max(keyEvents, 1)) / Math.max(sessions, 1);
    }
    case "revenue": {
      const revenue = med((d) => d.revenue);
      const transactions = med((d) => d.transactions);
      if (revenue === null || transactions === null) return null;
      return revenue / Math.sqrt(Math.max(transactions, 1));
    }
  }
}

function readingOf(
  metric: GaAnomalyMetric,
  days: readonly GaAnalysisDay[],
  target: GaAnalysisDay,
  exclude: ReadonlySet<string>,
  weeks = BASELINE_WEEKS,
  minValues = BASELINE_MIN_VALUES,
): GaAnomalyReading | null {
  const value = metricOfDay(target, metric);
  if (value === null) return null;
  const baseline = sameWeekdayBaseline(
    days,
    target.day,
    (d) => metricOfDay(d, metric),
    { exclude, weeks, minValues },
  );
  if (!baseline) return null;
  const floor = floorOf(metric, days, target.day, exclude, weeks, minValues);
  const scored = robustZ(value, baseline.values, floor ?? undefined);
  if (!scored || !Number.isFinite(scored.z)) return null;
  return {
    metric,
    value,
    median: scored.median,
    scale: scored.scale,
    z: scored.z,
    direction: value < scored.median ? "down" : "up",
    baselineDays: baseline.days,
  };
}

function isNotable(z: number): boolean {
  return Math.abs(z) >= Z_DIRECTIONAL - EPSILON;
}

function confidenceOf(z: number): GaFindingConfidence {
  return Math.abs(z) >= Z_SIGNIFICANT - EPSILON ? "SIGNIFICANT" : "DIRECTIONAL";
}

function severityOf(
  reading: GaAnomalyReading,
  confidence: GaFindingConfidence,
): GaFindingSeverity {
  return WARN_METRICS.has(reading.metric) &&
    reading.direction === "down" &&
    confidence === "SIGNIFICANT"
    ? "WARN"
    : "INFO";
}

// En büyük |z|; eşitlikte metrik sırası.
function primaryOf<T extends { metric: string; z: number }>(
  readings: readonly T[],
  order: readonly string[],
): T | null {
  let best: T | null = null;
  for (const reading of readings) {
    if (
      !best ||
      Math.abs(reading.z) > Math.abs(best.z) + EPSILON ||
      (Math.abs(Math.abs(reading.z) - Math.abs(best.z)) <= EPSILON &&
        order.indexOf(reading.metric) < order.indexOf(best.metric))
    ) {
      best = reading;
    }
  }
  return best;
}

// Geçen yılın hizalı günü aynı yönde olağandışı mı. null: kontrol edilemedi.
function seasonalMatch(
  reading: GaAnomalyReading,
  days: readonly GaAnalysisDay[],
  byDay: Map<string, GaAnalysisDay>,
  target: string,
  exclude: ReadonlySet<string>,
): boolean | null {
  const lastYear = byDay.get(addDays(target, -LAST_YEAR_OFFSET));
  if (!lastYear) return null;
  const past = readingOf(
    reading.metric,
    days,
    lastYear,
    exclude,
    SEASONAL_WEEKS,
    SEASONAL_MIN_VALUES,
  );
  if (!past) return null;
  return isNotable(past.z) && Math.sign(past.z) === Math.sign(reading.z);
}

function decompositionMetricOf(metric: GaAnomalyMetric): GaDecompositionMetric {
  switch (metric) {
    case "keyEvents":
    case "keyEventRate":
      return "keyEvents";
    case "revenue":
      return "revenue";
    case "sessions":
    case "engagedSessions":
      return "sessions";
  }
}

// channelDays satırları [kanal] × [sessions, keyEvents, totalRevenue].
const CHANNEL_VALUE_INDEX: Record<GaDecompositionMetric, number> = {
  sessions: 0,
  keyEvents: 1,
  revenue: 2,
};

function dayTotal(day: GaAnalysisDay, metric: GaDecompositionMetric): number {
  return metric === "sessions"
    ? day.sessions
    : metric === "keyEvents"
      ? day.keyEvents
      : day.revenue;
}

// Önce = taban günlerinin kanal ortalaması, sonra = hedef gün.
function channelBreakdown(
  input: GaDailyAnalysisInput,
  byDay: Map<string, GaAnalysisDay>,
  primary: GaAnomalyReading,
  target: GaAnalysisDay,
): GaDecomposition | null {
  const metric = decompositionMetricOf(primary.metric);
  const channelByDay = new Map(input.channelDays.map((d) => [d.day, d.rows]));
  const targetRows = channelByDay.get(target.day);
  if (!targetRows) return null;
  const baselineRows = primary.baselineDays
    .map((day) => channelByDay.get(day))
    .filter((rows): rows is NonNullable<typeof rows> => rows !== undefined);
  if (baselineRows.length === 0) return null;
  const totalDays = primary.baselineDays
    .map((day) => byDay.get(day))
    .filter((day): day is GaAnalysisDay => day !== undefined);
  if (totalDays.length === 0) return null;

  const count = baselineRows.length;
  const rows = decompositionRows(baselineRows.flat(), targetRows, {
    sessions: 0,
    value: CHANNEL_VALUE_INDEX[metric],
  }).map((row) => ({
    ...row,
    sessionsBefore: row.sessionsBefore / count,
    valueBefore: row.valueBefore / count,
  }));
  const totalBefore =
    totalDays.reduce((sum, day) => sum + dayTotal(day, metric), 0) /
    totalDays.length;
  return decompose({
    metric,
    dimension: "channel",
    rows,
    totalBefore,
    totalAfter: dayTotal(target, metric),
  });
}

// Taban penceresinde (aynı gün, 8 hafta) hariç tutulan günler.
function excludedBaselineDays(
  target: string,
  exclude: ReadonlySet<string>,
): string[] {
  const days: string[] = [];
  for (let week = 1; week <= BASELINE_WEEKS; week += 1) {
    const day = addDays(target, -7 * week);
    if (exclude.has(day)) days.push(day);
  }
  return days.sort();
}

function evaluateDay(
  input: GaDailyAnalysisInput,
  byDay: Map<string, GaAnalysisDay>,
  exclude: ReadonlySet<string>,
  target: string,
): {
  outcome: GaAn1DayOutcome["outcome"];
  candidate: GaFindingCandidate | null;
} {
  const targetDay = byDay.get(target);
  if (!targetDay || input.suspect.has(target) || input.holidays.has(target)) {
    return { outcome: "skipped", candidate: null };
  }
  const gate = dailyVolumeGate(input.days, target, exclude);
  const evaluated = METRIC_ORDER.filter((metric) => gate[metric])
    .map((metric) => readingOf(metric, input.days, targetDay, exclude))
    .filter((reading): reading is GaAnomalyReading => reading !== null);
  if (evaluated.length === 0) return { outcome: "skipped", candidate: null };

  const readings = evaluated.filter((reading) => isNotable(reading.z));
  const primary = primaryOf(readings, METRIC_ORDER);
  if (!primary) return { outcome: "not_anomalous", candidate: null };

  const seasonal = seasonalMatch(primary, input.days, byDay, target, exclude);
  if (seasonal === true) return { outcome: "not_anomalous", candidate: null };

  const confidence = confidenceOf(primary.z);
  const candidate: GaFindingCandidate = {
    ruleKey: "AN1",
    kind: "ANOMALY",
    subject: GaSubjects.site(),
    period: periodOf("DAY", { from: target, to: target }),
    severity: severityOf(primary, confidence),
    confidence,
    evidence: {
      v: 1,
      rule: "AN1",
      mode: "day",
      target,
      readings,
      primary: primary.metric,
      excludedDays: excludedBaselineDays(target, exclude),
      breakdown: channelBreakdown(input, byDay, primary, targetDay),
      seasonalChecked: seasonal !== null,
      preliminary: !targetDay.isFinal,
    },
    impact: null,
    impactShare:
      Math.abs(primary.value - primary.median) /
      Math.max(1, 7 * primary.median),
  };
  return { outcome: "anomalous", candidate };
}

export function evaluateDailyAnomalies(input: GaDailyAnalysisInput): {
  candidates: GaFindingCandidate[];
  days: GaAn1DayOutcome[];
} {
  const exclude = union(input.suspect, input.holidays);
  const byDay = byDayOf(input.days);
  const candidates: GaFindingCandidate[] = [];
  const days: GaAn1DayOutcome[] = [];
  for (const target of input.targets) {
    const result = evaluateDay(input, byDay, exclude, target);
    days.push({ day: target, outcome: result.outcome });
    if (result.candidate) candidates.push(result.candidate);
  }
  return { candidates, days };
}

type WeekReading = GaAnomalyReading & { metric: "keyEvents" | "sessions" };

// Haftalık toplamın 8 önceki temiz haftaya göre robust z'si.
function weekReading(
  metric: "keyEvents" | "sessions",
  days: readonly GaAnalysisDay[],
  monday: string,
  exclude: ReadonlySet<string>,
  weeks: number,
  minValues: number,
): WeekReading | null {
  const pick = (day: GaAnalysisDay) =>
    metric === "sessions" ? day.sessions : day.keyEvents;
  const [current] = weeklySums(days, [monday], pick, exclude);
  if (!current || !current.clean) return null;
  const mondays: string[] = [];
  for (let week = weeks; week >= 1; week -= 1) {
    mondays.push(addDays(monday, -7 * week));
  }
  const clean = weeklySums(days, mondays, pick, exclude).filter(
    (week) => week.clean,
  );
  if (clean.length < minValues) return null;
  const values = clean.map((week) => week.value);
  const med = median(values);
  if (med === null) return null;
  const scored = robustZ(current.value, values, Math.sqrt(Math.max(med, 1)));
  if (!scored || !Number.isFinite(scored.z)) return null;
  return {
    metric,
    value: current.value,
    median: scored.median,
    scale: scored.scale,
    z: scored.z,
    direction: current.value < scored.median ? "down" : "up",
    baselineDays: clean.map((week) => week.monday),
  };
}

// Hacmi düşük site: günlük kapıdan geçemeyen KE/oturum haftalık toplamla.
export function evaluateWeeklyAnomaly(
  input: GaWeeklyAnalysisInput,
): GaFindingCandidate | null {
  const exclude = union(input.suspect, input.holidays);
  const { monday, sunday } = input.week;
  const weekDays: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    weekDays.push(addDays(monday, offset));
  }
  if (weekDays.some((day) => exclude.has(day))) return null;

  const gate = dailyVolumeGate(input.days, sunday, exclude);
  const metrics = WEEKLY_METRICS.filter((metric) => !gate[metric]);
  if (metrics.length === 0) return null;

  const evaluated = metrics
    .map((metric) =>
      weekReading(
        metric,
        input.days,
        monday,
        exclude,
        BASELINE_WEEKS,
        BASELINE_MIN_VALUES,
      ),
    )
    .filter((reading): reading is WeekReading => reading !== null)
    .filter(
      (reading) =>
        reading.median >=
        (reading.metric === "sessions"
          ? MIN_MEDIAN_SESSIONS
          : MIN_MEDIAN_KEY_EVENTS),
    );
  const readings = evaluated.filter((reading) => isNotable(reading.z));
  const primary = primaryOf(readings, WEEKLY_METRICS);
  if (!primary) return null;

  // Mevsimsellik: geçen yılın hizalı haftası, önceki 4 temiz haftaya göre.
  const past = weekReading(
    primary.metric,
    input.days,
    addDays(monday, -LAST_YEAR_OFFSET),
    exclude,
    SEASONAL_WEEKS,
    SEASONAL_MIN_VALUES,
  );
  if (past && isNotable(past.z) && Math.sign(past.z) === Math.sign(primary.z)) {
    return null;
  }

  const byDay = byDayOf(input.days);
  const confidence = confidenceOf(primary.z);
  const windowStart = addDays(monday, -7 * BASELINE_WEEKS);
  const excludedDays = [...exclude]
    .filter((day) => day >= windowStart && day < monday)
    .sort();
  return {
    ruleKey: "AN1",
    kind: "ANOMALY",
    subject: GaSubjects.siteWeek(),
    period: periodOf("WEEK", { from: monday, to: sunday }),
    severity: severityOf(primary, confidence),
    confidence,
    evidence: {
      v: 1,
      rule: "AN1",
      mode: "week",
      target: monday,
      readings,
      primary: primary.metric,
      excludedDays,
      breakdown: null,
      seasonalChecked: past !== null,
      preliminary: weekDays.some((day) => byDay.get(day)?.isFinal === false),
    },
    impact: null,
    impactShare:
      Math.abs(primary.value - primary.median) / Math.max(1, primary.median),
  };
}
