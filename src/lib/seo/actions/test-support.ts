import { addWeeks } from "@/lib/seo/dates";

import type { PageSeries } from "./did";
import {
  emptyProposal,
  type SeoActionProposalStored,
  type SeoActionView,
  type SeoFixKind,
} from "./types";

// Birim testlerinin ortak kurucuları (yalnız testler içe aktarır).

type WeekValue =
  | number
  | { clicks: number; impressions: number; position?: number };

// startWeek (Pazartesi) ile başlayan ardışık haftalar. Sayı verilirse tıklama
// sayılır: gösterim 10 katı, ortalama konum 5.
export function weekSeries(
  pageId: string,
  startWeek: string,
  values: readonly WeekValue[],
): PageSeries {
  return {
    pageId,
    weeks: values.map((value, index) => {
      const spec =
        typeof value === "number"
          ? { clicks: value, impressions: value * 10, position: 5 }
          : { position: 5, ...value };
      return {
        weekStart: addWeeks(startWeek, index),
        clicks: spec.clicks,
        impressions: spec.impressions,
        positionWeighted: spec.impressions * spec.position,
      };
    }),
  };
}

// Her alanı dolu teklif; gidiş-dönüş testleri bunun üstünden yürür.
export function proposalFixture(kind: SeoFixKind): SeoActionProposalStored {
  const base = emptyProposal(kind);
  switch (base.kind) {
    case "TITLE_META":
      return {
        ...base,
        before: { title: "Old title", metaDescription: "Old description" },
        after: { title: "New title", metaDescription: "New description" },
        variants: [
          { title: "Variant", metaDescription: "Variant meta", angle: "benefit" },
        ],
      };
    case "CONTENT_REFRESH":
      return {
        ...base,
        primaryKeyword: "blue widgets",
        missing: ["pricing", "sizes"],
        after: { title: "Refreshed", metaDescription: "Refreshed meta", wordCount: 900 },
      };
    case "NEW_CONTENT":
    case "LOCALIZE":
      return {
        ...base,
        title: "A new page",
        primaryKeyword: "blue widgets",
        language: "en",
        liveUrl: "https://example.com/blog/new",
      };
    case "INTERNAL_LINKS":
      return {
        ...base,
        links: [
          {
            fromUrl: "https://example.com/a",
            toUrl: "https://example.com/b",
            anchor: "see the guide",
          },
        ],
      };
    case "CONSOLIDATE":
      return {
        ...base,
        from: ["https://example.com/old-1", "https://example.com/old-2"],
        to: "https://example.com/main",
        method: "REDIRECT",
      };
    case "TECH_FIX":
      return { ...base, issue: "CANONICAL", issueCodes: ["TA8"] };
    case "SCHEMA":
      return { ...base, types: ["FAQPage", "Product"] };
    case "CWV_FIX":
      return { ...base, metric: "lcp", formFactor: "PHONE" };
    case "SITEMAP_FIX":
      return { ...base, sitemapUrls: ["https://example.com/sitemap.xml"] };
  }
}

export function actionViewFixture(
  overrides: Partial<SeoActionView> = {},
): SeoActionView {
  const kind = overrides.kind ?? "TITLE_META";
  const at = new Date("2026-09-01T10:00:00.000Z");
  return {
    id: "action-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    isMock: false,
    linkId: "link-1",
    findingId: null,
    source: "FINDING",
    kind,
    status: "APPLIED",
    targetUrl: "https://example.com/page",
    targetUrlHash: "hash-1",
    targetPath: "/page",
    pageId: null,
    targetQueries: [],
    proposal: overrides.proposal ?? proposalFixture(kind),
    baseline: null,
    verification: {
      v: 1,
      attempts: 0,
      quickRetries: null,
      lastCheckedAt: null,
      checks: [],
      method: null,
      liveSince: null,
      google: null,
      reason: null,
    },
    evaluation: null,
    outcome: null,
    confidence: null,
    appliedVia: "USER",
    appliedAt: at,
    verifiedAt: null,
    askedAt: null,
    measureFrom: null,
    evaluateAfter: null,
    evaluatedAt: null,
    nextCheckAt: null,
    windowDays: 28,
    commandId: null,
    workId: null,
    creativeId: null,
    learningId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
