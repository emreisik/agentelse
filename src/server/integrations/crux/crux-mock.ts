// Mock kipte Chrome UX Report yanıtları (fetch yok; CrUX API biçiminde).
// Origin: PHONE LCP 2900 / INP 180 / CLS 0.05 (LCP "orta"), DESKTOP her
// metrikte iyi. URL kaydı yalnız ana sayfada vardır (diğerleri 404 = null).
// Geçmiş 25 haftalık dönemdir; telefonda LCP yavaşça kötüleşir.

export type CruxMockTarget = { origin: string } | { url: string };

const HISTORY_PERIODS = 25;
const DAY_MS = 86_400_000;
// Sabit son dönem: mock yanıtı saate göre değişmez.
const LAST_DAY = Date.UTC(2026, 9, 3);

type Values = {
  lcp: number;
  inp: number;
  cls: number;
  fcp: number;
  ttfb: number;
};

const PHONE: Values = { lcp: 2900, inp: 180, cls: 0.05, fcp: 2210, ttfb: 1012 };
const DESKTOP: Values = { lcp: 1800, inp: 90, cls: 0.02, fcp: 1100, ttfb: 600 };

const BOUNDS: Readonly<Record<keyof Values, readonly [number, number]>> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

const NAMES: Readonly<Record<keyof Values, string>> = {
  lcp: "largest_contentful_paint",
  inp: "interaction_to_next_paint",
  cls: "cumulative_layout_shift",
  fcp: "first_contentful_paint",
  ttfb: "experimental_time_to_first_byte",
};

function dateParts(ms: number): { year: number; month: number; day: number } {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function period(lastMs: number) {
  return {
    firstDate: dateParts(lastMs - 27 * DAY_MS),
    lastDate: dateParts(lastMs),
  };
}

// p75 iyi sınırın altındaysa iyi pay büyük; değilse orta pay büyür.
function densities(key: keyof Values, value: number): [number, number, number] {
  const [good] = BOUNDS[key];
  return value <= good ? [0.82, 0.13, 0.05] : [0.62, 0.24, 0.14];
}

function metricValue(key: keyof Values, value: number): string | number {
  return key === "cls" ? value.toFixed(2) : value;
}

function isHomepage(target: CruxMockTarget): boolean {
  if (!("url" in target)) return true;
  try {
    const url = new URL(target.url);
    return url.pathname === "/" && url.search === "";
  } catch {
    return false;
  }
}

function valuesFor(formFactor: "PHONE" | "DESKTOP"): Values {
  return formFactor === "PHONE" ? PHONE : DESKTOP;
}

function keyOf(target: CruxMockTarget, formFactor: "PHONE" | "DESKTOP") {
  return "origin" in target
    ? { formFactor, origin: target.origin }
    : { formFactor, url: target.url };
}

export function mockCruxRecord(
  target: CruxMockTarget,
  formFactor: "PHONE" | "DESKTOP",
): unknown {
  if (!isHomepage(target)) return null;
  const values = valuesFor(formFactor);
  const metrics: Record<string, unknown> = {};
  for (const key of Object.keys(NAMES) as (keyof Values)[]) {
    const [good, poor] = BOUNDS[key];
    const [a, b, c] = densities(key, values[key]);
    metrics[NAMES[key]] = {
      histogram: [
        { start: 0, end: good, density: a },
        { start: good, end: poor, density: b },
        { start: poor, density: c },
      ],
      percentiles: { p75: metricValue(key, values[key]) },
    };
  }
  return {
    record: {
      key: keyOf(target, formFactor),
      metrics,
      collectionPeriod: period(LAST_DAY),
    },
  };
}

export function mockCruxHistory(
  target: CruxMockTarget,
  formFactor: "PHONE" | "DESKTOP",
): unknown {
  if (!isHomepage(target)) return null;
  const values = valuesFor(formFactor);
  const periods = Array.from({ length: HISTORY_PERIODS }, (_, index) =>
    period(LAST_DAY - (HISTORY_PERIODS - 1 - index) * 7 * DAY_MS),
  );
  const metrics: Record<string, unknown> = {};
  for (const key of Object.keys(NAMES) as (keyof Values)[]) {
    const [good, poor] = BOUNDS[key];
    // Telefonda LCP 25 haftada 2100'den 2900'e çıkar; diğerleri sabittir.
    const series = periods.map((_, index) =>
      formFactor === "PHONE" && key === "lcp"
        ? Math.round(2100 + (800 * index) / (HISTORY_PERIODS - 1))
        : values[key],
    );
    const bins = series.map((value) => densities(key, value));
    metrics[NAMES[key]] = {
      histogramTimeseries: [
        { start: 0, end: good, densities: bins.map((bin) => bin[0]) },
        { start: good, end: poor, densities: bins.map((bin) => bin[1]) },
        { start: poor, densities: bins.map((bin) => bin[2]) },
      ],
      percentilesTimeseries: {
        p75s: series.map((value) => metricValue(key, value)),
      },
    };
  }
  return {
    record: {
      key: keyOf(target, formFactor),
      metrics,
      collectionPeriods: periods,
    },
  };
}
