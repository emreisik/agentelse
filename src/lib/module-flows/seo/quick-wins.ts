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
  // Eğri tabanlı seçimde (SEO_INSIGHTS=on) hedef konuma çıkınca beklenen ek
  // aylık tıklama (tam sayı); klasik seçimde yok.
  gain?: number;
};

// Satırın sorgusu: boşlukları tekleştirilmiş, en çok 80 karakter (kod
// noktası); boşsa ya da uzunsa null. İki seçici de bunu kullanır.
export function cleanQuickWinQuery(raw: string): string | null {
  const query = raw.replace(/\s+/g, " ").trim();
  if (!query || Array.from(query).length > QUERY_MAX) return null;
  return query;
}

export function pickQuickWins(
  rows: readonly SearchQueryRow[],
  limit = QUICK_WIN_LIMIT,
): SeoQuickWin[] {
  const seen = new Set<string>();
  return rows
    .flatMap((row) => {
      const query = cleanQuickWinQuery(row.keys[0] ?? "");
      const { position, impressions } = row;
      if (!query) return [];
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
