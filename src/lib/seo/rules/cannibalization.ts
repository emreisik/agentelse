import { expectedCtr } from "@/lib/seo/ctr-curve";
import { avgPosition, clicksImpact, MONTH_FACTOR } from "@/lib/seo/impact";
import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { cannibalizationCopy } from "./copy";
import {
  evidencePage,
  finishRule,
  isHomepage,
  makeDraft,
  nonBrandQueries,
  snapshotIndex,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO4 yamyamlık: markasız, Q ≥ 50 bir sorguda ana sayfa dışında ≥ 2 sayfa
// gösterimin ≥ %10'unu alıyorsa ve ya önde gelen sayfa haftadan haftaya ≥ 2
// kez değiştiyse ya da sorgunun tıklaması beklenenin %70'inin altındaysa.
// Değişim sayımı yalnız çift verisi olan ≥ 4 haftada yapılır.

export const SO4_MIN_IMPRESSIONS = 50;
export const SO4_MIN_SHARE = 0.1;
export const SO4_MIN_PAGES = 2;
export const SO4_MIN_SWITCHES = 2;
export const SO4_WEEK_MIN_IMPRESSIONS = 5;
export const SO4_MIN_PAIR_WEEKS = 4;
export const SO4_GAP_RATIO = 0.7;
export const SO4_SIGNIFICANT_IMPRESSIONS = 500;
export const SO4_SIGNIFICANT_SWITCHES = 3;
export const SO4_MAX = 10;

// Haftalık önde gelen sayfanın (ana sayfa hariç) kaç kez değiştiği.
function dominantSwitches(snapshot: RuleSnapshot, queryId: string): number {
  if (snapshot.pairWeeks.length < SO4_MIN_PAIR_WEEKS) return 0;
  const weeks = new Set(snapshot.pairWeeks);
  const byWeek = new Map<string, Map<string, number>>();
  for (const row of snapshot.weeklyPairs) {
    if (row.queryId !== queryId || !weeks.has(row.weekStart)) continue;
    if (isHomepage(snapshot, row.pageId)) continue;
    const pages = byWeek.get(row.weekStart) ?? new Map<string, number>();
    pages.set(row.pageId, (pages.get(row.pageId) ?? 0) + row.impressions);
    byWeek.set(row.weekStart, pages);
  }
  let switches = 0;
  let previous: string | null = null;
  for (const week of [...weeks].sort()) {
    const pages = byWeek.get(week);
    if (!pages) continue;
    let total = 0;
    let best: string | null = null;
    let bestImpressions = -1;
    for (const [pageId, impressions] of [...pages].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      total += impressions;
      if (impressions > bestImpressions) {
        best = pageId;
        bestImpressions = impressions;
      }
    }
    if (total < SO4_WEEK_MIN_IMPRESSIONS || best === null) continue;
    if (previous !== null && best !== previous) switches += 1;
    previous = best;
  }
  return switches;
}

export const SO4: SeoRule = {
  key: "SO4_CANNIBALIZATION",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const index = snapshotIndex(snapshot);
    const curve = snapshot.curves.nonBrand;
    const items: RankedDraft[] = [];
    for (const query of nonBrandQueries(snapshot)) {
      const Q = query.impressions;
      if (Q < SO4_MIN_IMPRESSIONS) continue;
      const pairs = index.pairsByQuery.get(query.queryId) ?? [];
      const competing = pairs
        .filter((p) => !isHomepage(snapshot, p.pageId))
        .map((p) => ({ pair: p, share: p.impressions / Q }))
        .filter((p) => p.share >= SO4_MIN_SHARE)
        .sort(
          (a, b) =>
            b.pair.impressions - a.pair.impressions ||
            a.pair.pageId.localeCompare(b.pair.pageId),
        );
      if (competing.length < SO4_MIN_PAGES) continue;

      const switches = dominantSwitches(snapshot, query.queryId);
      let expected = 0;
      let actual = 0;
      for (const pair of pairs) {
        const position = avgPosition(pair);
        if (position === null) continue;
        expected += expectedCtr(curve, position) * pair.impressions;
        actual += pair.clicks;
      }
      const ctrGap = actual < SO4_GAP_RATIO * expected;
      if (switches < SO4_MIN_SWITCHES && !ctrGap) continue;

      const confidence =
        Q >= SO4_SIGNIFICANT_IMPRESSIONS && switches >= SO4_SIGNIFICANT_SWITCHES
          ? "SIGNIFICANT"
          : "DIRECTIONAL";
      const missed = Math.max(0, expected - actual);
      const metrics = {
        impressions: Math.round(Q),
        pages: competing.length,
        switches,
        clicks: Math.round(actual),
        expectedClicks: Math.round(expected),
      };
      const dominant = competing[0]!.pair.pageId;
      items.push({
        rank: Q,
        draft: makeDraft(snapshot, {
          ruleKey: "SO4_CANNIBALIZATION",
          kind: "RISK",
          subject: `query:${query.queryId}`,
          severity: "INFO",
          confidence,
          effort: "M",
          actionKind: "CONSOLIDATE",
          impact:
            missed > 0
              ? clicksImpact(missed * MONTH_FACTOR * 0.5, confidence)
              : null,
          ...cannibalizationCopy({ keyword: query.text, ...metrics }),
          evidence: {
            window: snapshot.current,
            metrics,
            pages: competing
              .slice(0, 5)
              .map((c) =>
                evidencePage(snapshot, c.pair.pageId, c.pair, c.share),
              ),
          },
          pageId: dominant,
          queryId: query.queryId,
          keyword: query.text,
        }),
      });
    }
    return finishRule(items, SO4_MAX);
  },
};
