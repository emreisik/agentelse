import { expectedCtr } from "@/lib/seo/ctr-curve";
import { avgPosition, clicksImpact, MONTH_FACTOR } from "@/lib/seo/impact";
import type { PairStat } from "@/lib/seo/opportunity-types";

import { ctrGapCopy } from "./copy";
import {
  evidenceQuery,
  finishRule,
  makeDraft,
  pagePathOf,
  round3,
  snapshotIndex,
  topQueryOfPage,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO2 tıklama oranı açığı: sayfanın ilk sayfadaki (1–10) markasız çiftleri
// toplanır; ≥ 500 gösterimde gerçek tıklama, eğrinin beklediğinin %70'inin
// altındaysa başlık/açıklama önerilir. Etki = kaçan tıklama × ay çarpanı.

export const SO2_POSITION_MIN = 1;
export const SO2_POSITION_MAX = 10;
export const SO2_MIN_IMPRESSIONS = 500;
export const SO2_SIGNIFICANT_IMPRESSIONS = 1000;
export const SO2_GAP_RATIO = 0.7;
export const SO2_MAX = 10;

export const SO2: SeoRule = {
  key: "SO2_CTR_GAP",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const index = snapshotIndex(snapshot);
    const curve = snapshot.curves.nonBrand;
    const byPage = new Map<
      string,
      { pair: PairStat; position: number; expected: number }[]
    >();
    for (const pair of snapshot.pairs) {
      if (index.brandish.get(pair.queryId) !== false) continue;
      const position = avgPosition(pair);
      if (position === null) continue;
      if (position < SO2_POSITION_MIN || position > SO2_POSITION_MAX) continue;
      const list = byPage.get(pair.pageId) ?? [];
      list.push({ pair, position, expected: expectedCtr(curve, position) });
      byPage.set(pair.pageId, list);
    }

    const items: RankedDraft[] = [];
    for (const [pageId, rows] of byPage) {
      let impressions = 0;
      let expected = 0;
      let clicks = 0;
      for (const row of rows) {
        impressions += row.pair.impressions;
        expected += row.expected * row.pair.impressions;
        clicks += row.pair.clicks;
      }
      if (impressions < SO2_MIN_IMPRESSIONS) continue;
      if (!(clicks < SO2_GAP_RATIO * expected)) continue;
      const confidence =
        impressions >= SO2_SIGNIFICANT_IMPRESSIONS && curve.source === "site"
          ? "SIGNIFICANT"
          : "DIRECTIONAL";
      const missed = (expected - clicks) * MONTH_FACTOR;
      const metrics = {
        impressions: Math.round(impressions),
        clicks: Math.round(clicks),
        expectedClicks: Math.round(expected),
        actualCtr: round3(clicks / impressions),
        expectedCtr: round3(expected / impressions),
      };
      const top = [...rows]
        .sort(
          (a, b) =>
            b.pair.impressions - a.pair.impressions ||
            a.pair.queryId.localeCompare(b.pair.queryId),
        )
        .slice(0, 5);
      items.push({
        rank: missed,
        draft: makeDraft(snapshot, {
          ruleKey: "SO2_CTR_GAP",
          kind: "OPPORTUNITY",
          subject: `page:${pageId}`,
          severity: "INFO",
          confidence,
          effort: "S",
          actionKind: "TITLE_META",
          impact: clicksImpact(missed, confidence),
          ...ctrGapCopy({ path: pagePathOf(snapshot, pageId), ...metrics }),
          evidence: {
            window: snapshot.current,
            metrics,
            queries: top.flatMap((row) => {
              const query = index.queries.get(row.pair.queryId);
              return query
                ? [
                    evidenceQuery(query, row.pair, {
                      expectedCtr: row.expected,
                    }),
                  ]
                : [];
            }),
          },
          pageId,
          keyword: topQueryOfPage(snapshot, pageId)?.text ?? null,
        }),
      });
    }
    return finishRule(items, SO2_MAX);
  },
};
