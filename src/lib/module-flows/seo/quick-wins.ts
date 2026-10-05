import { foldForMatch } from "@/lib/text-fold";

// "Quick wins" from Search Console (docs/modules.md "SEO Manager", Plan): the
// site's own queries that already rank on page one's edge or page two
// (average position 8-20) and are seen the most. An article that covers them
// well can move them up, so the plan offers them as secondary keywords. Pure:
// the server reads the rows, this decides which ones count.

export const QUICK_WIN_POSITION = { min: 8, max: 20 } as const;
export const QUICK_WIN_LIMIT = 10;
const QUERY_MAX = 80;

export type SearchQueryRow = {
  keys: readonly string[];
  clicks: number;
  impressions: number;
  position: number;
};

export type SeoQuickWin = {
  query: string;
  impressions: number;
  clicks: number;
  // Average position, one decimal.
  position: number;
};

export function pickQuickWins(
  rows: readonly SearchQueryRow[],
  limit = QUICK_WIN_LIMIT,
): SeoQuickWin[] {
  const seen = new Set<string>();
  return rows
    .flatMap((row) => {
      const query = (row.keys[0] ?? "").replace(/\s+/g, " ").trim();
      const { position, impressions } = row;
      if (!query || Array.from(query).length > QUERY_MAX) return [];
      if (!Number.isFinite(position) || !Number.isFinite(impressions)) {
        return [];
      }
      if (
        position < QUICK_WIN_POSITION.min ||
        position > QUICK_WIN_POSITION.max ||
        impressions <= 0
      ) {
        return [];
      }
      return [
        {
          query,
          impressions: Math.round(impressions),
          clicks: Number.isFinite(row.clicks) ? Math.round(row.clicks) : 0,
          position: Math.round(position * 10) / 10,
        },
      ];
    })
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position)
    .filter((win) => {
      const key = foldForMatch(win.query);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

// "1.2k" for a chip; small numbers stay exact.
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000)
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
