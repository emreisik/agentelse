import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO6 } from "./rising-queries";
import {
  draftInvariantErrors,
  idMetric,
  page,
  pair,
  query,
  snapshotFixture,
} from "./test-support";

function run(snapshot: RuleSnapshot) {
  const result = SO6.evaluate(snapshot);
  if (!result.evaluable) throw new Error(`not evaluable: ${result.reason}`);
  return result;
}

function growth(Q: number, P: number, overrides: Partial<RuleSnapshot> = {}) {
  return snapshotFixture({
    queries: [
      query("q1", "electric bike rental", { impressions: Q, position: 14 }),
    ],
    previousQueries: [idMetric("q1", { impressions: P, position: 15 })],
    ...overrides,
  });
}

describe("SO6 rising queries", () => {
  it("fires on a new query in the current window", () => {
    const snapshot = snapshotFixture({
      queries: [
        query("q1", "new gadget launch", {
          impressions: 60,
          position: 14,
          firstSeenWeek: "2026-09-07",
        }),
      ],
    });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("query:q1");
    expect(draft.keyword).toBe("new gadget launch");
    expect(draft.actionKind).toBe("NEW_CONTENT");
    expect(draft.ideaWorthy).toBe(true);
    expect(draft.signalWorthy).toBe(true);
    expect(draft.impact).toEqual({ kind: "reach", impressionsPerMonth: 64 });
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("needs 12 weeks of history for the new-query branch", () => {
    const snapshot = snapshotFixture({
      historyWeeks: 11,
      queries: [
        query("q1", "new gadget launch", {
          impressions: 60,
          firstSeenWeek: "2026-09-07",
        }),
      ],
    });
    expect(run(snapshot).drafts).toHaveLength(0);
  });

  it("uses the 3× growth boundary", () => {
    expect(run(growth(59, 20)).drafts).toHaveLength(0);
    const snapshot = growth(60, 20);
    const draft = run(snapshot).drafts[0]!;
    expect(draft.evidence.metrics).toEqual({
      impressions: 60,
      previousImpressions: 20,
    });
    expect(draft.evidence.compare).toEqual(snapshot.previous);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("needs a complete previous window for the growth branch", () => {
    expect(
      run(growth(60, 20, { previousComplete: false })).drafts,
    ).toHaveLength(0);
  });

  it("returns LOW_HISTORY when neither branch is possible", () => {
    expect(
      SO6.evaluate(
        growth(60, 20, { previousComplete: false, historyWeeks: 11 }),
      ),
    ).toEqual({
      evaluable: false,
      reason: "LOW_HISTORY",
    });
  });

  it("needs Q ≥ 50 and a non-brand query", () => {
    expect(run(growth(49, 10)).drafts).toHaveLength(0);
    const brand = growth(60, 20);
    brand.queries[0]!.isBrand = true;
    expect(run(brand).drafts).toHaveLength(0);
  });

  it("suggests a refresh when the query already ranks on page one", () => {
    const snapshot = growth(60, 20, {
      pages: [page("p1", "/bikes")],
      pairs: [pair("q1", "p1", { impressions: 60, position: 7 })],
    });
    expect(run(snapshot).drafts[0]!.actionKind).toBe("CONTENT_REFRESH");
  });

  it("is SIGNIFICANT from 200 impressions", () => {
    expect(run(growth(200, 50)).drafts[0]!.confidence).toBe("SIGNIFICANT");
    expect(run(growth(199, 50)).drafts[0]!.confidence).toBe("DIRECTIONAL");
  });

  it("reports a rising cluster instead of its members", () => {
    const snapshot = snapshotFixture({
      queries: [
        query("q1", "ebike rental city", { impressions: 90, clusterId: "c1" }),
        query("q2", "electric bike hire", { impressions: 60, clusterId: "c1" }),
      ],
      previousQueries: [
        idMetric("q1", { impressions: 30 }),
        idMetric("q2", { impressions: 20 }),
      ],
      clusters: [
        {
          clusterId: "c1",
          name: "E-bike rental",
          queryIds: ["q1", "q2"],
          pillarPageId: null,
        },
      ],
    });
    const result = run(snapshot);
    expect(result.drafts.map((d) => d.subject)).toEqual(["cluster:c1"]);
    expect(result.drafts[0]!.keyword).toBe("ebike rental city");
    expect(result.seen).toEqual(["cluster:c1"]);
    expect(draftInvariantErrors(snapshot, result.drafts[0]!)).toEqual([]);
    // Küme 3× büyümezse üyeler tek tek değerlendirilir.
    const flat = {
      ...snapshot,
      previousQueries: [
        idMetric("q1", { impressions: 30 }),
        idMetric("q2", { impressions: 40 }),
      ],
    };
    expect(run(flat).drafts.map((d) => d.subject)).toEqual(["query:q1"]);
  });

  it("reports queries beyond the cap of 10 in seen", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const snapshot = snapshotFixture({
      queries: ids.map((i) =>
        query(`q${i}`, `rising topic ${i}`, { impressions: 60 + i }),
      ),
      previousQueries: ids.map((i) => idMetric(`q${i}`, { impressions: 10 })),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(10);
    expect(result.seen).toHaveLength(12);
  });
});
