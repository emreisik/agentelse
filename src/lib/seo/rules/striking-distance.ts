import { expectedCtr } from "@/lib/seo/ctr-curve";
import {
  avgPosition,
  clicksImpact,
  strikingGain,
  targetPosition,
} from "@/lib/seo/impact";
import type { PairStat, QueryStat } from "@/lib/seo/opportunity-types";

import { strikingDistanceCopy } from "./copy";
import {
  crawlFactsFor,
  evidenceQuery,
  finishRule,
  isHomepage,
  makeDraft,
  pagePathOf,
  percentile,
  snapshotIndex,
  topQueryOfPage,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO1 vuruş mesafesi: markasız sorgularda 4–20. sırada duran, sorgunun
// gösteriminin ≥ %80'ini alan ve yeterince gösterim (≥ max(100, p75)) toplayan
// çiftler sayfa başına toplanır; hedef konuma çıkınca beklenen aylık ek
// tıklama ≥ 5 ise bulgu. Az iç bağlantılı (≤ 2) sayfaya önce iç bağlantı,
// diğerlerine içerik yenileme önerilir.

export const SO1_POSITION_MIN = 4;
export const SO1_POSITION_MAX = 20;
export const SO1_MIN_IMPRESSIONS = 100;
export const SO1_IMPRESSION_PERCENTILE = 75;
export const SO1_MIN_SHARE = 0.8;
export const SO1_MIN_GAIN = 5;
export const SO1_SIGNIFICANT_IMPRESSIONS = 500;
export const SO1_MAX_INLINKS = 2;
export const SO1_MAX = 10;

type Qualified = {
  pair: PairStat;
  query: QueryStat;
  position: number;
  share: number;
  gain: number;
};

export const SO1: SeoRule = {
  key: "SO1_STRIKING_DISTANCE",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const index = snapshotIndex(snapshot);
    const curve = snapshot.curves.nonBrand;
    const nonBrandPairs = snapshot.pairs.filter(
      (p) => index.brandish.get(p.queryId) === false && p.impressions > 0,
    );
    const threshold = Math.max(
      SO1_MIN_IMPRESSIONS,
      percentile(
        nonBrandPairs.map((p) => p.impressions),
        SO1_IMPRESSION_PERCENTILE,
      ),
    );
    const byPage = new Map<string, Qualified[]>();
    for (const pair of nonBrandPairs) {
      const query = index.queries.get(pair.queryId);
      const position = avgPosition(pair);
      if (!query || position === null || query.impressions <= 0) continue;
      if (position < SO1_POSITION_MIN || position > SO1_POSITION_MAX) continue;
      if (pair.impressions < threshold) continue;
      const share = pair.impressions / query.impressions;
      if (share < SO1_MIN_SHARE) continue;
      const gain = strikingGain({
        impressions: pair.impressions,
        clicks: pair.clicks,
        position,
        curve,
      });
      const list = byPage.get(pair.pageId) ?? [];
      list.push({ pair, query, position, share, gain });
      byPage.set(pair.pageId, list);
    }

    const items: RankedDraft[] = [];
    for (const [pageId, qualified] of byPage) {
      const gain = qualified.reduce((sum, q) => sum + q.gain, 0);
      if (gain < SO1_MIN_GAIN) continue;
      const impressions = qualified.reduce(
        (sum, q) => sum + q.pair.impressions,
        0,
      );
      const confidence =
        impressions >= SO1_SIGNIFICANT_IMPRESSIONS && curve.source === "site"
          ? "SIGNIFICANT"
          : "DIRECTIONAL";
      const facts = crawlFactsFor(snapshot, pageId);
      const links =
        facts !== null &&
        facts.inlinks <= SO1_MAX_INLINKS &&
        !isHomepage(snapshot, pageId);
      const path = pagePathOf(snapshot, pageId);
      const metrics = {
        queries: qualified.length,
        impressions: Math.round(impressions),
        gain: Math.round(gain),
      };
      const top = [...qualified]
        .sort(
          (a, b) =>
            b.gain - a.gain || a.query.queryId.localeCompare(b.query.queryId),
        )
        .slice(0, 5);
      items.push({
        rank: gain,
        draft: makeDraft(snapshot, {
          ruleKey: "SO1_STRIKING_DISTANCE",
          kind: "OPPORTUNITY",
          subject: `page:${pageId}`,
          severity: "INFO",
          confidence,
          effort: links ? "S" : "M",
          actionKind: links ? "INTERNAL_LINKS" : "CONTENT_REFRESH",
          impact: clicksImpact(gain, confidence),
          ...strikingDistanceCopy({ path, ...metrics }),
          evidence: {
            window: snapshot.current,
            metrics,
            queries: top.map((q) =>
              evidenceQuery(q.query, q.pair, {
                expectedCtr: expectedCtr(curve, targetPosition(q.position)),
                share: q.share,
              }),
            ),
          },
          pageId,
          keyword: topQueryOfPage(snapshot, pageId)?.text ?? null,
        }),
      });
    }
    return finishRule(items, SO1_MAX);
  },
};
