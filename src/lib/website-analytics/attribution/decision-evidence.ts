// GA-F6: optimizer kararının kanıtına GA4'ün düz ga4_* alanlarını ekler
// (docs/website-attribution.md "Meta optimizasyonuna kanıt"). Bayrak kapalı ya
// da veri yoksa (ga4 null) AYNI kanıt nesnesi döner: davranış değişmez. Saf modül.
export function withGaEvidence<T extends object, G extends object>(
  evidence: T,
  ga4: G | null,
): T | (T & G) {
  return ga4 ? { ...evidence, ...ga4 } : evidence;
}
