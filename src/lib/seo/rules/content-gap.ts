import { expectedCtr } from "@/lib/seo/ctr-curve";
import { avgPosition, clicksImpact, MONTH_FACTOR } from "@/lib/seo/impact";
import { isLocalQuery } from "@/lib/seo/intent";
import type {
  QueryStat,
  RuleSnapshot,
  SeoFindingDraft,
  SeoImpact,
} from "@/lib/seo/opportunity-types";
import { meaningfulTokens } from "@/lib/seo/tokens";
import { foldForMatch } from "@/lib/text-fold";

import { contentGapCopy } from "./copy";
import {
  bestPairOf,
  clusterTopQuery,
  crawlFactsFor,
  evidenceQuery,
  finishRule,
  makeDraft,
  nonBrandQueries,
  pagePathOf,
  round3,
  snapshotIndex,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO5 içerik boşluğu: markasız, gezinme amaçlı olmayan, yerel olmayan ve
// Q ≥ 100 sorgular.
// - Boşluk A: hiç sayfa yok ya da en iyi sayfa 20. sıranın gerisinde → yeni
//   içerik.
// - Boşluk B (yalnız tarama varsa): en iyi sayfa ilk 20'de ama başlık ve
//   başlıklar sorgu sözcüklerinin yarısından azını içeriyor → içerik yenileme.
// Aynı kümede ≥ 2 boşluk tek küme bulgusu olur. Etki: 5. sıranın beklenen
// tıklaması − bugünkü, aylık, yarı ağırlıkla; daima DIRECTIONAL.

export const SO5_MIN_IMPRESSIONS = 100;
export const SO5_DEEP_POSITION = 20;
export const SO5_MIN_COVERAGE = 0.5;
export const SO5_TARGET_POSITION = 5;
export const SO5_CLUSTER_MIN = 2;
export const SO5_MAX = 10;

type Gap = {
  query: QueryStat;
  variant: "missing" | "deep" | "partial";
  pageId: string | null;
  position: number | null;
  coverage: number | null;
};

function gapImpact(
  snapshot: RuleSnapshot,
  Q: number,
  clicks: number,
): SeoImpact {
  const expected =
    expectedCtr(snapshot.curves.nonBrand, SO5_TARGET_POSITION) * Q;
  return clicksImpact(
    Math.max(0, expected - clicks) * MONTH_FACTOR * 0.5,
    "DIRECTIONAL",
  );
}

// Sorgu sözcüklerinin başlık + H1 + H2 içinde geçen oranı.
export function tokenCoverage(
  tokens: readonly string[],
  texts: readonly (string | null)[],
): number {
  if (tokens.length === 0) return 1;
  const folded = foldForMatch(texts.filter(Boolean).join(" "));
  const found = tokens.filter((t) => folded.includes(foldForMatch(t))).length;
  return found / tokens.length;
}

function findGap(
  snapshot: RuleSnapshot,
  query: QueryStat,
  tokens: string[],
): Gap | null {
  const best = bestPairOf(snapshot, query.queryId);
  const position = best ? avgPosition(best) : null;
  if (!best || position === null) {
    return {
      query,
      variant: "missing",
      pageId: null,
      position: null,
      coverage: null,
    };
  }
  if (position > SO5_DEEP_POSITION) {
    return { query, variant: "deep", pageId: null, position, coverage: null };
  }
  const facts = crawlFactsFor(snapshot, best.pageId);
  if (!facts) return null;
  const coverage = tokenCoverage(tokens, [
    facts.title,
    ...facts.h1,
    ...facts.h2,
  ]);
  if (coverage >= SO5_MIN_COVERAGE) return null;
  return { query, variant: "partial", pageId: best.pageId, position, coverage };
}

export const SO5: SeoRule = {
  key: "SO5_CONTENT_GAP",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const index = snapshotIndex(snapshot);
    const gaps: Gap[] = [];
    for (const query of nonBrandQueries(snapshot)) {
      if (query.impressions < SO5_MIN_IMPRESSIONS) continue;
      if (query.intent === "navigational") continue;
      if (isLocalQuery(query.text)) continue;
      const tokens = meaningfulTokens(query.text, snapshot.brandTerms);
      if (tokens.length < 1) continue;
      const gap = findGap(snapshot, query, tokens);
      if (gap) gaps.push(gap);
    }

    const byCluster = new Map<string, Gap[]>();
    for (const gap of gaps) {
      const clusterId = gap.query.clusterId;
      if (!clusterId || !index.clusters.has(clusterId)) continue;
      byCluster.set(clusterId, [...(byCluster.get(clusterId) ?? []), gap]);
    }

    const items: RankedDraft[] = [];
    const inCluster = new Set<string>();
    for (const [clusterId, members] of byCluster) {
      if (members.length < SO5_CLUSTER_MIN) continue;
      const top = clusterTopQuery(snapshot, clusterId);
      if (!top) continue;
      for (const m of members) inCluster.add(m.query.queryId);
      const Q = members.reduce((s, m) => s + m.query.impressions, 0);
      const clicks = members.reduce((s, m) => s + m.query.clicks, 0);
      const refresh = members.every((m) => m.variant === "partial");
      const metrics = {
        impressions: Math.round(Q),
        clicks: Math.round(clicks),
        queries: members.length,
      };
      items.push({
        rank: Q,
        draft: makeDraft(snapshot, {
          ruleKey: "SO5_CONTENT_GAP",
          kind: "OPPORTUNITY",
          subject: `cluster:${clusterId}`,
          severity: "INFO",
          confidence: "DIRECTIONAL",
          effort: refresh ? "M" : "L",
          actionKind: refresh ? "CONTENT_REFRESH" : "NEW_CONTENT",
          impact: gapImpact(snapshot, Q, clicks),
          ...contentGapCopy({
            variant: "cluster",
            keyword: top.text,
            impressions: metrics.impressions,
            queries: metrics.queries,
          }),
          evidence: {
            window: snapshot.current,
            metrics,
            queries: [...members]
              .sort((a, b) => b.query.impressions - a.query.impressions)
              .slice(0, 10)
              .map((m) => evidenceQuery(m.query, m.query)),
          },
          clusterId,
          keyword: top.text,
          ideaWorthy: true,
        }),
      });
    }

    for (const gap of gaps) {
      if (inCluster.has(gap.query.queryId)) continue;
      items.push({
        rank: gap.query.impressions,
        draft: queryDraft(snapshot, gap),
      });
    }
    return finishRule(items, SO5_MAX);
  },
};

function queryDraft(snapshot: RuleSnapshot, gap: Gap): SeoFindingDraft {
  const { query } = gap;
  const metrics: Record<string, number> = {
    impressions: Math.round(query.impressions),
    clicks: Math.round(query.clicks),
  };
  if (gap.position !== null)
    metrics.position = Math.round(gap.position * 10) / 10;
  if (gap.coverage !== null) metrics.coverageShare = round3(gap.coverage);
  const partial = gap.variant === "partial";
  const path = gap.pageId ? pagePathOf(snapshot, gap.pageId) : "";
  return makeDraft(snapshot, {
    ruleKey: "SO5_CONTENT_GAP",
    kind: "OPPORTUNITY",
    subject: `query:${query.queryId}`,
    severity: "INFO",
    confidence: "DIRECTIONAL",
    effort: partial ? "M" : "L",
    actionKind: partial ? "CONTENT_REFRESH" : "NEW_CONTENT",
    impact: gapImpact(snapshot, query.impressions, query.clicks),
    ...(gap.variant === "partial"
      ? contentGapCopy({
          variant: "partial",
          keyword: query.text,
          impressions: metrics.impressions!,
          path,
        })
      : contentGapCopy({
          variant: gap.variant,
          keyword: query.text,
          impressions: metrics.impressions!,
        })),
    evidence: {
      window: snapshot.current,
      metrics,
      queries: [evidenceQuery(query, query)],
    },
    pageId: gap.pageId,
    queryId: query.queryId,
    keyword: query.text,
    ideaWorthy: true,
  });
}
