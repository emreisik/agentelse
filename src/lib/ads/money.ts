// Reklam paralarının tek kaynağı (docs/meta-ads-plan.md §1.3, F0b). Meta
// bütçeleri, harcama tavanlarını ve asgari tutarları reklam hesabının para
// biriminin "minor unit"i ile tutar: çoğu para biriminde 100 (kuruş), kuruşsuz
// para birimlerinde 1. Hiçbir yerde sabit ×100 ya da /100 kalmamalı; dönüşüm
// hep buradan yapılır.

// Meta'nın para birimi tablosunda ofseti 1 olanlar: saklanan değer tam birim
// tutardır, kuruş / 100 yapılırsa 100 kat küçük çıkar.
export const ZERO_DECIMAL_CURRENCIES: readonly string[] = [
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "ISK",
  "UGX",
  "PYG",
  "XAF",
  "XOF",
  "XPF",
  "KMF",
  "GNF",
  "RWF",
  "DJF",
  "BIF",
  "VUV",
  "COP",
  "CRC",
  "HUF",
  "IDR",
  "TWD",
];

// Bin'de bir birimli para birimleri: Meta'nın ofseti belgede net değil, bu
// yüzden tutar gösterilmez (canShowAmount).
export const THREE_DECIMAL_CURRENCIES: readonly string[] = [
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
];

export function currencyCode(
  currency: string | null | undefined,
): string | null {
  const code = currency?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

// Bilinmeyen para birimi Meta'nın varsayılanıdır: 100.
export function minorUnitOffset(currency?: string | null): 1 | 100 {
  const code = currencyCode(currency);
  return code && ZERO_DECIMAL_CURRENCIES.includes(code) ? 1 : 100;
}

// Ana birim (ör. 20 TRY) → Meta'nın sakladığı minor unit (2000).
export function toMinorUnits(major: number, currency?: string | null): number {
  return Math.round(major * minorUnitOffset(currency));
}

// Minor unit → ana birim.
export function toMajorUnits(minor: number, currency?: string | null): number {
  return minor / minorUnitOffset(currency);
}

// Insights'ın `spend` gibi ana birimde ondalıklı metin alanları → minor unit.
export function parseMajorText(
  value: string | number | null | undefined,
  currency?: string | null,
): number {
  const major = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(major) ? toMinorUnits(major, currency) : 0;
}

// Tutar yalnız para birimi biliniyorsa ve ofseti kesinse yazdırılır.
export function canShowAmount(currency?: string | null): boolean {
  const code = currencyCode(currency);
  if (!code) return false;
  return !THREE_DECIMAL_CURRENCIES.includes(code);
}

// "400 TRY", "38.20 TRY", "1,500 JPY". Tam sayılar ondalıksız yazılır.
export function formatMajorMoney(major: number, code: string): string {
  const whole = Number.isInteger(major) || minorUnitOffset(code) === 1;
  const number = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(major);
  return `${number} ${code}`;
}

// Minor unit tutarını okunur yazar. Para birimi bilinmiyorsa tutar uydurulmaz:
// "(account currency)" notuyla minor unit değeri değil, Meta'nın varsayılan
// ofsetiyle ana birim yazılır ve belirsizlik söylenir.
export function formatMoney(minor: number, currency?: string | null): string {
  const code = currencyCode(currency);
  if (!code || !canShowAmount(code)) {
    const number = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    }).format(minor / 100);
    return `${number} (account currency)`;
  }
  return formatMajorMoney(toMajorUnits(minor, code), code);
}
