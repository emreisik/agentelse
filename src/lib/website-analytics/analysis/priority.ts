import type { GaFindingConfidence, GaFindingSeverity } from "./types";

// GA-F4 bulgu önceliği (docs/google-analytics-plan.md §3.6; ayrıntı
// docs/website-insights.md "Kurallar"): önem ağırlığı × güven ağırlığı ×
// (0.25 + etki payı). Etki payı [0, 1]'e kırpılır; her kural kendi payını
// açıkça verir (AN8 ve AN10'da etki yok, pay 0). Liste sıralaması ve canlı
// haftalık 3 öneri sınırı bunu kullanır.

const SEVERITY_WEIGHT: Record<GaFindingSeverity, number> = {
  INFO: 1,
  WARN: 2,
  CRITICAL: 3,
};

const CONFIDENCE_WEIGHT: Record<GaFindingConfidence, number> = {
  SIGNIFICANT: 1,
  DIRECTIONAL: 0.5,
};

export function findingPriority(input: {
  severity: GaFindingSeverity;
  confidence: GaFindingConfidence;
  impactShare: number;
}): number {
  const share = Number.isFinite(input.impactShare)
    ? Math.min(1, Math.max(0, input.impactShare))
    : 0;
  const value =
    (SEVERITY_WEIGHT[input.severity] ?? 1) *
    (CONFIDENCE_WEIGHT[input.confidence] ?? 0.5) *
    (0.25 + share);
  return Math.round(value * 10_000) / 10_000;
}
