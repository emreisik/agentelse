import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import {
  SO15,
  SO15_FEW_LINKS_NOTE,
  SO15_NOT_INDEXED_NOTE,
} from "./new-content";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  snapshotFixture,
} from "./test-support";

// Pencere sonu 2026-09-27 → yeni sayılan ilk hafta aralığı 2026-06-29..2026-08-30.
function build(
  impressions: readonly number[],
  overrides: Partial<RuleSnapshot> = {},
) {
  return snapshotFixture({
    pages: [
      ...impressions.map((v, i) =>
        page(`n${i}`, `/new-${i}`, {
          impressions: v,
          firstSeenWeek: "2026-07-06",
        }),
      ),
      page("old", "/old", { impressions: 5, firstSeenWeek: "2025-01-06" }),
      page("fresh", "/fresh", { impressions: 1, firstSeenWeek: "2026-09-07" }),
    ],
    ...overrides,
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO15.evaluate(snapshot);
  if (!result.evaluable) throw new Error(`not evaluable: ${result.reason}`);
  return result;
}

describe("SO15 new content", () => {
  it("flags new pages far below the typical new page", () => {
    const snapshot = build([100, 100, 100, 10]);
    const result = run(snapshot);
    expect(result.drafts.map((d) => d.subject)).toEqual(["page:n3"]);
    const draft = result.drafts[0]!;
    expect(draft.kind).toBe("RISK");
    expect(draft.actionKind).toBe("INVESTIGATE");
    expect(draft.evidence.metrics.typicalImpressions).toBe(100);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("needs a median of at least 20", () => {
    expect(run(build([19, 19, 19, 2])).drafts).toHaveLength(0);
    expect(run(build([20, 20, 20, 2])).drafts).toHaveLength(1);
  });

  it("needs at least three new pages", () => {
    expect(run(build([100, 10])).drafts).toHaveLength(0);
  });

  it("needs 20 weeks of history or a finished backfill", () => {
    expect(
      SO15.evaluate(
        build([100, 100, 100, 10], { historyWeeks: 19, backfillDone: false }),
      ),
    ).toEqual({
      evaluable: false,
      reason: "LOW_HISTORY",
    });
    expect(
      run(build([100, 100, 100, 10], { historyWeeks: 19, backfillDone: true }))
        .drafts,
    ).toHaveLength(1);
    expect(
      run(build([100, 100, 100, 10], { historyWeeks: 20, backfillDone: false }))
        .drafts,
    ).toHaveLength(1);
  });

  it("adds notes on indexing and internal links", () => {
    const snapshot = build([100, 100, 100, 10], {
      inspections: [
        { pageId: "n3", verdict: "NEUTRAL", coverageState: "Discovered" },
      ],
      crawl: {
        complete: true,
        pages: [crawlPage("n3", "/new-3", { inlinks: 0 })],
        links: [],
      },
    });
    expect(run(snapshot).drafts[0]!.evidence.notes).toEqual([
      SO15_NOT_INDEXED_NOTE,
      SO15_FEW_LINKS_NOTE,
    ]);
  });
});
