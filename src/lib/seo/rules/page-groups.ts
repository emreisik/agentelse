import { clicksImpact, MONTH_FACTOR } from "@/lib/seo/impact";
import type { PageStat } from "@/lib/seo/opportunity-types";

import { pageGroupCopy } from "./copy";
import {
  evidencePage,
  finishRule,
  makeDraft,
  snapshotIndex,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO9 bölüm eğilimi: kök dışındaki, şimdiki pencerede gösterim alan ≥ 5
// sayfalı bölümlerde tıklama önceki 4 haftaya göre ≥ %20 ve ≥ 30 değiştiyse.
// Geçen yılın aynı haftaları biliniyorsa aynı yönde ≥ %20 fark da gerekir
// (mevsimsellik elenir). Düşüş RISK, artış WIN; ikisi de inceleme ister.

export const SO9_MIN_PAGES = 5;
export const SO9_MIN_CHANGE = 0.2;
export const SO9_MIN_CLICKS_DELTA = 30;
export const SO9_MAX = 5;

export const SO9: SeoRule = {
  key: "SO9_PAGE_GROUP_TREND",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    if (!snapshot.previousComplete) {
      return { evaluable: false, reason: "LOW_HISTORY" };
    }
    const index = snapshotIndex(snapshot);
    const yearAgo = snapshot.yearAgoPages
      ? new Map(snapshot.yearAgoPages.map((p) => [p.id, p]))
      : null;
    const groups = new Map<string, PageStat[]>();
    for (const page of snapshot.pages) {
      const group = page.pageGroup;
      if (!group || group === "/" || page.impressions <= 0) continue;
      groups.set(group, [...(groups.get(group) ?? []), page]);
    }

    const items: RankedDraft[] = [];
    for (const [group, pages] of groups) {
      if (pages.length < SO9_MIN_PAGES) continue;
      const C = pages.reduce((s, p) => s + p.clicks, 0);
      const P = pages.reduce(
        (s, p) => s + (index.previousPages.get(p.pageId)?.clicks ?? 0),
        0,
      );
      if (P <= 0) continue;
      const delta = C - P;
      if (Math.abs(delta) / P < SO9_MIN_CHANGE) continue;
      if (Math.abs(delta) < SO9_MIN_CLICKS_DELTA) continue;
      const Y = yearAgo
        ? pages.reduce((s, p) => s + (yearAgo.get(p.pageId)?.clicks ?? 0), 0)
        : null;
      if (Y !== null) {
        const consistent =
          Y > 0
            ? Math.sign(C - Y) === Math.sign(delta) &&
              Math.abs(C - Y) / Y >= SO9_MIN_CHANGE
            : delta > 0 && C > 0;
        if (!consistent) continue;
      }
      const drop = delta < 0;
      const confidence = Y !== null ? "SIGNIFICANT" : "DIRECTIONAL";
      const metrics: Record<string, number> = {
        clicks: Math.round(C),
        previousClicks: Math.round(P),
        pages: pages.length,
        changePercent: Math.round((Math.abs(delta) / P) * 100),
      };
      if (Y !== null) metrics.yearAgoClicks = Math.round(Y);
      items.push({
        rank: Math.abs(delta),
        draft: makeDraft(snapshot, {
          ruleKey: "SO9_PAGE_GROUP_TREND",
          kind: drop ? "RISK" : "WIN",
          subject: `group:${group}`,
          severity: drop ? "WARN" : "INFO",
          confidence,
          effort: "VARIES",
          actionKind: "INVESTIGATE",
          impact: drop
            ? clicksImpact(-delta * MONTH_FACTOR * 0.5, confidence)
            : null,
          ...pageGroupCopy({
            group,
            clicks: metrics.clicks!,
            previousClicks: metrics.previousClicks!,
            yearAgo: Y !== null,
          }),
          evidence: {
            window: snapshot.current,
            compare: snapshot.previous,
            metrics,
            pages: [...pages]
              .sort(
                (a, b) =>
                  b.clicks - a.clicks || a.pageId.localeCompare(b.pageId),
              )
              .slice(0, 5)
              .map((p) => evidencePage(snapshot, p.pageId, p)),
          },
          signalWorthy: true,
        }),
      });
    }
    return finishRule(items, SO9_MAX);
  },
};
