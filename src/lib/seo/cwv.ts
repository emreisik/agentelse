// Chrome UX Report saha ölçümlerinin saf okuması (docs/search-health.md
// "Core Web Vitals"). Değerler CrUX'un döndürdüğü gibi saklanır (CLS dizgi
// olarak gelir, sayıya çevrilir); TTFB'nin anahtarı iki biçimde görülür
// (experimental_time_to_first_byte / time_to_first_byte). Ayrıştırıcılar hiç
// fırlatmaz; tanınmayan yanıt null / [].

export type CwvMetricKey = "lcp" | "inp" | "cls" | "fcp" | "ttfb";

export type CwvRecord = {
  formFactor: "PHONE" | "DESKTOP";
  // "2026-09-08..2026-10-05"
  collectionPeriod: string;
  // "2026-10-05"
  periodEnd: string;
  p75: Record<CwvMetricKey, number | null>;
  // [iyi, orta, kötü] yoğunlukları
  histogram: Partial<Record<CwvMetricKey, [number, number, number]>>;
};

export const CWV_METRIC_KEYS: readonly CwvMetricKey[] = [
  "lcp",
  "inp",
  "cls",
  "fcp",
  "ttfb",
];

// CrUX metrik adları (sıra önemli: ilk bulunan kullanılır).
const METRIC_NAMES: Readonly<Record<CwvMetricKey, readonly string[]>> = {
  lcp: ["largest_contentful_paint"],
  inp: ["interaction_to_next_paint"],
  cls: ["cumulative_layout_shift"],
  fcp: ["first_contentful_paint"],
  ttfb: ["experimental_time_to_first_byte", "time_to_first_byte"],
};

export const CWV_THRESHOLDS: Readonly<
  Record<CwvMetricKey, readonly [number, number]>
> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

export type CwvRating = "good" | "needs-improvement" | "poor";

const RATING_RANK: Readonly<Record<CwvRating, number>> = {
  good: 0,
  "needs-improvement": 1,
  poor: 2,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Sayı ya da sayı dizgisi ("0.05"); "NaN", boş ya da null → null.
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function metricOf(
  metrics: Record<string, unknown> | null,
  key: CwvMetricKey,
): Record<string, unknown> | null {
  if (!metrics) return null;
  for (const name of METRIC_NAMES[key]) {
    const metric = record(metrics[name]);
    if (metric) return metric;
  }
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// { year, month, day } → "YYYY-MM-DD"; eksik → null.
function dayOf(value: unknown): string | null {
  const raw = record(value);
  const year = numeric(raw?.year);
  const month = numeric(raw?.month);
  const day = numeric(raw?.day);
  if (year === null || month === null || day === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function periodOf(
  value: unknown,
): { collectionPeriod: string; periodEnd: string } | null {
  const raw = record(value);
  const first = dayOf(raw?.firstDate) ?? dayOf(raw?.startDate);
  const last = dayOf(raw?.lastDate) ?? dayOf(raw?.endDate);
  if (!last) return null;
  return { collectionPeriod: `${first ?? last}..${last}`, periodEnd: last };
}

function densities(bins: unknown): [number, number, number] | null {
  if (!Array.isArray(bins) || bins.length < 3) return null;
  const values = bins
    .slice(0, 3)
    .map((bin) => numeric(record(bin)?.density ?? bin));
  if (values.some((value) => value === null)) return null;
  return [values[0]!, values[1]!, values[2]!];
}

function emptyP75(): Record<CwvMetricKey, number | null> {
  return { lcp: null, inp: null, cls: null, fcp: null, ttfb: null };
}

export function parseCruxRecord(
  raw: unknown,
  formFactor: "PHONE" | "DESKTOP",
): CwvRecord | null {
  const root = record(record(raw)?.record) ?? record(raw);
  const metrics = record(root?.metrics);
  const period = periodOf(root?.collectionPeriod);
  if (!root || !metrics || !period) return null;
  const p75 = emptyP75();
  const histogram: CwvRecord["histogram"] = {};
  for (const key of CWV_METRIC_KEYS) {
    const metric = metricOf(metrics, key);
    if (!metric) continue;
    p75[key] = numeric(record(metric.percentiles)?.p75);
    const bins = densities(metric.histogram);
    if (bins) histogram[key] = bins;
  }
  if (CWV_METRIC_KEYS.every((key) => p75[key] === null)) return null;
  return { formFactor, ...period, p75, histogram };
}

// History API: metrik başına p75s[] ve histogramTimeseries[].densities[]
// dizileri collectionPeriods[] ile aynı sıradadır. Hiç değeri olmayan
// dönemler atlanır.
export function parseCruxHistory(
  raw: unknown,
  formFactor: "PHONE" | "DESKTOP",
): CwvRecord[] {
  const root = record(record(raw)?.record) ?? record(raw);
  const metrics = record(root?.metrics);
  const periods = Array.isArray(root?.collectionPeriods)
    ? root.collectionPeriods
    : [];
  if (!metrics || periods.length === 0) return [];
  const records: CwvRecord[] = [];
  periods.forEach((value, index) => {
    const period = periodOf(value);
    if (!period) return;
    const p75 = emptyP75();
    const histogram: CwvRecord["histogram"] = {};
    for (const key of CWV_METRIC_KEYS) {
      const metric = metricOf(metrics, key);
      if (!metric) continue;
      const series = record(metric.percentilesTimeseries)?.p75s;
      p75[key] = Array.isArray(series) ? numeric(series[index]) : null;
      const timeseries = Array.isArray(metric.histogramTimeseries)
        ? metric.histogramTimeseries
        : [];
      const bins = timeseries.map((bin) => {
        const list = record(bin)?.densities;
        return Array.isArray(list) ? numeric(list[index]) : null;
      });
      if (bins.length >= 3 && bins.slice(0, 3).every((bin) => bin !== null)) {
        histogram[key] = [bins[0]!, bins[1]!, bins[2]!];
      }
    }
    if (CWV_METRIC_KEYS.every((key) => p75[key] === null)) return;
    records.push({ formFactor, ...period, p75, histogram });
  });
  return records.sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
}

// Sınır değerleri iyi tarafta sayılır (Google: LCP ≤ 2,5 sn iyi).
export function cwvRating(
  metric: CwvMetricKey,
  value: number | null,
): CwvRating | null {
  if (value === null || !Number.isFinite(value)) return null;
  const [good, poor] = CWV_THRESHOLDS[metric];
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}

// Core Web Vitals değerlendirmesi: LCP, INP ve CLS'nin en kötüsü.
export function cwvOverall(
  p75: Record<CwvMetricKey, number | null>,
): CwvRating | null {
  const ratings = (["lcp", "inp", "cls"] as const)
    .map((key) => cwvRating(key, p75[key]))
    .filter((rating): rating is CwvRating => rating !== null);
  if (ratings.length === 0) return null;
  return ratings.reduce((worst, rating) =>
    RATING_RANK[rating] > RATING_RANK[worst] ? rating : worst,
  );
}

// Geçmiş (haftalık dönemler) içinde genel değerlendirme kötüleşti mi: son
// dönem, 4 dönem önceye (yoksa ilk döneme) göre daha kötü bir sınıfta.
export const CWV_WORSENED_LOOKBACK = 4;

export function cwvWorsened(history: readonly CwvRecord[]): boolean {
  const rated = [...history]
    .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1))
    .map((entry) => cwvOverall(entry.p75))
    .filter((rating): rating is CwvRating => rating !== null);
  if (rated.length < 2) return false;
  const latest = rated[rated.length - 1]!;
  const baseline =
    rated[Math.max(0, rated.length - 1 - CWV_WORSENED_LOOKBACK)]!;
  return RATING_RANK[latest] > RATING_RANK[baseline];
}
