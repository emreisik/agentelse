import { describe, expect, it } from "vitest";

import type { CrawlSnapshot, RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO8 } from "./internal-links";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  pair,
  query,
  snapshotFixture,
} from "./test-support";

function build(input: {
  inlinks?: number;
  impressions?: number;
  crawl?: Partial<CrawlSnapshot>;
  cluster?: boolean;
}): RuleSnapshot {
  const impressions = input.impressions ?? 300;
  const clusterId = input.cluster ? "c1" : null;
  return snapshotFixture({
    queries: [
      query("q1", "roof repair cost", { impressions, position: 9, clusterId }),
      query("q2", "roof leak fix", {
        impressions: 500,
        position: 4,
        clusterId,
      }),
    ],
    pages: [
      page("t", "/services/roof-repair", { impressions, clicks: 6 }),
      page("g", "/services/gutter-cleaning", { impressions: 900, clicks: 50 }),
      page("b", "/blog/roof-leaks", { impressions: 500, clicks: 30 }),
    ],
    pairs: [
      pair("q1", "t", { impressions, clicks: 6, position: 9 }),
      pair("q2", "b", { impressions: 500, clicks: 30, position: 4 }),
    ],
    clusters: input.cluster
      ? [
          {
            clusterId: "c1",
            name: "Roof repair",
            queryIds: ["q1", "q2"],
            pillarPageId: null,
          },
        ]
      : [],
    crawl: {
      complete: true,
      pages: [
        crawlPage("t", "/services/roof-repair", {
          inlinks: input.inlinks ?? 1,
        }),
        crawlPage("g", "/services/gutter-cleaning"),
        crawlPage("b", "/blog/roof-leaks"),
      ],
      links: [],
      ...input.crawl,
    },
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO8.evaluate(snapshot);
  if (!result.evaluable) throw new Error(`not evaluable: ${result.reason}`);
  return result;
}

describe("SO8 internal links", () => {
  it("needs a complete crawl", () => {
    expect(SO8.evaluate(snapshotFixture({ crawl: null }))).toEqual({
      evaluable: false,
      reason: "NO_CRAWL",
    });
    expect(SO8.evaluate(build({ crawl: { complete: false } }))).toEqual({
      evaluable: false,
      reason: "NO_CRAWL",
    });
  });

  it("uses the inlinks ≤ 2 boundary", () => {
    expect(run(build({ inlinks: 3 })).drafts).toHaveLength(0);
    const snapshot = build({ inlinks: 2 });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("page:t");
    expect(draft.actionKind).toBe("INTERNAL_LINKS");
    expect(draft.keyword).toBe("roof repair cost");
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("needs at least 100 impressions", () => {
    expect(run(build({ impressions: 99 })).drafts).toHaveLength(0);
  });

  it("prefers pages ranking in the target's cluster", () => {
    const draft = run(build({ cluster: true })).drafts[0]!;
    expect(draft.evidence.links).toEqual([
      {
        fromPath: "/blog/roof-leaks",
        toPath: "/services/roof-repair",
        anchor: "roof repair cost",
      },
    ]);
  });

  it("falls back to the same section by clicks", () => {
    const draft = run(build({})).drafts[0]!;
    expect(draft.evidence.links?.map((l) => l.fromPath)).toEqual([
      "/services/gutter-cleaning",
    ]);
  });

  it("skips pages that already link to the target", () => {
    const snapshot = build({
      crawl: {
        links: [
          {
            fromPageId: "g",
            fromPath: "/services/gutter-cleaning",
            toPageId: "t",
            toPath: "/services/roof-repair",
          },
        ],
      },
    });
    expect(run(snapshot).drafts).toHaveLength(0);
  });

  it("never targets the homepage", () => {
    const snapshot = snapshotFixture({
      pages: [
        page("h", "/", { impressions: 500 }),
        page("x", "/x", { impressions: 500, clicks: 5 }),
      ],
      crawl: {
        complete: true,
        pages: [crawlPage("h", "/", { inlinks: 0 }), crawlPage("x", "/x")],
        links: [],
      },
    });
    expect(run(snapshot).drafts).toHaveLength(0);
  });
});
