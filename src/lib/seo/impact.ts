import { expectedCtr, type CtrCurve } from "./ctr-curve";
import type {
  SeoConfidence,
  SeoEffort,
  SeoImpact,
  SeoMetric,
} from "./opportunity-types";

// Etki ve öncelik (docs/google-search-console-plan.md SC-F4). Etki ya aylık
// tıklama aralığıdır ya da (tıklamaya çevrilemeyen fırsatlarda) aylık
// gösterim; erişim %2 vekil CTR ile tıklamaya çevrilip sıralanır.
// Öncelik = etki × güven ağırlığı ÷ efor ağırlığı. Saf ve izomorfik.

// 28 günlük pencereden 30 günlük aya.
export const MONTH_FACTOR = 30 / 28;

export const EFFORT_WEIGHT: Readonly<Record<SeoEffort, number>> = {
  S: 1,
  M: 2,
  L: 4,
  VARIES: 2,
};

export const CONFIDENCE_WEIGHT: Readonly<Record<SeoConfidence, number>> = {
  SIGNIFICANT: 1,
  DIRECTIONAL: 0.5,
};

export const REACH_PROXY_CTR = 0.02;

// Gerçekçi hedef konum: ilk 3 → 1; ilk sayfa → üç basamak yukarı (en iyi 1);
// ikinci sayfa → 5; daha geride → 10.
export function targetPosition(position: number): number {
  if (position <= 3) return 1;
  if (position <= 10) return Math.max(1, Math.round(position) - 3);
  if (position <= 20) return 5;
  return 10;
}

// Hedef konumun beklenen tıklaması − bugünkü tıklama, aylığa çevrilmiş.
export function strikingGain(input: {
  impressions: number;
  clicks: number;
  position: number;
  curve: CtrCurve;
}): number {
  const { impressions, clicks, position, curve } = input;
  if (!Number.isFinite(impressions) || impressions <= 0) return 0;
  if (!Number.isFinite(position)) return 0;
  const expected = expectedCtr(curve, targetPosition(position)) * impressions;
  const current = Number.isFinite(clicks) ? clicks : 0;
  return Math.max(0, expected - current) * MONTH_FACTOR;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function clicksImpact(
  perMonth: number,
  confidence: SeoConfidence,
): SeoImpact {
  const value = nonNegative(perMonth);
  const [low, high] = confidence === "SIGNIFICANT" ? [0.7, 1.3] : [0.5, 1.5];
  return {
    kind: "clicks",
    perMonth: Math.round(value),
    low: Math.round(value * low),
    high: Math.round(value * high),
  };
}

export function reachImpact(impressions28d: number): SeoImpact {
  return {
    kind: "reach",
    impressionsPerMonth: Math.round(nonNegative(impressions28d) * MONTH_FACTOR),
  };
}

export function priorityOf(
  impact: SeoImpact | null,
  confidence: SeoConfidence,
  effort: SeoEffort,
): number {
  if (!impact) return 0;
  const base =
    impact.kind === "clicks"
      ? impact.perMonth
      : impact.impressionsPerMonth * REACH_PROXY_CTR;
  const value =
    (nonNegative(base) * CONFIDENCE_WEIGHT[confidence]) / EFFORT_WEIGHT[effort];
  return Math.round(value * 100) / 100;
}

export function avgPosition(metric: SeoMetric): number | null {
  if (!Number.isFinite(metric.impressions) || metric.impressions <= 0) {
    return null;
  }
  return metric.positionWeighted / metric.impressions;
}

export function ctrOf(metric: SeoMetric): number | null {
  if (!Number.isFinite(metric.impressions) || metric.impressions <= 0) {
    return null;
  }
  return metric.clicks / metric.impressions;
}
