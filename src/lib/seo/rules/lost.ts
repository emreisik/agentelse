import { clicksImpact, MONTH_FACTOR } from "@/lib/seo/impact";

import { lostCopy } from "./copy";
import {
  currentPageMetric,
  evidencePage,
  evidenceQuery,
  finishRule,
  hasIndexProblem,
  makeDraft,
  pagePathOf,
  snapshotIndex,
  topQueryOfPage,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO7 kaybedilen: önceki 4 haftada ≥ 10 tıklama getirip son 4 haftada hiç
// getirmeyen sayfalar ve sorgular (marka dahil). Sayfa hata veriyor / noindex /
// denetim FAIL ise teknik düzeltme. Önceki en iyi sayfası kaybedilen bir sayfa
// olan sorgu ayrıca bildirilmez. Şimdiki pencerede hiç görünmeyen sorgunun
// metni anlık görüntüde olmadığından (anahtar kelime kuralı) atlanır.

export const SO7_MIN_PREVIOUS_CLICKS = 10;
export const SO7_SIGNIFICANT_CLICKS = 30;
export const SO7_MAX = 10;
export const SO7_TECH_NOTE =
  "The page now returns an error or is blocked from Google; check it first.";
const PAGE_RANK_OFFSET = 1e12;

export const SO7: SeoRule = {
  key: "SO7_LOST",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    if (!snapshot.previousComplete) {
      return { evaluable: false, reason: "LOW_HISTORY" };
    }
    const index = snapshotIndex(snapshot);
    const items: RankedDraft[] = [];
    const lostPages = new Set<string>();

    for (const previous of snapshot.previousPages) {
      const prev = previous.clicks;
      if (prev < SO7_MIN_PREVIOUS_CLICKS) continue;
      const current = currentPageMetric(snapshot, previous.id);
      if (current.clicks > 0) continue;
      lostPages.add(previous.id);
      const tech = hasIndexProblem(snapshot, previous.id);
      const confidence =
        prev >= SO7_SIGNIFICANT_CLICKS ? "SIGNIFICANT" : "DIRECTIONAL";
      const metrics = {
        previousClicks: Math.round(prev),
        clicks: 0,
        impressions: Math.round(current.impressions),
      };
      items.push({
        rank: PAGE_RANK_OFFSET + prev,
        draft: makeDraft(snapshot, {
          ruleKey: "SO7_LOST",
          kind: "RISK",
          subject: `page:${previous.id}`,
          severity: "WARN",
          confidence,
          effort: "S",
          actionKind: tech ? "TECH_FIX" : "INVESTIGATE",
          impact: clicksImpact(prev * MONTH_FACTOR * 0.5, confidence),
          ...lostCopy({
            variant: "page",
            path: pagePathOf(snapshot, previous.id),
            previousClicks: metrics.previousClicks,
          }),
          evidence: {
            window: snapshot.current,
            compare: snapshot.previous,
            metrics,
            pages: [evidencePage(snapshot, previous.id, previous)],
            ...(tech ? { notes: [SO7_TECH_NOTE] } : {}),
          },
          pageId: previous.id,
          keyword:
            topQueryOfPage(snapshot, previous.id, "previous")?.text ?? null,
          signalWorthy: true,
        }),
      });
    }

    for (const previous of snapshot.previousQueries) {
      const prev = previous.clicks;
      if (prev < SO7_MIN_PREVIOUS_CLICKS) continue;
      const query = index.queries.get(previous.id);
      if (!query || query.clicks > 0) continue;
      const topPage = [
        ...(index.previousPairsByQuery.get(previous.id) ?? []),
      ].sort(
        (a, b) =>
          b.clicks - a.clicks ||
          b.impressions - a.impressions ||
          a.pageId.localeCompare(b.pageId),
      )[0];
      if (topPage && lostPages.has(topPage.pageId)) continue;
      const confidence =
        prev >= SO7_SIGNIFICANT_CLICKS ? "SIGNIFICANT" : "DIRECTIONAL";
      const metrics = {
        previousClicks: Math.round(prev),
        clicks: 0,
        impressions: Math.round(query.impressions),
      };
      items.push({
        rank: prev,
        draft: makeDraft(snapshot, {
          ruleKey: "SO7_LOST",
          kind: "RISK",
          subject: `query:${query.queryId}`,
          severity: "WARN",
          confidence,
          effort: "S",
          actionKind: "INVESTIGATE",
          impact: clicksImpact(prev * MONTH_FACTOR * 0.5, confidence),
          ...lostCopy({
            variant: "query",
            keyword: query.text,
            previousClicks: metrics.previousClicks,
          }),
          evidence: {
            window: snapshot.current,
            compare: snapshot.previous,
            metrics,
            queries: [evidenceQuery(query, query)],
          },
          queryId: query.queryId,
          keyword: query.text,
        }),
      });
    }
    return finishRule(items, SO7_MAX);
  },
};
