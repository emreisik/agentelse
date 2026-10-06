import { reachImpact } from "@/lib/seo/impact";

import { mediaSearchCopy } from "./copy";
import {
  crawlFactsFor,
  evidencePage,
  finishRule,
  makeDraft,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO14 görsel ve video araması (tarama gerekir):
// - görsel araması ≥ 200 gösterimse web gösterimine göre ilk 20 sayfada alt
//   metni eksik görseller → site:images;
// - video araması ≥ 200 gösterimse ve hiçbir taranan sayfada VideoObject
//   yoksa → site:video.

export const SO14_MIN_IMPRESSIONS = 200;
export const SO14_TOP_PAGES = 20;
export const SO14_MAX = 2;

export const SO14: SeoRule = {
  key: "SO14_MEDIA_SEARCH",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const crawl = snapshot.crawl;
    if (!crawl) return { evaluable: false, reason: "NO_CRAWL" };
    const items: RankedDraft[] = [];
    const { image, video } = snapshot.searchTypes;

    if (image >= SO14_MIN_IMPRESSIONS) {
      const pages = [...snapshot.pages]
        .sort(
          (a, b) =>
            b.impressions - a.impressions || a.pageId.localeCompare(b.pageId),
        )
        .slice(0, SO14_TOP_PAGES)
        .filter(
          (p) => (crawlFactsFor(snapshot, p.pageId)?.imagesNoAlt ?? 0) > 0,
        );
      if (pages.length > 0) {
        const metrics = {
          imageImpressions: Math.round(image),
          pages: pages.length,
        };
        const draft = makeDraft(snapshot, {
          ruleKey: "SO14_MEDIA_SEARCH",
          kind: "OPPORTUNITY",
          subject: "site:images",
          severity: "INFO",
          confidence: "DIRECTIONAL",
          effort: "S",
          actionKind: "TECH_FIX",
          impact: reachImpact(image),
          ...mediaSearchCopy({
            variant: "images",
            impressions: metrics.imageImpressions,
            pages: metrics.pages,
          }),
          evidence: {
            window: snapshot.current,
            metrics,
            pages: pages
              .slice(0, 10)
              .map((p) => evidencePage(snapshot, p.pageId, p)),
          },
        });
        items.push({ draft, rank: draft.priority });
      }
    }

    const hasVideoMarkup = crawl.pages.some((p) =>
      p.schemaTypes.some((t) => t.trim().toLowerCase() === "videoobject"),
    );
    if (video >= SO14_MIN_IMPRESSIONS && !hasVideoMarkup) {
      const metrics = { videoImpressions: Math.round(video) };
      const draft = makeDraft(snapshot, {
        ruleKey: "SO14_MEDIA_SEARCH",
        kind: "OPPORTUNITY",
        subject: "site:video",
        severity: "INFO",
        confidence: "DIRECTIONAL",
        effort: "S",
        actionKind: "SCHEMA",
        impact: reachImpact(video),
        ...mediaSearchCopy({
          variant: "video",
          impressions: metrics.videoImpressions,
        }),
        evidence: { window: snapshot.current, metrics },
      });
      items.push({ draft, rank: draft.priority });
    }
    return finishRule(items, SO14_MAX);
  },
};
