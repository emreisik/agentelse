// GA-F4 istatistik yardımcıları (docs/google-analytics-plan.md §6.3
// "İstatistik kapıları"; ayrıntı docs/website-insights.md "İstatistik").
// Her fonksiyon toplamdır: boş, NaN ya da geçersiz girdide null/false döner,
// asla hata fırlatmaz. Saf ve izomorfik; kütüphane yok.

// Abramowitz–Stegun 7.1.26 erf yaklaşımı (|hata| ≤ 1.5e-7; Φ'de yarısı).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

// Standart normal dağılım fonksiyonu Φ(z).
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return Number.NaN;
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// İki yönlü p = 2·(1 − Φ(|z|)); NaN z'de en temkinli değer 1.
export function twoSidedP(z: number): number {
  if (Number.isNaN(z)) return 1;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return Math.min(1, Math.max(0, p));
}

function finite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

export function median(values: readonly number[]): number | null {
  const sorted = finite(values).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Ölçeklenmemiş medyan mutlak sapma (robustZ 1.4826 ile çarpar).
export function mad(values: readonly number[]): number | null {
  const clean = finite(values);
  const center = median(clean);
  if (center === null) return null;
  return median(clean.map((value) => Math.abs(value - center)));
}

// Doğrusal aradeğerlemeli yüzdelik, p ∈ [0, 1].
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  const sorted = finite(values).sort((a, b) => a - b);
  if (sorted.length === 0 || !Number.isFinite(p)) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const position = clamped * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * fraction;
}

// Sağlam z = (x − medyan) / max(1.4826·MAD, taban, 1e-9). Taban Poisson
// gürültüsüdür (ör. sayımda √medyan): MAD 0 olan düz tabanda küçük oynamalar
// anomali sayılmasın.
export function robustZ(
  value: number,
  baseline: readonly number[],
  floor?: number,
): { z: number; median: number; scale: number } | null {
  if (!Number.isFinite(value)) return null;
  const center = median(baseline);
  const deviation = mad(baseline);
  if (center === null || deviation === null) return null;
  const safeFloor = floor !== undefined && Number.isFinite(floor) ? floor : 0;
  const scale = Math.max(1.4826 * deviation, safeFloor, 1e-9);
  return { z: (value - center) / scale, median: center, scale };
}

// Havuzlanmış iki oran z-testi. YALNIZ isabet ≤ deneme olan oranlar için
// (engagedSessions/sessions, dönen oturum payı, huni adımı); key event /
// oturum 1'i aşabildiği için orada rateRatioTest kullanılır.
export function twoProportionTest(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): { z: number; p: number } | null {
  if (![x1, n1, x2, n2].every(Number.isFinite)) return null;
  if (n1 <= 0 || n2 <= 0) return null;
  const a = Math.min(n1, Math.max(0, x1));
  const b = Math.min(n2, Math.max(0, x2));
  const pooled = (a + b) / (n1 + n2);
  if (pooled <= 0 || pooled >= 1) return null;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  const z = (a / n1 - b / n2) / se;
  return { z, p: twoSidedP(z) };
}

// Koşullu Poisson oran testi: a + b = n sabitken a ~ Bin(n, π0),
// π0 = tA / (tA + tB); normal yaklaşım. z > 0 ⇒ A'nın oranı daha yüksek.
export function poissonRateTest(
  a: number,
  b: number,
  exposureA = 1,
  exposureB = 1,
): { z: number; p: number } | null {
  if (![a, b, exposureA, exposureB].every(Number.isFinite)) return null;
  if (exposureA <= 0 || exposureB <= 0) return null;
  const hitsA = Math.max(0, a);
  const hitsB = Math.max(0, b);
  const n = hitsA + hitsB;
  if (n <= 0) return null;
  const pi0 = exposureA / (exposureA + exposureB);
  const sd = Math.sqrt(n * pi0 * (1 - pi0));
  if (!(sd > 0)) return null;
  const z = (hitsA - n * pi0) / sd;
  return { z, p: twoSidedP(z) };
}

// Key event / oturum karşılaştırması: oturum maruziyet, key event sayım.
// Oran 1'i aşsa da geçerlidir.
export function rateRatioTest(
  hitsA: number,
  exposureA: number,
  hitsB: number,
  exposureB: number,
): { z: number; p: number; ratio: number | null } | null {
  const test = poissonRateTest(hitsA, hitsB, exposureA, exposureB);
  if (!test) return null;
  const rateB = hitsB / exposureB;
  const ratio = rateB > 0 ? hitsA / exposureA / rateB : null;
  return {
    ...test,
    ratio: ratio !== null && Number.isFinite(ratio) ? ratio : null,
  };
}

// k ≤ 4 için kesin %95 Poisson aralığı (ki-kare tablosundan).
const EXACT_LOW = [0, 0.0253, 0.2422, 0.6186, 1.0899];
const EXACT_HIGH = [3.6889, 5.5716, 7.2247, 8.7673, 10.2416];

// Sayım k için %95 aralık; k ≥ 5'te Byar yaklaşımı. Tam sayı olmayan k
// yuvarlanır, negatif/NaN 0 sayılır.
export function poissonInterval(k: number): { low: number; high: number } {
  const count = Number.isFinite(k) ? Math.max(0, Math.round(k)) : 0;
  if (count <= 4) return { low: EXACT_LOW[count]!, high: EXACT_HIGH[count]! };
  const z = 1.96;
  const low = count * (1 - 1 / (9 * count) - z / (3 * Math.sqrt(count))) ** 3;
  const next = count + 1;
  const high = next * (1 - 1 / (9 * next) + z / (3 * Math.sqrt(next))) ** 3;
  return { low, high };
}

// Wilson skor aralığı (isabet ≤ deneme).
export function wilsonInterval(
  x: number,
  n: number,
  z = 1.96,
): { low: number; high: number } | null {
  if (![x, n, z].every(Number.isFinite) || n <= 0) return null;
  const p = Math.min(1, Math.max(0, x / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  };
}

// Benjamini-Hochberg (adım yukarı): p(i) ≤ (i/m)·q sağlayan en büyük i
// bulunur, p ≤ p(i) olan her test kabul edilir. Çıktı girdi sırasındadır;
// NaN p 1 sayılır.
export function benjaminiHochberg(
  pValues: readonly number[],
  q = 0.1,
): boolean[] {
  const clean = pValues.map((p) => (Number.isNaN(p) ? 1 : p));
  const m = clean.length;
  if (m === 0 || !Number.isFinite(q) || q <= 0) return clean.map(() => false);
  const sorted = [...clean].sort((a, b) => a - b);
  let threshold = -Infinity;
  for (let i = m; i >= 1; i--) {
    if (sorted[i - 1]! <= (i / m) * q) {
      threshold = sorted[i - 1]!;
      break;
    }
  }
  return clean.map((p) => p <= threshold);
}
