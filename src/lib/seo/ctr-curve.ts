import type { SeoMetric } from "./opportunity-types";

// Sitenin kendi konum → CTR eğrisi (docs/google-search-console-plan.md SC-F4).
// Son 13 tam haftanın sorgu×sayfa satırları 15 yarı açık konum kovasına
// toplanır; her kova genel bir önsel eğriye 500 sahte gösterimle çekilir
// (az veride önsel baskın, çok veride sitenin kendisi) ve ağırlıklı izotonik
// regresyonla (PAV) konum arttıkça artmayan hâle getirilir. 2.000 gösterimin
// altında eğri önselin kendisidir. Marka sorguları ayrı eğri kullanır.
// Saf ve izomorfik.

export const CTR_BUCKETS: readonly {
  key: string;
  min: number;
  max: number;
  center: number;
}[] = [
  { key: "1", min: 0, max: 1.5, center: 1 },
  ...Array.from({ length: 9 }, (_, index) => {
    const position = index + 2;
    return {
      key: String(position),
      min: position - 0.5,
      max: position + 0.5,
      center: position,
    };
  }),
  { key: "11-15", min: 10.5, max: 15.5, center: 13 },
  { key: "16-20", min: 15.5, max: 20.5, center: 18 },
  { key: "21-30", min: 20.5, max: 30.5, center: 25.5 },
  { key: "31-50", min: 30.5, max: 50.5, center: 40.5 },
  { key: "51+", min: 50.5, max: Number.POSITIVE_INFINITY, center: 60 },
];

// Önseller kamuya açık sektör CTR eğrilerinden derlendi (doğrulanmalı):
// markasız ve marka sorguları için kova başına tıklama oranı.
export const PUBLIC_CTR_PRIOR: readonly number[] = [
  0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.017, 0.012, 0.008,
  0.004, 0.002, 0.001,
];
export const BRAND_CTR_PRIOR: readonly number[] = [
  0.55, 0.3, 0.2, 0.14, 0.1, 0.08, 0.06, 0.05, 0.04, 0.035, 0.025, 0.016, 0.008,
  0.004, 0.002,
];

// Önsele verilen sahte gösterim sayısı ve sitenin kendi eğrisi için asgari
// toplam gösterim.
export const CTR_PRIOR_STRENGTH = 500;
export const CTR_SITE_MIN_IMPRESSIONS = 2000;

const CTR_MIN = 0.0005;
const CTR_MAX = 0.95;

export type CtrCurveKind = "non-brand" | "brand";

export type CtrCurvePoint = {
  bucket: string;
  center: number;
  ctr: number;
  impressions: number;
};

export type CtrCurve = {
  v: 1;
  kind: CtrCurveKind;
  // 15 nokta, ctr konumla artmaz.
  points: CtrCurvePoint[];
  source: "site" | "prior";
  fittedAt: string | null;
  impressions: number;
};

// Sonlu olmayan ya da 1'den küçük konum ilk kovaya düşer.
export function bucketIndex(position: number): number {
  if (!Number.isFinite(position) || position < 1) return 0;
  for (let index = CTR_BUCKETS.length - 1; index > 0; index -= 1) {
    if (position >= CTR_BUCKETS[index]!.min) return index;
  }
  return 0;
}

function priorOf(kind: CtrCurveKind): readonly number[] {
  return kind === "brand" ? BRAND_CTR_PRIOR : PUBLIC_CTR_PRIOR;
}

export function priorCurve(kind: CtrCurveKind): CtrCurve {
  const prior = priorOf(kind);
  return {
    v: 1,
    kind,
    points: CTR_BUCKETS.map((bucket, index) => ({
      bucket: bucket.key,
      center: bucket.center,
      ctr: prior[index]!,
      impressions: 0,
    })),
    source: "prior",
    fittedAt: null,
    impressions: 0,
  };
}

// Ağırlıklı havuzlama (pool-adjacent-violators): sonuç artmayan dizidir ve
// ağırlıklı karesel hatayı en aza indirir. Ağırlığı sıfır ya da geçersiz olan
// öğe en küçük pozitif ağırlıkla katılır ki havuz ortalaması tanımlı kalsın.
export function isotonicNonIncreasing(
  values: readonly number[],
  weights: readonly number[],
): number[] {
  type Pool = { mean: number; weight: number; count: number };
  const pools: Pool[] = [];
  values.forEach((value, index) => {
    const raw = weights[index];
    const weight =
      raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : 1e-9;
    pools.push({ mean: value, weight, count: 1 });
    // Önceki havuz bu havuzdan küçükse (artış) ikisi birleşir.
    while (pools.length > 1) {
      const last = pools[pools.length - 1]!;
      const before = pools[pools.length - 2]!;
      if (before.mean >= last.mean) break;
      const weight = before.weight + last.weight;
      pools.splice(pools.length - 2, 2, {
        mean: (before.mean * before.weight + last.mean * last.weight) / weight,
        weight,
        count: before.count + last.count,
      });
    }
  });
  return pools.flatMap((pool) =>
    Array.from({ length: pool.count }, () => pool.mean),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function fitCtrCurve(
  rows: readonly SeoMetric[],
  kind: CtrCurveKind,
  fittedAt?: string,
): CtrCurve {
  const clicks = CTR_BUCKETS.map(() => 0);
  const impressions = CTR_BUCKETS.map(() => 0);
  let total = 0;
  for (const row of rows) {
    if (
      !Number.isFinite(row.impressions) ||
      row.impressions <= 0 ||
      !Number.isFinite(row.positionWeighted)
    ) {
      continue;
    }
    const index = bucketIndex(row.positionWeighted / row.impressions);
    impressions[index]! += row.impressions;
    clicks[index]! += Number.isFinite(row.clicks) ? Math.max(0, row.clicks) : 0;
    total += row.impressions;
  }
  if (total < CTR_SITE_MIN_IMPRESSIONS) {
    return {
      ...priorCurve(kind),
      impressions: total,
      fittedAt: fittedAt ?? null,
    };
  }
  const prior = priorOf(kind);
  const rates = CTR_BUCKETS.map(
    (_, index) =>
      (clicks[index]! + CTR_PRIOR_STRENGTH * prior[index]!) /
      (impressions[index]! + CTR_PRIOR_STRENGTH),
  );
  const monotone = isotonicNonIncreasing(
    rates,
    impressions.map((value) => value + CTR_PRIOR_STRENGTH),
  );
  return {
    v: 1,
    kind,
    points: CTR_BUCKETS.map((bucket, index) => ({
      bucket: bucket.key,
      center: bucket.center,
      ctr: clamp(monotone[index]!, CTR_MIN, CTR_MAX),
      impressions: impressions[index]!,
    })),
    source: "site",
    fittedAt: fittedAt ?? null,
    impressions: total,
  };
}

// Merkezler arasında doğrusal ara değer; uçlarda sabit. Noktalar artmadığı
// için sonuç da konumla artmaz. Sonlu olmayan konum 0 verir (kazanç şişmesin).
export function expectedCtr(curve: CtrCurve, position: number): number {
  const points = curve.points;
  if (!Number.isFinite(position) || points.length === 0) return 0;
  const first = points[0]!;
  if (position <= first.center) return first.ctr;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!;
    if (position <= right.center) {
      const left = points[index - 1]!;
      const span = right.center - left.center;
      if (span <= 0) return right.ctr;
      const t = (position - left.center) / span;
      return left.ctr + (right.ctr - left.ctr) * t;
    }
  }
  return points[points.length - 1]!.ctr;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Saklanan JSON'a güvenilmez: sürüm, tür, 15 kova (sırasıyla) ve sonlu sayılar.
export function parseCtrCurve(value: unknown): CtrCurve | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const kind = record.kind;
  if (kind !== "non-brand" && kind !== "brand") return null;
  const source = record.source;
  if (source !== "site" && source !== "prior") return null;
  if (!finite(record.impressions)) return null;
  const fittedAt = record.fittedAt;
  if (
    fittedAt !== null &&
    fittedAt !== undefined &&
    typeof fittedAt !== "string"
  ) {
    return null;
  }
  const raw = record.points;
  if (!Array.isArray(raw) || raw.length !== CTR_BUCKETS.length) return null;
  const points: CtrCurvePoint[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const point = item as Record<string, unknown>;
    if (point.bucket !== CTR_BUCKETS[index]!.key) return null;
    if (
      !finite(point.center) ||
      !finite(point.ctr) ||
      !finite(point.impressions)
    ) {
      return null;
    }
    points.push({
      bucket: point.bucket,
      center: point.center,
      ctr: point.ctr,
      impressions: point.impressions,
    });
  }
  return {
    v: 1,
    kind,
    points,
    source,
    fittedAt: typeof fittedAt === "string" ? fittedAt : null,
    impressions: record.impressions,
  };
}
