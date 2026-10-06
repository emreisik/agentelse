import { describe, expect, it } from "vitest";

import type { CrawlFacts, RuleSnapshot } from "@/lib/seo/opportunity-types";

import { isOrganizationType, SO12 } from "./rich-results";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  snapshotFixture,
} from "./test-support";

function withCrawl(pages: CrawlFacts[], overrides: Partial<RuleSnapshot> = {}) {
  return snapshotFixture({
    pages: [page("h", "/", { impressions: 2000, clicks: 100 })],
    crawl: { complete: false, pages, links: [] },
    ...overrides,
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO12.evaluate(snapshot);
  if (!result.evaluable) throw new Error(`not evaluable: ${result.reason}`);
  return result;
}

describe("SO12 rich results", () => {
  it("needs crawl data", () => {
    expect(SO12.evaluate(snapshotFixture())).toEqual({
      evaluable: false,
      reason: "NO_CRAWL",
    });
  });

  it("asks for organization markup on the homepage", () => {
    const snapshot = withCrawl([crawlPage("h", "/")]);
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("site:schema:organization");
    expect(draft.actionKind).toBe("SCHEMA");
    expect(draft.pageId).toBe("h");
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("accepts organization types and their business subtypes", () => {
    expect(isOrganizationType("Organization")).toBe(true);
    expect(isOrganizationType("HomeAndConstructionBusiness")).toBe(true);
    expect(isOrganizationType("Dentist")).toBe(false);
    const subtype = withCrawl([
      crawlPage("h", "/", { schemaTypes: ["AutomotiveBusiness"] }),
    ]);
    expect(run(subtype).drafts).toHaveLength(0);
  });

  it("asks for article and product markup in their sections", () => {
    const snapshot = withCrawl([
      crawlPage("h", "/", { schemaTypes: ["Organization"] }),
      crawlPage("b1", "/blog/first-post"),
      crawlPage("b2", "/blog/second-post", { schemaTypes: ["WebPage"] }),
      crawlPage("s1", "/shop/red-shoe"),
      crawlPage("n1", "/news/launch", { schemaTypes: ["NewsArticle"] }),
    ]);
    const subjects = run(snapshot)
      .drafts.map((d) => d.subject)
      .sort();
    expect(subjects).toEqual([
      "group-schema:/blog:article",
      "group-schema:/shop:product",
    ]);
    for (const draft of run(snapshot).drafts) {
      expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
    }
  });

  it("asks for breadcrumbs on three or more deep pages with traffic", () => {
    const deep = (n: number) =>
      withCrawl(
        [
          crawlPage("h", "/", { schemaTypes: ["Organization"] }),
          ...Array.from({ length: n }, (_, i) =>
            crawlPage(`d${i}`, `/guides/topic-${i}`, {
              schemaTypes: ["Article"],
            }),
          ),
        ],
        {
          pages: Array.from({ length: n }, (_, i) =>
            page(`d${i}`, `/guides/topic-${i}`, { impressions: 100 }),
          ),
        },
      );
    expect(run(deep(2)).drafts).toHaveLength(0);
    const snapshot = deep(3);
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("site:schema:breadcrumbs");
    expect(draft.evidence.metrics).toEqual({ impressions: 300, pages: 3 });
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("never suggests FAQ or HowTo markup", () => {
    const snapshot = withCrawl([
      crawlPage("h", "/"),
      crawlPage("b1", "/blog/how-to-fix-a-roof"),
      crawlPage("f", "/faq"),
      crawlPage("p1", "/products/widget"),
    ]);
    for (const draft of run(snapshot).drafts) {
      expect(`${draft.subject} ${draft.title} ${draft.summary}`).not.toMatch(
        /faq|howto|how-to/i,
      );
    }
  });
});
