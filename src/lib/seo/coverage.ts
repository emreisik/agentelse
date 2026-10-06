import { isCrawledNotIndexed, isIndexedVerdict } from "./inspection";

// Kapsam tahmini (docs/search-health.md "URL Inspection"): P6 örneğindeki
// URL'lerin indekslenmiş payı, Wilson %95 aralığıyla. "~82% (±6%) of your
// sitemap pages are indexed". En az COVERAGE_MIN_SAMPLE örnek gerekir. Düşüş
// (SH9) = nokta tahmini en az 10 puan aşağı VE aralıklar örtüşmüyor.

export const COVERAGE_MIN_SAMPLE = 20;
export const COVERAGE_DROP_POINTS = 0.1;

export function wilsonInterval(
  successes: number,
  n: number,
  z: number = 1.96,
): { point: number; low: number; high: number } {
  if (!Number.isFinite(n) || n <= 0) return { point: 0, low: 0, high: 1 };
  const k = Math.min(Math.max(0, successes), n);
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    point: p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export type CoverageEstimate = {
  sampled: number;
  indexed: number;
  crawledNotIndexed: number;
  point: number;
  low: number;
  high: number;
};

export function estimateCoverage(
  rows: readonly { verdict: string | null; coverageState: string | null }[],
): CoverageEstimate {
  const sampled = rows.length;
  const indexed = rows.filter((row) => isIndexedVerdict(row.verdict)).length;
  const crawledNotIndexed = rows.filter((row) =>
    isCrawledNotIndexed(row.coverageState),
  ).length;
  return {
    sampled,
    indexed,
    crawledNotIndexed,
    ...wilsonInterval(indexed, sampled),
  };
}

// "~82% (±7%)": yarı aralık genişliği, tam yüzdeye yuvarlanmış.
export function coverageText(estimate: CoverageEstimate): string {
  const point = Math.round(estimate.point * 100);
  const plusMinus = Math.round(((estimate.high - estimate.low) / 2) * 100);
  return `~${point}% (±${plusMinus}%)`;
}

export function coverageDropped(
  previous: CoverageEstimate,
  current: CoverageEstimate,
): boolean {
  if (
    previous.sampled < COVERAGE_MIN_SAMPLE ||
    current.sampled < COVERAGE_MIN_SAMPLE
  ) {
    return false;
  }
  // Kayan nokta payı: tam 10 puanlık düşüş de sayılır.
  return (
    previous.point - current.point >= COVERAGE_DROP_POINTS - 1e-9 &&
    current.high < previous.low
  );
}
