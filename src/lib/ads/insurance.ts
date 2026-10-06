// Ad Rules sigortasının eşiği (docs/meta-ads-plan.md §3.9, F7). Saf.
//
// Kural kampanyanın bugünkü harcaması 2 × günlük bütçeyi geçerse onu
// duraklatır. Eşik bugün yürürlükte olmuş en yüksek bütçeye göre hesaplanır:
// bütçe düşürülünce o gün eski bütçenin iki katı kalır ve hesap saatiyle gece
// yarısından sonra yeni bütçeye iner (yoksa kural kampanyayı kendi kendine
// durdururdu); bütçe artınca eşik hemen yükselir.

export function safetyThresholdMinor(input: {
  currentDailyMinor: number | null;
  highestTodayMinor: number | null;
}): number | null {
  const base = Math.max(input.currentDailyMinor ?? 0, input.highestTodayMinor ?? 0);
  return Number.isFinite(base) && base > 0 ? Math.round(base * 2) : null;
}

export type InsuranceGuards = {
  campaignSpendCapMinor?: number | null;
  ruleId?: string;
  ruleThresholdMinor?: number;
  // Disconnect'te silinemeyen kural (/health listeler).
  ruleDeleteFailedAt?: string;
};

export function guardsOf(value: unknown): InsuranceGuards & Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as InsuranceGuards & Record<string, unknown>)
    : {};
}
