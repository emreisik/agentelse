// Reklam ücretleri (docs/meta-ads-plan.md §3.3 "Bütçe"). Konum ücreti
// reklamverenin değil, reklamın gösterildiği ülkeye göre alınır (1 Temmuz
// 2026'dan beri). Bütçe ve Insights `spend` bu ücreti içermez. Oranlar ikincil
// kaynaklardan ve tarihlidir: doğrulanmalı. KDV hesabın vergi durumuna bağlı
// olduğu için hesaplanmaz, "plus VAT where it applies" denir.

export const LOCATION_FEES_SINCE = "2026-07-01";

export const LOCATION_FEE_RATE: Readonly<Record<string, number>> = {
  TR: 0.05,
  AT: 0.05,
  FR: 0.03,
  IT: 0.03,
  ES: 0.03,
  GB: 0.02,
};

// Bütçe hedef ülkelere eşit dağılıyormuş gibi (yönlendirici tahmin).
export function locationFeeShare(countries: readonly string[]): number {
  if (countries.length === 0) return 0;
  const total = countries.reduce((sum, code) => sum + (LOCATION_FEE_RATE[code] ?? 0), 0);
  return total / countries.length;
}

// Net zarf → tahmini brüt fatura (KDV hariç), minor unit.
export function estimatedGrossMinor(netMinor: number, countries: readonly string[]): number {
  return Math.round(netMinor * (1 + locationFeeShare(countries)));
}
