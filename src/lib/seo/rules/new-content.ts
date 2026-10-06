import { addDays } from "@/lib/seo/dates";
import { reachImpact } from "@/lib/seo/impact";

import { newContentCopy } from "./copy";
import {
  crawlFactsFor,
  evidencePage,
  finishRule,
  makeDraft,
  median,
  snapshotIndex,
  topQueryOfPage,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO15 yeni içerik: ilk görüldüğü hafta pencerenin sonundan 90–28 gün önce
// olan sayfalar "yeni"dir. ≥ 3 yeni sayfa ve gösterim medyanı (M) ≥ 20 ise,
// M'nin yarısından az gösterim alan yeni sayfalar incelenir. firstSeenWeek
// geri doldurma bitmeden anlamsız olduğundan ≥ 20 haftalık geçmiş ya da
// tamamlanmış backfill gerekir.

export const SO15_MIN_HISTORY_WEEKS = 20;
export const SO15_NEW_FROM_DAYS = 90;
export const SO15_NEW_TO_DAYS = 28;
export const SO15_MIN_PAGES = 3;
export const SO15_MIN_MEDIAN = 20;
export const SO15_LOW_SHARE = 0.5;
export const SO15_MAX = 5;
export const SO15_NOT_INDEXED_NOTE =
  "Google has not confirmed this page as indexed; check it in URL Inspection.";
export const SO15_FEW_LINKS_NOTE =
  "Few internal links point to this page; link to it from related pages.";
const FEW_INLINKS = 2;

export const SO15: SeoRule = {
  key: "SO15_NEW_CONTENT",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    if (
      snapshot.historyWeeks < SO15_MIN_HISTORY_WEEKS &&
      !snapshot.backfillDone
    ) {
      return { evaluable: false, reason: "LOW_HISTORY" };
    }
    const from = addDays(snapshot.current.to, -SO15_NEW_FROM_DAYS);
    const to = addDays(snapshot.current.to, -SO15_NEW_TO_DAYS);
    const fresh = snapshot.pages.filter(
      (p) => p.firstSeenWeek >= from && p.firstSeenWeek <= to,
    );
    const items: RankedDraft[] = [];
    if (fresh.length < SO15_MIN_PAGES) return finishRule(items, SO15_MAX);
    const M = median(fresh.map((p) => p.impressions));
    if (M < SO15_MIN_MEDIAN) return finishRule(items, SO15_MAX);
    const inspections = snapshotIndex(snapshot).inspectionByPage;

    for (const page of fresh) {
      if (page.impressions >= SO15_LOW_SHARE * M) continue;
      const notes: string[] = [];
      const verdict = inspections.get(page.pageId);
      if (verdict !== undefined && verdict !== "PASS") {
        notes.push(SO15_NOT_INDEXED_NOTE);
      }
      const facts = crawlFactsFor(snapshot, page.pageId);
      if (facts && facts.inlinks <= FEW_INLINKS)
        notes.push(SO15_FEW_LINKS_NOTE);
      const metrics = {
        impressions: Math.round(page.impressions),
        typicalImpressions: Math.round(M),
        newPages: fresh.length,
      };
      items.push({
        rank: M - page.impressions,
        draft: makeDraft(snapshot, {
          ruleKey: "SO15_NEW_CONTENT",
          kind: "RISK",
          subject: `page:${page.pageId}`,
          severity: "INFO",
          confidence: "DIRECTIONAL",
          effort: "S",
          actionKind: "INVESTIGATE",
          impact: reachImpact(M - page.impressions),
          ...newContentCopy({ path: page.path, ...metrics }),
          evidence: {
            window: snapshot.current,
            metrics,
            pages: [evidencePage(snapshot, page.pageId, page)],
            ...(notes.length > 0 ? { notes } : {}),
          },
          pageId: page.pageId,
          keyword: topQueryOfPage(snapshot, page.pageId)?.text ?? null,
        }),
      });
    }
    return finishRule(items, SO15_MAX);
  },
};
