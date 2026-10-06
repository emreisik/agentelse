import { addDays } from "@/lib/seo/dates";

// SH2 arama düşüşü (docs/search-health.md "Kontroller"): yalnız kesinleşmiş
// günler. Son iki ardışık gün, her biri kendi haftagününün önceki 8 haftalık
// medyanıyla (en az 6 değer, en az günde 20 tık) karşılaştırılır; ikisi de
// %50'nin altındaysa CRITICAL, %75'in altındaysa WARN. Marka ayrımı son 9
// haftanın her gününde hazırsa markasız tıklar, değilse toplam tıklar.
// Saatlik erken uyarı ertelendi.

export type DropDay = {
  day: string;
  clicks: number;
  // Markasız web tıkları; marka ayrımı o gün için yoksa null.
  nonBrandClicks: number | null;
};

export type DropMetric = "nonBrand" | "total";

export type DropVerdict = {
  severity: "WARN" | "CRITICAL";
  metric: DropMetric;
  // İki günün oranlarından büyüğü (0..1): "en çok %X".
  ratio: number;
  // Son günün taban değeri (medyan tık).
  baseline: number;
  // İki düşük gün, eskiden yeniye.
  days: [string, string];
};

export const DROP_BASELINE_WEEKS = 8;
export const DROP_MIN_BASELINE_VALUES = 6;
export const DROP_MIN_BASELINE = 20;
export const DROP_CRITICAL_RATIO = 0.5;
export const DROP_WARN_RATIO = 0.75;
const METRIC_WINDOW_DAYS = 63;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function valueOf(day: DropDay, metric: DropMetric): number | null {
  return metric === "nonBrand" ? day.nonBrandClicks : day.clicks;
}

function dayRatio(
  byDay: ReadonlyMap<string, DropDay>,
  day: string,
  metric: DropMetric,
): { ratio: number; baseline: number } | null {
  const current = byDay.get(day);
  const value = current ? valueOf(current, metric) : null;
  if (value === null) return null;
  const history: number[] = [];
  for (let week = 1; week <= DROP_BASELINE_WEEKS; week += 1) {
    const previous = byDay.get(addDays(day, -7 * week));
    const previousValue = previous ? valueOf(previous, metric) : null;
    if (previousValue !== null) history.push(previousValue);
  }
  if (history.length < DROP_MIN_BASELINE_VALUES) return null;
  const baseline = median(history);
  if (baseline < DROP_MIN_BASELINE) return null;
  return { ratio: value / baseline, baseline };
}

// days: eskiden yeniye, yalnız kesinleşmiş günler.
export function dropVerdict(days: readonly DropDay[]): DropVerdict | null {
  if (days.length < 2) return null;
  const last = days[days.length - 1]!.day;
  const previousDay = addDays(last, -1);
  const byDay = new Map(days.map((day) => [day.day, day]));
  if (!byDay.has(previousDay)) return null;

  const windowStart = addDays(last, -(METRIC_WINDOW_DAYS - 1));
  const inWindow = days.filter((day) => day.day >= windowStart);
  const metric: DropMetric = inWindow.every(
    (day) => day.nonBrandClicks !== null,
  )
    ? "nonBrand"
    : "total";

  const first = dayRatio(byDay, previousDay, metric);
  const second = dayRatio(byDay, last, metric);
  if (!first || !second) return null;
  const ratio = Math.max(first.ratio, second.ratio);
  const severity =
    ratio < DROP_CRITICAL_RATIO
      ? "CRITICAL"
      : ratio < DROP_WARN_RATIO
        ? "WARN"
        : null;
  if (!severity) return null;
  return {
    severity,
    metric,
    ratio,
    baseline: second.baseline,
    days: [previousDay, last],
  };
}
