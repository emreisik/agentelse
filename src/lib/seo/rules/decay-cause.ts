import { avgPosition, ctrOf } from "@/lib/seo/impact";
import type { DecayCause, SeoMetric } from "@/lib/seo/opportunity-types";

// SO3 içerik erimesinin olası nedeni. Sıra önemlidir:
// 1. INDEX: sayfa hata veriyor, noindex ya da denetim FAIL.
// 2. CANNIBALIZATION: kendi payı ≥ 0,3 düştü VE başka sayfaların payı ≥ 0,3
//    arttı.
// 3. RANKING: ortalama konum ≥ 2 basamak geriledi.
// 4. DEMAND: konum yerinde (|Δ| < 1), gösterim ≥ %25 azaldı.
// 5. CTR: konum yerinde, tıklama oranı göreli ≥ %20 düştü.
// 6. Hiçbiri değilse MIXED.

export const CANNIBALIZATION_SHARE_DELTA = 0.3;
export const RANKING_POSITION_DELTA = 2;
export const STABLE_POSITION_DELTA = 1;
export const DEMAND_IMPRESSION_DROP = 0.25;
export const CTR_RELATIVE_DROP = 0.2;

export function decayCause(input: {
  recent: SeoMetric;
  prior: SeoMetric;
  indexProblem: boolean;
  ownShareDrop: number | null;
  otherShareRise: number | null;
}): DecayCause {
  if (input.indexProblem) return "INDEX";
  if (
    input.ownShareDrop !== null &&
    input.otherShareRise !== null &&
    input.ownShareDrop >= CANNIBALIZATION_SHARE_DELTA &&
    input.otherShareRise >= CANNIBALIZATION_SHARE_DELTA
  ) {
    return "CANNIBALIZATION";
  }
  const recentPosition = avgPosition(input.recent);
  const priorPosition = avgPosition(input.prior);
  if (recentPosition === null || priorPosition === null) return "MIXED";
  // Pozitif fark = konum kötüleşti (sayı büyüdü).
  const delta = recentPosition - priorPosition;
  if (delta >= RANKING_POSITION_DELTA) return "RANKING";
  if (Math.abs(delta) >= STABLE_POSITION_DELTA) return "MIXED";
  if (
    input.prior.impressions > 0 &&
    input.recent.impressions <=
      input.prior.impressions * (1 - DEMAND_IMPRESSION_DROP)
  ) {
    return "DEMAND";
  }
  const recentCtr = ctrOf(input.recent);
  const priorCtr = ctrOf(input.prior);
  if (
    recentCtr !== null &&
    priorCtr !== null &&
    priorCtr > 0 &&
    recentCtr <= priorCtr * (1 - CTR_RELATIVE_DROP)
  ) {
    return "CTR";
  }
  return "MIXED";
}
