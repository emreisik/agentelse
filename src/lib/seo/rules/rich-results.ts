import { reachImpact } from "@/lib/seo/impact";
import type { CrawlFacts, RuleSnapshot } from "@/lib/seo/opportunity-types";

import { richResultsCopy } from "./copy";
import {
  currentPageMetric,
  evidencePage,
  finishRule,
  makeDraft,
  pathGroupOf,
  pathSegments,
  type RankedDraft,
} from "./helpers";
import type { SeoRule } from "./types";

// SO12 zengin sonuçlar (tarama gerekir):
// (a) ana sayfada kuruluş türü yok → site:schema:organization;
// (b) makale bölümlerinde Article/BlogPosting/NewsArticle yok;
// (c) ürün bölümlerinde Product yok;
// (d) ≥ 3 derin (≥ 2 yol bölümü), ≥ 100 gösterimli sayfada BreadcrumbList yok.
// FAQPage/HowTo asla önerilmez (Google bu zengin sonuçları kısıtladı);
// Review/Event/LocalBusiness alt türü denetimleri bilerek yok (docs).

export const SO12_BREADCRUMB_MIN_PAGES = 3;
export const SO12_BREADCRUMB_MIN_IMPRESSIONS = 100;
export const SO12_MAX = 5;

const ORG_TYPES = new Set(
  [
    "Organization",
    "LocalBusiness",
    "Corporation",
    "Store",
    "Restaurant",
    "ProfessionalService",
    "MedicalBusiness",
    "WebSite",
  ].map((t) => t.toLowerCase()),
);
const ARTICLE_TYPES = new Set(["article", "blogposting", "newsarticle"]);
const PRODUCT_TYPES = new Set(["product"]);
export const ARTICLE_GROUPS: readonly string[] = [
  "/blog",
  "/news",
  "/articles",
  "/makale",
  "/makaleler",
  "/haber",
  "/haberler",
  "/yazilar",
  "/insights",
  "/guides",
  "/rehber",
];
export const PRODUCT_GROUPS: readonly string[] = [
  "/product",
  "/products",
  "/urun",
  "/urunler",
  "/shop",
  "/store",
  "/magaza",
];

function typesOf(facts: CrawlFacts): string[] {
  return facts.schemaTypes.map((t) => t.trim().toLowerCase());
}

export function isOrganizationType(type: string): boolean {
  const lower = type.trim().toLowerCase();
  return ORG_TYPES.has(lower) || lower.endsWith("business");
}

function impressionsOf(snapshot: RuleSnapshot, pages: readonly CrawlFacts[]) {
  return pages.reduce(
    (s, p) =>
      s + (p.pageId ? currentPageMetric(snapshot, p.pageId).impressions : 0),
    0,
  );
}

export const SO12: SeoRule = {
  key: "SO12_RICH_RESULTS",
  version: 1,
  querySignal: false,
  evaluate(snapshot) {
    const crawl = snapshot.crawl;
    if (!crawl) return { evaluable: false, reason: "NO_CRAWL" };
    const items: RankedDraft[] = [];
    const base = {
      ruleKey: "SO12_RICH_RESULTS" as const,
      kind: "OPPORTUNITY" as const,
      severity: "INFO" as const,
      confidence: "DIRECTIONAL" as const,
      effort: "S" as const,
      actionKind: "SCHEMA" as const,
    };
    const push = (
      subject: string,
      pages: readonly CrawlFacts[],
      copy: ReturnType<typeof richResultsCopy>,
      metrics: Record<string, number>,
      pageId: string | null = null,
    ) => {
      const impressions = impressionsOf(snapshot, pages);
      const draft = makeDraft(snapshot, {
        ...base,
        subject,
        impact: reachImpact(impressions),
        ...copy,
        evidence: {
          window: snapshot.current,
          metrics: { impressions: Math.round(impressions), ...metrics },
          pages: pages
            .filter((p) => p.pageId)
            .slice(0, 10)
            .map((p) =>
              evidencePage(
                snapshot,
                p.pageId!,
                currentPageMetric(snapshot, p.pageId!),
              ),
            ),
        },
        pageId,
      });
      items.push({ draft, rank: draft.priority });
    };

    const home = crawl.pages.find((p) => p.isHomepage);
    if (home && !home.schemaTypes.some(isOrganizationType)) {
      push(
        "site:schema:organization",
        [home],
        richResultsCopy({ variant: "organization" }),
        {},
        home.pageId,
      );
    }

    const byGroup = new Map<string, CrawlFacts[]>();
    for (const facts of crawl.pages) {
      if (pathSegments(facts.path) < 2) continue;
      const group = pathGroupOf(facts.path);
      byGroup.set(group, [...(byGroup.get(group) ?? []), facts]);
    }
    const groupCheck = (
      groups: readonly string[],
      types: ReadonlySet<string>,
      variant: "article" | "product",
    ) => {
      for (const group of groups) {
        const pages = byGroup.get(group) ?? [];
        if (pages.length === 0) continue;
        if (pages.some((p) => typesOf(p).some((t) => types.has(t)))) continue;
        push(
          `group-schema:${group}:${variant}`,
          pages,
          richResultsCopy({ variant, group }),
          { pages: pages.length },
        );
      }
    };
    groupCheck(ARTICLE_GROUPS, ARTICLE_TYPES, "article");
    groupCheck(PRODUCT_GROUPS, PRODUCT_TYPES, "product");

    const deep = crawl.pages.filter(
      (p) =>
        p.pageId !== null &&
        pathSegments(p.path) >= 2 &&
        currentPageMetric(snapshot, p.pageId).impressions >=
          SO12_BREADCRUMB_MIN_IMPRESSIONS &&
        !typesOf(p).includes("breadcrumblist"),
    );
    if (deep.length >= SO12_BREADCRUMB_MIN_PAGES) {
      const impressions = Math.round(impressionsOf(snapshot, deep));
      push(
        "site:schema:breadcrumbs",
        deep,
        richResultsCopy({
          variant: "breadcrumbs",
          pages: deep.length,
          impressions,
        }),
        { pages: deep.length },
      );
    }
    return finishRule(items, SO12_MAX);
  },
};
