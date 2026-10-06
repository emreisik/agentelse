import { describe, expect, it } from "vitest";

import {
  clusterTopQuery,
  crawlFactsFor,
  finishRule,
  hasIndexProblem,
  isBrandish,
  makeDraft,
  pagePathOf,
  pathGroupOf,
  percentile,
  topQueryOfPage,
} from "./helpers";
import { crawlPage, page, pair, query, snapshotFixture } from "./test-support";

describe("rule helpers", () => {
  it("marks brand queries by flag or fuzzy match", () => {
    expect(isBrandish({ text: "shoes", isBrand: true }, [])).toBe(true);
    expect(
      isBrandish({ text: "agentelse pricing", isBrand: false }, ["agentelse"]),
    ).toBe(true);
    expect(
      isBrandish({ text: "agentels pricing", isBrand: false }, ["agentelse"]),
    ).toBe(true);
    expect(
      isBrandish({ text: "running shoes", isBrand: false }, ["agentelse"]),
    ).toBe(false);
  });

  it("interpolates percentiles", () => {
    expect(percentile([], 75)).toBe(0);
    expect(percentile([10], 75)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 75)).toBe(4);
    expect(percentile([0, 10], 75)).toBe(7.5);
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });

  it("derives path groups", () => {
    expect(pathGroupOf("/blog/post")).toBe("/blog");
    expect(pathGroupOf("/")).toBe("/");
    expect(pathGroupOf("/about")).toBe("/about");
  });

  const snapshot = snapshotFixture({
    queries: [
      query("q1", "alpha", { impressions: 100 }),
      query("q2", "beta", { impressions: 300 }),
    ],
    pages: [page("p1", "/one")],
    pairs: [
      pair("q1", "p1", { clicks: 5, impressions: 50 }),
      pair("q2", "p1", { clicks: 5, impressions: 80 }),
    ],
    previousPairs: [
      pair("q1", "p1", { clicks: 9, impressions: 50 }),
      pair("gone", "p1", { clicks: 20, impressions: 90 }),
    ],
    inspections: [{ pageId: "p2", verdict: "FAIL", coverageState: null }],
    crawl: {
      complete: true,
      pages: [crawlPage("p3", "/crawled-only", { status: 404 })],
      links: [],
    },
    clusters: [
      {
        clusterId: "c1",
        name: "x",
        queryIds: ["q1", "q2", "missing"],
        pillarPageId: null,
      },
    ],
  });

  it("finds a page's top query by clicks, then impressions", () => {
    expect(topQueryOfPage(snapshot, "p1")?.text).toBe("beta");
    // Önceki pencerede metni bilinmeyen sorgu atlanır.
    expect(topQueryOfPage(snapshot, "p1", "previous")?.text).toBe("alpha");
    expect(topQueryOfPage(snapshot, "nope")).toBeNull();
  });

  it("finds a cluster's top query", () => {
    expect(clusterTopQuery(snapshot, "c1")?.text).toBe("beta");
    expect(clusterTopQuery(snapshot, "c2")).toBeNull();
  });

  it("resolves paths and crawl facts", () => {
    expect(pagePathOf(snapshot, "p1")).toBe("/one");
    expect(pagePathOf(snapshot, "p3")).toBe("/crawled-only");
    expect(pagePathOf(snapshot, "zz")).toBe("");
    expect(crawlFactsFor(snapshot, "p3")?.status).toBe(404);
    expect(crawlFactsFor(snapshot, "p1")).toBeNull();
  });

  it("detects index problems from crawl and inspection", () => {
    expect(hasIndexProblem(snapshot, "p1")).toBe(false);
    expect(hasIndexProblem(snapshot, "p2")).toBe(true);
    expect(hasIndexProblem(snapshot, "p3")).toBe(true);
  });

  it("builds drafts with the weekly period and priority", () => {
    const draft = makeDraft(snapshot, {
      ruleKey: "SO2_CTR_GAP",
      kind: "OPPORTUNITY",
      subject: "page:p1",
      severity: "INFO",
      confidence: "DIRECTIONAL",
      effort: "M",
      actionKind: "CONTENT_REFRESH",
      impact: { kind: "clicks", perMonth: 40, low: 20, high: 60 },
      title: "t",
      summary: "s",
      evidence: { window: snapshot.current, metrics: {} },
    });
    expect(draft).toMatchObject({
      ruleVersion: 1,
      periodStart: "2026-08-31",
      periodEnd: "2026-09-27",
      periodKey: "W:2026-09-27",
      priority: 10,
      keyword: null,
      ideaWorthy: false,
    });
  });

  it("caps by rank but keeps every subject in seen", () => {
    const items = ["a", "b", "c"].map((id, i) => ({
      rank: i,
      draft: makeDraft(snapshot, {
        ruleKey: "SO2_CTR_GAP",
        kind: "OPPORTUNITY",
        subject: `page:${id}`,
        severity: "INFO",
        confidence: "DIRECTIONAL",
        effort: "S",
        actionKind: "TITLE_META",
        impact: null,
        title: "t",
        summary: "s",
        evidence: { window: snapshot.current, metrics: {} },
      }),
    }));
    const result = finishRule(items, 2);
    expect(result.evaluable && result.drafts.map((d) => d.subject)).toEqual([
      "page:c",
      "page:b",
    ]);
    expect(result.evaluable && result.seen.sort()).toEqual([
      "page:a",
      "page:b",
      "page:c",
    ]);
  });
});
