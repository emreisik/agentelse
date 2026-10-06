// Metrik anomalisi (docs/meta-ads-plan.md §3.6, F8): dünün CPM, CPA ve link
// CTR değeri, haftanın gününe göre düzeltilmiş 14 günlük tabana göre z-skoru
// ile değerlendirilir. Saf. Yalnız kötü yöndeki sapma bildirilir (CPM ve CPA
// yukarı, link CTR aşağı); asgari hacim yoksa metrik susar.

export type AnomalyDay = {
  date: string;
  spendMinor: number;
  impressions: number;
  linkClicks: number;
  results: number | null;
};

export type AnomalyMetric = "CPM" | "CPA" | "LINK_CTR";

export type MetricAnomaly = {
  metric: AnomalyMetric;
  value: number;
  baseline: number;
  z: number;
};

export const Z_THRESHOLD = 3;
const BASELINE_DAYS = 14;
const SEASON_DAYS = 28;
const MIN_BASELINE_POINTS = 10;
const MIN_IMPRESSIONS = 500;
const MIN_RESULTS = 3;

function metricOf(day: AnomalyDay, metric: AnomalyMetric): number | null {
  if (metric === "CPA") {
    return day.results !== null && day.results >= MIN_RESULTS
      ? day.spendMinor / day.results
      : null;
  }
  if (day.impressions < MIN_IMPRESSIONS) return null;
  return metric === "CPM"
    ? (day.spendMinor / day.impressions) * 1000
    : day.linkClicks / day.impressions;
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Haftanın günü katsayısı: o günlerin ortalaması / genel ortalama (en az iki
// örnek yoksa 1).
function weekdayFactors(
  points: { date: string; value: number }[],
): Map<number, number> {
  const overall = points.length ? mean(points.map((point) => point.value)) : 0;
  const factors = new Map<number, number>();
  for (let day = 0; day < 7; day += 1) {
    const same = points
      .filter((point) => weekday(point.date) === day)
      .map((p) => p.value);
    factors.set(
      day,
      same.length >= 2 && overall > 0 ? mean(same) / overall : 1,
    );
  }
  return factors;
}

export function metricAnomalies(
  days: readonly AnomalyDay[],
  target: string,
): MetricAnomaly[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const today = byDate.get(target);
  if (!today) return [];
  const out: MetricAnomaly[] = [];
  for (const metric of ["CPM", "CPA", "LINK_CTR"] as const) {
    const value = metricOf(today, metric);
    if (value === null) continue;
    const season: { date: string; value: number }[] = [];
    for (let offset = 1; offset <= SEASON_DAYS; offset += 1) {
      const date = shift(target, -offset);
      const day = byDate.get(date);
      const v = day ? metricOf(day, metric) : null;
      if (v !== null) season.push({ date, value: v });
    }
    const factors = weekdayFactors(season);
    const adjust = (date: string, v: number) =>
      v / (factors.get(weekday(date)) || 1);
    const baseline = season
      .filter((point) => point.date >= shift(target, -BASELINE_DAYS))
      .map((point) => adjust(point.date, point.value));
    if (baseline.length < MIN_BASELINE_POINTS) continue;
    const mu = mean(baseline);
    const sd = Math.sqrt(
      baseline.reduce((sum, v) => sum + (v - mu) ** 2, 0) /
        (baseline.length - 1),
    );
    if (!(sd > 0)) continue;
    const z = (adjust(target, value) - mu) / sd;
    const bad = metric === "LINK_CTR" ? z <= -Z_THRESHOLD : z >= Z_THRESHOLD;
    if (bad) {
      out.push({
        metric,
        value,
        // O haftanın günü için beklenen ham değer.
        baseline: mu * (factors.get(weekday(target)) || 1),
        z: Math.round(z * 10) / 10,
      });
    }
  }
  return out;
}

const METRIC_TEXT: Record<AnomalyMetric, string> = {
  CPM: "Cost per 1,000 views",
  CPA: "Cost per result",
  LINK_CTR: "Link click rate",
};

export function anomalyTitle(anomaly: MetricAnomaly): string {
  const change =
    anomaly.baseline > 0
      ? (anomaly.value - anomaly.baseline) / anomaly.baseline
      : 0;
  const pct = Math.round(Math.abs(change) * 100);
  return `${METRIC_TEXT[anomaly.metric]} ${change >= 0 ? "jumped" : "dropped"} ${pct}% yesterday`;
}
