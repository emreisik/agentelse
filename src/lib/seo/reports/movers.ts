import { averagePosition, type GscTotals } from "@/lib/seo/totals";

import type { RankedDeltaLike, SeoReportRow } from "./types";

// Kazanan / kaybeden / yükselen satırlar (docs/search-reports.md "Hareketler").
// Sıralama belirlenimcidir: eşitlikte etiket artan. Saf ve izomorfik.

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_DELTA = 3;
const DEFAULT_MIN_IMPRESSIONS = 20;
const DEFAULT_RATIO = 2;

function roundPosition(totals: GscTotals): number | null {
  const position = averagePosition(totals);
  return position === null ? null : Math.round(position * 10) / 10;
}

export function toReportRow(delta: RankedDeltaLike): SeoReportRow {
  return {
    label: delta.label,
    url: delta.url,
    isBrand: delta.isBrand,
    clicks: delta.current.clicks,
    previousClicks: delta.previous.clicks,
    impressions: delta.current.impressions,
    previousImpressions: delta.previous.impressions,
    position: roundPosition(delta.current),
    previousPosition: roundPosition(delta.previous),
  };
}

function byLabel(a: RankedDeltaLike, b: RankedDeltaLike): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

function clickDelta(delta: RankedDeltaLike): number {
  return delta.current.clicks - delta.previous.clicks;
}

export function moverRows(
  deltas: readonly RankedDeltaLike[],
  mode: "winners" | "losers",
  options: { limit?: number; minDelta?: number; nonBrandOnly?: boolean } = {},
): SeoReportRow[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minDelta = options.minDelta ?? DEFAULT_MIN_DELTA;
  return deltas
    .filter((delta) => !(options.nonBrandOnly && delta.isBrand))
    .filter((delta) =>
      mode === "winners"
        ? clickDelta(delta) >= minDelta
        : clickDelta(delta) <= -minDelta,
    )
    .sort((a, b) => {
      const order =
        mode === "winners"
          ? clickDelta(b) - clickDelta(a)
          : clickDelta(a) - clickDelta(b);
      return order !== 0 ? order : byLabel(a, b);
    })
    .slice(0, limit)
    .map(toReportRow);
}

// Gösterimi hızla artanlar: yeterince gösterim alan ve önceki dönemde hiç
// görünmeyen ya da `ratio` katına çıkan aramalar.
export function risingRows(
  deltas: readonly RankedDeltaLike[],
  options: {
    limit?: number;
    minImpressions?: number;
    ratio?: number;
    nonBrandOnly?: boolean;
  } = {},
): SeoReportRow[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minImpressions = options.minImpressions ?? DEFAULT_MIN_IMPRESSIONS;
  const ratio = options.ratio ?? DEFAULT_RATIO;
  return deltas
    .filter((delta) => !(options.nonBrandOnly && delta.isBrand))
    .filter(
      (delta) =>
        delta.current.impressions >= minImpressions &&
        (delta.previous.impressions === 0 ||
          delta.current.impressions >= ratio * delta.previous.impressions),
    )
    .sort((a, b) => {
      const order = b.current.impressions - a.current.impressions;
      return order !== 0 ? order : byLabel(a, b);
    })
    .slice(0, limit)
    .map(toReportRow);
}

// Düşen satırların toplam kaybı: Σ max(0, önceki − şimdiki).
export function lostClicks(
  deltas: readonly { current: GscTotals; previous: GscTotals }[],
): number {
  return deltas.reduce(
    (sum, delta) => sum + Math.max(0, delta.previous.clicks - delta.current.clicks),
    0,
  );
}
