import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO7, SO7_TECH_NOTE } from "./lost";
import {
  crawlPage,
  draftInvariantErrors,
  idMetric,
  page,
  pair,
  query,
  snapshotFixture,
} from "./test-support";

function lostPage(
  previousClicks: number,
  overrides: Partial<RuleSnapshot> = {},
) {
  return snapshotFixture({
    queries: [
      query("q1", "legacy widget manual", { impressions: 50, position: 30 }),
    ],
    pages: [page("p1", "/discontinued", { impressions: 50, position: 30 })],
    previousPages: [
      idMetric("p1", { clicks: previousClicks, impressions: 800, position: 4 }),
    ],
    previousQueries: [
      idMetric("q1", { clicks: previousClicks, impressions: 800, position: 4 }),
    ],
    previousPairs: [
      pair("q1", "p1", {
        clicks: previousClicks,
        impressions: 800,
        position: 4,
      }),
    ],
    ...overrides,
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO7.evaluate(snapshot);
  if (!result.evaluable) throw new Error(`not evaluable: ${result.reason}`);
  return result;
}

describe("SO7 lost pages and queries", () => {
  it("needs a complete previous window", () => {
    expect(SO7.evaluate(lostPage(40, { previousComplete: false }))).toEqual({
      evaluable: false,
      reason: "LOW_HISTORY",
    });
  });

  it("fires for a page that lost all of its ≥ 10 clicks", () => {
    expect(run(lostPage(9)).drafts).toHaveLength(0);
    const snapshot = lostPage(10);
    const result = run(snapshot);
    // Sorgunun önceki en iyi sayfası kaybedildi: sorgu ayrıca bildirilmez.
    expect(result.drafts.map((d) => d.subject)).toEqual(["page:p1"]);
    const draft = result.drafts[0]!;
    expect(draft.actionKind).toBe("INVESTIGATE");
    expect(draft.signalWorthy).toBe(true);
    expect(draft.confidence).toBe("DIRECTIONAL");
    expect(draft.keyword).toBe("legacy widget manual");
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("suggests a technical fix for a broken page", () => {
    const snapshot = lostPage(30, {
      crawl: {
        complete: true,
        pages: [crawlPage("p1", "/discontinued", { noindex: true })],
        links: [],
      },
    });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.actionKind).toBe("TECH_FIX");
    expect(draft.effort).toBe("S");
    expect(draft.confidence).toBe("SIGNIFICANT");
    expect(draft.evidence.notes).toEqual([SO7_TECH_NOTE]);
  });

  it("reports lost queries whose top page still gets clicks", () => {
    const snapshot = snapshotFixture({
      queries: [
        query("q1", "Acme login", {
          impressions: 30,
          clicks: 0,
          isBrand: true,
        }),
      ],
      pages: [page("p1", "/login", { impressions: 400, clicks: 25 })],
      previousPages: [idMetric("p1", { clicks: 30 })],
      previousQueries: [idMetric("q1", { clicks: 12 })],
      previousPairs: [
        pair("q1", "p1", { clicks: 12, impressions: 100, position: 2 }),
      ],
    });
    const result = run(snapshot);
    expect(result.drafts.map((d) => d.subject)).toEqual(["query:q1"]);
    const draft = result.drafts[0]!;
    expect(draft.keyword).toBe("Acme login");
    expect(draft.signalWorthy).toBe(false);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("puts pages first and reports everything beyond the cap in seen", () => {
    const ids = Array.from({ length: 8 }, (_, i) => i);
    const snapshot = snapshotFixture({
      queries: ids.map((i) =>
        query(`q${i}`, `lost query ${i}`, { impressions: 10 }),
      ),
      pages: [page("live", "/live", { clicks: 100, impressions: 1000 })],
      previousPages: ids.map((i) => idMetric(`p${i}`, { clicks: 15 })),
      previousQueries: ids.map((i) => idMetric(`q${i}`, { clicks: 50 })),
      previousPairs: ids.map((i) =>
        pair(`q${i}`, "live", { clicks: 50, impressions: 100 }),
      ),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(10);
    expect(result.seen).toHaveLength(16);
    expect(
      result.drafts.slice(0, 8).every((d) => d.subject.startsWith("page:")),
    ).toBe(true);
  });
});
