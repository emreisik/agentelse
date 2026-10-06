import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO2 } from "./ctr-gap";
import {
  draftInvariantErrors,
  page,
  pair,
  query,
  siteCurve,
  snapshotFixture,
} from "./test-support";

// Konum 3 → beklenen CTR 0,10.
function build(
  impressions: number,
  clicks: number,
  overrides: Partial<RuleSnapshot> = {},
) {
  return snapshotFixture({
    queries: [
      query("q1", "project software pricing", {
        impressions,
        clicks,
        position: 3,
      }),
    ],
    pages: [page("p1", "/pricing", { impressions, clicks, position: 3 })],
    pairs: [pair("q1", "p1", { impressions, clicks, position: 3 })],
    ...overrides,
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO2.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

describe("SO2 CTR gap", () => {
  it("fires when clicks are under 70% of the expected clicks", () => {
    const snapshot = build(600, 10);
    const draft = run(snapshot).drafts[0]!;
    expect(draft.actionKind).toBe("TITLE_META");
    expect(draft.effort).toBe("S");
    expect(draft.evidence.metrics).toMatchObject({
      actualCtr: 0.017,
      expectedCtr: 0.1,
      expectedClicks: 60,
    });
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("needs at least 500 impressions on page one", () => {
    expect(run(build(499, 0)).drafts).toHaveLength(0);
    expect(run(build(500, 0)).drafts).toHaveLength(1);
  });

  it("uses the 0.7 × expected boundary", () => {
    // E = 0,10 × 500 = 50 → sınır 35.
    expect(run(build(500, 34.9)).drafts).toHaveLength(1);
    expect(run(build(500, 35)).drafts).toHaveLength(0);
  });

  it("only counts positions 1 to 10", () => {
    const snapshot = snapshotFixture({
      queries: [
        query("q1", "deep query text", { impressions: 800, position: 11 }),
      ],
      pages: [page("p1", "/deep", { impressions: 800 })],
      pairs: [pair("q1", "p1", { impressions: 800, clicks: 0, position: 11 })],
    });
    expect(run(snapshot).drafts).toHaveLength(0);
  });

  it("is SIGNIFICANT with ≥ 1000 impressions on a site curve", () => {
    const curves = { nonBrand: siteCurve(), brand: siteCurve("brand") };
    expect(run(build(1000, 0, { curves })).drafts[0]!.confidence).toBe(
      "SIGNIFICANT",
    );
    expect(run(build(999, 0, { curves })).drafts[0]!.confidence).toBe(
      "DIRECTIONAL",
    );
    expect(run(build(1000, 0)).drafts[0]!.confidence).toBe("DIRECTIONAL");
  });

  it("reports pages beyond the cap of 10 in seen", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const snapshot = snapshotFixture({
      queries: ids.map((i) =>
        query(`q${i}`, `pricing topic ${i}`, { impressions: 600, position: 3 }),
      ),
      pages: ids.map((i) =>
        page(`p${i}`, `/pricing-${i}`, { impressions: 600 }),
      ),
      pairs: ids.map((i) =>
        pair(`q${i}`, `p${i}`, { impressions: 600, clicks: i, position: 3 }),
      ),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(10);
    expect(result.seen).toHaveLength(12);
    expect(result.drafts[0]!.subject).toBe("page:p0");
  });
});
