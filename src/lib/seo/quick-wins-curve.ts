import {
  QUICK_WIN_LIMIT,
  cleanQuickWinQuery,
  type SearchQueryRow,
  type SeoQuickWin,
} from "@/lib/module-flows/seo/quick-wins";
import { foldForMatch } from "@/lib/text-fold";

import type { CtrCurve } from "./ctr-curve";
import { strikingGain } from "./impact";

// Eğri tabanlı quick wins (docs/google-search-console-plan.md SC-F4, SEO
// Manager): SEO_INSIGHTS=on ve sitenin eğrisi varken klasik "8–20, en çok
// gösterim" seçimi yerine 4–20 konumdaki sorgular hedef konuma çıkınca
// beklenen aylık tıklama kazancına göre sıralanır. Metin süzgeçleri ve
// tekilleştirme pickQuickWins ile aynıdır. Saf ve izomorfik.

export const CURVE_QUICK_WIN_POSITION = { min: 4, max: 20 } as const;
export const CURVE_QUICK_WIN_MIN_IMPRESSIONS = 10;

export function pickCurveQuickWins(
  rows: readonly SearchQueryRow[],
  curve: CtrCurve,
  limit: number = QUICK_WIN_LIMIT,
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
        position < CURVE_QUICK_WIN_POSITION.min ||
        position > CURVE_QUICK_WIN_POSITION.max ||
        impressions < CURVE_QUICK_WIN_MIN_IMPRESSIONS
      ) {
        return [];
      }
      const clicks = Number.isFinite(row.clicks) ? row.clicks : 0;
      const gain = Math.round(
        strikingGain({ impressions, clicks, position, curve }),
      );
      if (gain < 1) return [];
      return [
        {
          query,
          impressions: Math.round(impressions),
          clicks: Math.round(clicks),
          position: Math.round(position * 10) / 10,
          gain,
        },
      ];
    })
    .sort((a, b) => b.gain - a.gain || b.impressions - a.impressions)
    .filter((win) => {
      const key = foldForMatch(win.query);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
