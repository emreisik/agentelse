import { expectedCtr } from "@/lib/seo/ctr-curve";
import { avgPosition, clicksImpact, MONTH_FACTOR } from "@/lib/seo/impact";
import { isLocalQuery, placesIn } from "@/lib/seo/intent";
import type { RuleSnapshot } from "@/lib/seo/opportunity-types";
import { foldForMatch } from "@/lib/text-fold";

import { localIntentCopy } from "./copy";
import {
  bestPairOf,
  evidenceQuery,
  finishRule,
  makeDraft,
  nonBrandQueries,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO11 yerel arama: markasız, yerel (yakınlık belirteci ya da yer adı) ve
// Q ≥ 50 sorgular. Sorguda yer adı varsa hiçbir sayfanın yolu, başlığı ya da
// H1'i o yeri anmıyorsa; yer adı yoksa en iyi sayfa ilk 10'un gerisindeyse
// yeni (yerel) sayfa önerilir. Etki SO5 gibi; daima DIRECTIONAL.

export const SO11_MIN_IMPRESSIONS = 50;
export const SO11_MAX_POSITION = 10;
export const SO11_TARGET_POSITION = 5;
export const SO11_MAX = 5;
export const SO11_NOTE =
  "Only for areas you really serve; avoid near-identical city pages.";

// Sitenin yolları, tarama başlıkları ve H1'leri: katlanmış, boşlukla ayrılmış.
function siteText(snapshot: RuleSnapshot): string {
  const parts: string[] = snapshot.pages.map((p) => p.path);
  for (const facts of snapshot.crawl?.pages ?? []) {
    parts.push(facts.path);
    if (facts.title) parts.push(facts.title);
    parts.push(...facts.h1);
  }
  // Sözcük sınırıyla eşleşsin diye harf ve rakam dışı her şey boşluk olur.
  return ` ${foldForMatch(parts.join(" ")).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
}

export const SO11: SeoRule = {
  key: "SO11_LOCAL_INTENT",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    let text: string | null = null;
    const items: RankedDraft[] = [];
    for (const query of nonBrandQueries(snapshot)) {
      if (query.impressions < SO11_MIN_IMPRESSIONS) continue;
      if (!isLocalQuery(query.text)) continue;
      const places = placesIn(query.text);
      let gap: boolean;
      if (places.length > 0) {
        text ??= siteText(snapshot);
        const site = text;
        gap = !places.some((place) => site.includes(` ${place} `));
      } else {
        const best = bestPairOf(snapshot, query.queryId);
        const position = best ? avgPosition(best) : null;
        gap = position === null || position > SO11_MAX_POSITION;
      }
      if (!gap) continue;
      const expected =
        expectedCtr(snapshot.curves.nonBrand, SO11_TARGET_POSITION) *
        query.impressions;
      const metrics = {
        impressions: Math.round(query.impressions),
        clicks: Math.round(query.clicks),
      };
      items.push({
        rank: query.impressions,
        draft: makeDraft(snapshot, {
          ruleKey: "SO11_LOCAL_INTENT",
          kind: "OPPORTUNITY",
          subject: `query:${query.queryId}`,
          severity: "INFO",
          confidence: "DIRECTIONAL",
          effort: "L",
          actionKind: "NEW_CONTENT",
          impact: clicksImpact(
            Math.max(0, expected - query.clicks) * MONTH_FACTOR * 0.5,
            "DIRECTIONAL",
          ),
          ...localIntentCopy({
            keyword: query.text,
            impressions: metrics.impressions,
            place: places.length > 0,
          }),
          evidence: {
            window: snapshot.current,
            metrics,
            queries: [evidenceQuery(query, query)],
            notes: [SO11_NOTE],
          },
          queryId: query.queryId,
          keyword: query.text,
          ideaWorthy: true,
        }),
      });
    }
    return finishRule(items, SO11_MAX);
  },
};
