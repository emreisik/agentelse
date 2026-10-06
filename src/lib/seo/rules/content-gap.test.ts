import { describe, expect, it } from "vitest";

import type { QueryStat, RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO5, tokenCoverage } from "./content-gap";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  pair,
  query,
  snapshotFixture,
} from "./test-support";

function withPair(input: {
  text?: string;
  Q?: number;
  position?: number;
  title?: string | null;
  crawl?: boolean;
  extra?: Partial<QueryStat>;
}): RuleSnapshot {
  const Q = input.Q ?? 300;
  const position = input.position ?? 8;
  return snapshotFixture({
    queries: [
      query("q1", input.text ?? "widget repair", {
        impressions: Q,
        position,
        ...input.extra,
      }),
    ],
    pages: [page("p1", "/services", { impressions: Q, position })],
    pairs: [pair("q1", "p1", { impressions: Q, clicks: 3, position })],
    crawl:
      input.crawl === false
        ? null
        : {
            complete: true,
            pages: [
              crawlPage("p1", "/services", { title: input.title ?? null }),
            ],
            links: [],
          },
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO5.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

describe("SO5 content gap", () => {
  it("finds a search with no page at all (gap A)", () => {
    const snapshot = snapshotFixture({
      queries: [query("q1", "blue widget repair", { impressions: 100 })],
    });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("query:q1");
    expect(draft.actionKind).toBe("NEW_CONTENT");
    expect(draft.effort).toBe("L");
    expect(draft.confidence).toBe("DIRECTIONAL");
    expect(draft.ideaWorthy).toBe(true);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
    const small = snapshotFixture({
      queries: [query("q1", "blue widget repair", { impressions: 99 })],
    });
    expect(run(small).drafts).toHaveLength(0);
  });

  it("treats a best position beyond 20 as gap A", () => {
    expect(
      run(withPair({ position: 20, title: "Widget repair" })).drafts,
    ).toHaveLength(0);
    const deep = run(withPair({ position: 20.1, title: "Widget repair" }))
      .drafts[0]!;
    expect(deep.actionKind).toBe("NEW_CONTENT");
    expect(deep.pageId).toBeNull();
  });

  it("flags a page whose title and headings miss the search words (gap B)", () => {
    // 2 sözcük: biri başlıkta → 0,5 → boşluk yok.
    expect(run(withPair({ title: "Widget services" })).drafts).toHaveLength(0);
    // 3 sözcük, biri başlıkta → 0,33 → boşluk.
    const snapshot = withPair({
      text: "widget repair kit",
      title: "Widget services",
    });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.actionKind).toBe("CONTENT_REFRESH");
    expect(draft.pageId).toBe("p1");
    expect(draft.evidence.metrics.coverageShare).toBe(0.333);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("measures token coverage against the 0.5 boundary", () => {
    expect(tokenCoverage(["alpha", "beta"], ["Alpha"])).toBe(0.5);
    expect(tokenCoverage(["alpha", "beta", "gamma"], ["Alpha"])).toBeLessThan(
      0.5,
    );
    expect(tokenCoverage([], ["x"])).toBe(1);
  });

  it("runs only gap A without crawl data", () => {
    expect(
      run(withPair({ crawl: false, text: "widget repair kit" })).drafts,
    ).toHaveLength(0);
    expect(run(withPair({ crawl: false, position: 25 })).drafts).toHaveLength(
      1,
    );
  });

  it("skips navigational, local and brand searches", () => {
    const nav = snapshotFixture({
      queries: [
        query("q1", "widget repair login", {
          impressions: 500,
          intent: "navigational",
        }),
      ],
    });
    expect(run(nav).drafts).toHaveLength(0);
    const local = snapshotFixture({
      queries: [query("q1", "widget repair near me", { impressions: 500 })],
    });
    expect(run(local).drafts).toHaveLength(0);
    const brand = snapshotFixture({
      queries: [query("q1", "acme widget repair", { impressions: 500 })],
    });
    expect(run(brand).drafts).toHaveLength(0);
  });

  it("merges two gaps of one cluster into a cluster finding", () => {
    const snapshot = snapshotFixture({
      queries: [
        query("q1", "widget repair cost", {
          impressions: 300,
          clusterId: "c1",
        }),
        query("q2", "widget repair guide", {
          impressions: 200,
          clusterId: "c1",
        }),
        query("q3", "widget repair shop", {
          impressions: 400,
          clusterId: "c1",
          isBrand: true,
        }),
      ],
      clusters: [
        {
          clusterId: "c1",
          name: "Widget repair",
          queryIds: ["q1", "q2", "q3"],
          pillarPageId: null,
        },
      ],
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0]!;
    expect(draft.subject).toBe("cluster:c1");
    expect(draft.clusterId).toBe("c1");
    // Kümenin en çok gösterimli sorgusu (marka dahil).
    expect(draft.keyword).toBe("widget repair shop");
    expect(draft.evidence.metrics.impressions).toBe(500);
    expect(result.seen).toEqual(["cluster:c1"]);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("reports gaps beyond the cap of 10 in seen", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const snapshot = snapshotFixture({
      queries: ids.map((i) =>
        query(`q${i}`, `gadget topic ${i}`, { impressions: 100 + i }),
      ),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(10);
    expect(result.seen).toHaveLength(12);
  });
});
