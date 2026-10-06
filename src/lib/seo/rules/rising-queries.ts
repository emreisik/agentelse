import { avgPosition, reachImpact } from "@/lib/seo/impact";
import type { QueryStat, RuleSnapshot } from "@/lib/seo/opportunity-types";

import { risingCopy } from "./copy";
import {
  clusterTopQuery,
  evidenceQuery,
  finishRule,
  makeDraft,
  nonBrandQueries,
  snapshotIndex,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO6 yükselen arama: markasız, Q ≥ 50 ve
// - yeni: ilk görüldüğü hafta şimdiki pencerede (≥ 12 haftalık geçmiş ister);
// - büyüme: önceki pencere tam ve Q ≥ 3 × P (P > 0).
// Önce kümeler (önceki pencere gerekir): Qc ≥ 100 ve Qc ≥ 3 × Pc. Tetiklenen
// kümenin üyeleri ayrıca bildirilmez. En iyi konum ilk 10'daysa içerik
// yenileme, değilse yeni içerik.

export const SO6_MIN_IMPRESSIONS = 50;
export const SO6_CLUSTER_MIN_IMPRESSIONS = 100;
export const SO6_GROWTH = 3;
export const SO6_MIN_HISTORY_WEEKS = 12;
export const SO6_REFRESH_POSITION = 10;
export const SO6_SIGNIFICANT_IMPRESSIONS = 200;
export const SO6_MAX = 10;

// Sorgunun çiftlerindeki en iyi (en küçük) ortalama konum; çift yoksa
// sorgunun kendi ortalaması.
function bestPosition(snapshot: RuleSnapshot, query: QueryStat): number | null {
  const pairs = snapshotIndex(snapshot).pairsByQuery.get(query.queryId) ?? [];
  let best: number | null = null;
  for (const pair of pairs) {
    const position = avgPosition(pair);
    if (position !== null && (best === null || position < best))
      best = position;
  }
  return best ?? avgPosition(query);
}

export const SO6: SeoRule = {
  key: "SO6_RISING_QUERY",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const newBranch = snapshot.historyWeeks >= SO6_MIN_HISTORY_WEEKS;
    const growthBranch = snapshot.previousComplete;
    if (!newBranch && !growthBranch) {
      return { evaluable: false, reason: "LOW_HISTORY" };
    }
    const index = snapshotIndex(snapshot);
    const candidates = nonBrandQueries(snapshot);
    const previousOf = (id: string) =>
      index.previousQueries.get(id)?.impressions ?? 0;
    const items: RankedDraft[] = [];
    const covered = new Set<string>();

    if (growthBranch) {
      const nonBrandIds = new Set(candidates.map((q) => q.queryId));
      for (const cluster of snapshot.clusters) {
        const members = cluster.queryIds.filter((id) => nonBrandIds.has(id));
        const Qc = members.reduce(
          (s, id) => s + (index.queries.get(id)?.impressions ?? 0),
          0,
        );
        const Pc = members.reduce((s, id) => s + previousOf(id), 0);
        if (
          Qc < SO6_CLUSTER_MIN_IMPRESSIONS ||
          Pc <= 0 ||
          Qc < SO6_GROWTH * Pc
        ) {
          continue;
        }
        const top = clusterTopQuery(snapshot, cluster.clusterId);
        if (!top) continue;
        for (const id of members) covered.add(id);
        let position: number | null = null;
        for (const id of members) {
          const p = bestPosition(snapshot, index.queries.get(id)!);
          if (p !== null && (position === null || p < position)) position = p;
        }
        const refresh = position !== null && position <= SO6_REFRESH_POSITION;
        const confidence =
          Qc >= SO6_SIGNIFICANT_IMPRESSIONS ? "SIGNIFICANT" : "DIRECTIONAL";
        const metrics = {
          impressions: Math.round(Qc),
          previousImpressions: Math.round(Pc),
          queries: members.length,
        };
        items.push({
          rank: Qc,
          draft: makeDraft(snapshot, {
            ruleKey: "SO6_RISING_QUERY",
            kind: "OPPORTUNITY",
            subject: `cluster:${cluster.clusterId}`,
            severity: "INFO",
            confidence,
            effort: refresh ? "M" : "L",
            actionKind: refresh ? "CONTENT_REFRESH" : "NEW_CONTENT",
            impact: reachImpact(Qc),
            ...risingCopy({
              variant: "cluster",
              keyword: top.text,
              refresh,
              ...metrics,
            }),
            evidence: {
              window: snapshot.current,
              compare: snapshot.previous,
              metrics,
              queries: members
                .map((id) => index.queries.get(id)!)
                .sort((a, b) => b.impressions - a.impressions)
                .slice(0, 10)
                .map((q) => evidenceQuery(q, q)),
            },
            clusterId: cluster.clusterId,
            keyword: top.text,
            ideaWorthy: true,
            signalWorthy: true,
          }),
        });
      }
    }

    for (const query of candidates) {
      if (covered.has(query.queryId)) continue;
      const Q = query.impressions;
      if (Q < SO6_MIN_IMPRESSIONS) continue;
      const P = previousOf(query.queryId);
      const isNew = newBranch && query.firstSeenWeek >= snapshot.current.from;
      const grew = growthBranch && P > 0 && Q >= SO6_GROWTH * P;
      if (!isNew && !grew) continue;
      const position = bestPosition(snapshot, query);
      const refresh = position !== null && position <= SO6_REFRESH_POSITION;
      const confidence =
        Q >= SO6_SIGNIFICANT_IMPRESSIONS ? "SIGNIFICANT" : "DIRECTIONAL";
      const variant = isNew ? "new" : "growth";
      const metrics: Record<string, number> = { impressions: Math.round(Q) };
      if (variant === "growth") metrics.previousImpressions = Math.round(P);
      items.push({
        rank: Q,
        draft: makeDraft(snapshot, {
          ruleKey: "SO6_RISING_QUERY",
          kind: "OPPORTUNITY",
          subject: `query:${query.queryId}`,
          severity: "INFO",
          confidence,
          effort: refresh ? "M" : "L",
          actionKind: refresh ? "CONTENT_REFRESH" : "NEW_CONTENT",
          impact: reachImpact(Q),
          ...risingCopy({
            variant,
            keyword: query.text,
            impressions: metrics.impressions!,
            previousImpressions: Math.round(P),
            queries: 1,
            refresh,
          }),
          evidence: {
            window: snapshot.current,
            ...(variant === "growth" ? { compare: snapshot.previous } : {}),
            metrics,
            queries: [evidenceQuery(query, query)],
          },
          queryId: query.queryId,
          keyword: query.text,
          ideaWorthy: true,
          signalWorthy: true,
        }),
      });
    }
    return finishRule(items, SO6_MAX);
  },
};
