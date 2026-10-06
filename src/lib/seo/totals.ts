// Günlük toplamlardan dönem değerleri (docs/search-analytics.md "Günler ve
// kesinleşme"). Konum pozisyon × gösterim olarak saklanır; dönemin ortalama
// konumu Σ positionWeighted / Σ impressions, CTR tıklama / gösterimdir.
// Markasız = toplam − marka: Google'ın göstermediği (anonim) sorgular
// markasızda sayılır.

export type GscTotals = {
  clicks: number;
  impressions: number;
  positionWeighted: number;
};

export type GscDayLike = GscTotals & {
  brandClicks: number | null;
  brandImpressions: number | null;
  brandPositionWeighted: number | null;
};

export type GscSplit = {
  total: GscTotals;
  // Bir günün bile marka değeri yoksa null (ayrım o dönem için kurulamaz).
  brand: GscTotals | null;
  nonBrand: GscTotals | null;
};

function zero(): GscTotals {
  return { clicks: 0, impressions: 0, positionWeighted: 0 };
}

export function sumGscDays(days: readonly GscDayLike[]): GscSplit {
  const total = zero();
  const brand = zero();
  let brandComplete = days.length > 0;
  for (const day of days) {
    total.clicks += day.clicks;
    total.impressions += day.impressions;
    total.positionWeighted += day.positionWeighted;
    if (
      day.brandClicks === null ||
      day.brandImpressions === null ||
      day.brandPositionWeighted === null
    ) {
      brandComplete = false;
      continue;
    }
    brand.clicks += day.brandClicks;
    brand.impressions += day.brandImpressions;
    brand.positionWeighted += day.brandPositionWeighted;
  }
  if (!brandComplete) return { total, brand: null, nonBrand: null };
  return {
    total,
    brand,
    nonBrand: {
      clicks: Math.max(0, total.clicks - brand.clicks),
      impressions: Math.max(0, total.impressions - brand.impressions),
      positionWeighted: Math.max(
        0,
        total.positionWeighted - brand.positionWeighted,
      ),
    },
  };
}

// Tıklama oranı (yüzde); gösterim yoksa null.
export function ctrPercent(totals: GscTotals): number | null {
  return totals.impressions > 0
    ? (totals.clicks / totals.impressions) * 100
    : null;
}

// Google'ın ortalama en üst konumu; gösterim yoksa null.
export function averagePosition(totals: GscTotals): number | null {
  return totals.impressions > 0
    ? totals.positionWeighted / totals.impressions
    : null;
}

// Satırlarda görünmeyen (anonim ya da kırpılan) tıklamaların payı, 0-1.
export function anonymousShare(
  totalClicks: number,
  rowClicks: number,
): number | null {
  if (!Number.isFinite(totalClicks) || totalClicks <= 0) return null;
  if (!Number.isFinite(rowClicks)) return null;
  return Math.min(1, Math.max(0, 1 - rowClicks / totalClicks));
}
