// Tahmin (docs/meta-ads-plan.md §3.3 "Tahmin"): haftalık sonuç aralığı =
// haftalık bütçe / taban CPA (hesabın 28 günlük geçmişi; yoksa geniş bant).
// Her zaman "directional" etiketiyle gösterilir. Saf.

export function weeklyResultsRange(input: {
  dailyBudgetMinor: number;
  // Hesabın 28 günlük taban maliyeti (minor); null: geçmiş yok.
  baselineCostMinor: number | null;
  // Geçmiş yokken hedef maliyet (minor) kaba bant için.
  targetCostMinor: number | null;
}): [number, number] | null {
  const weekly = input.dailyBudgetMinor * 7;
  if (input.baselineCostMinor && input.baselineCostMinor > 0) {
    const mid = weekly / input.baselineCostMinor;
    return [Math.max(0, Math.floor(mid * 0.7)), Math.ceil(mid * 1.3)];
  }
  if (input.targetCostMinor && input.targetCostMinor > 0) {
    const mid = weekly / input.targetCostMinor;
    return [Math.max(0, Math.floor(mid * 0.4)), Math.ceil(mid * 1.6)];
  }
  return null;
}

// Kitle 100 binin altındaysa dar kitle uyarısı.
export const NARROW_AUDIENCE = 100_000;
