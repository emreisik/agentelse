import { describe, expect, it } from "vitest";

import { SO10 } from "./brand-demand";
import {
  draftInvariantErrors,
  FIXTURE_PAIR_WEEKS,
  snapshotFixture,
} from "./test-support";

function weeks(values: readonly (number | null)[]) {
  return FIXTURE_PAIR_WEEKS.map((weekStart, i) => ({
    weekStart,
    brandImpressions: values[i] ?? null,
    impressions: 5_000,
  }));
}

function run(values: readonly (number | null)[], brandSplitReady = true) {
  return SO10.evaluate(
    snapshotFixture({ brandWeeks: weeks(values), brandSplitReady }),
  );
}

describe("SO10 brand demand", () => {
  it("fires on a ≥ 20% change of the weekly average", () => {
    const snapshot = snapshotFixture({
      brandWeeks: weeks([100, 100, 100, 100, 120, 120, 120, 120]),
    });
    const result = SO10.evaluate(snapshot);
    if (!result.evaluable) throw new Error("not evaluable");
    const draft = result.drafts[0]!;
    expect(draft.subject).toBe("site:brand");
    expect(draft.kind).toBe("CHANGE");
    expect(draft.impact).toBeNull();
    expect(draft.keyword).toBeNull();
    expect(draft.title).toBe("Searches for your brand grew");
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
    expect(run([100, 100, 100, 100, 119, 119, 119, 119])).toEqual({
      evaluable: true,
      drafts: [],
      seen: [],
    });
  });

  it("needs a prior average of at least 100", () => {
    const low = run([99, 99, 99, 99, 200, 200, 200, 200]);
    expect(low.evaluable && low.drafts).toEqual([]);
    const ok = run([100, 100, 100, 100, 50, 50, 50, 50]);
    expect(ok.evaluable && ok.drafts[0]!.title).toBe(
      "Searches for your brand fell",
    );
  });

  it("needs all eight brand weeks", () => {
    expect(run([100, 100, null, 100, 50, 50, 50, 50])).toEqual({
      evaluable: false,
      reason: "NO_BRAND_SPLIT",
    });
    expect(run([100, 100, 100, 100, 50, 50, 50])).toEqual({
      evaluable: false,
      reason: "NO_BRAND_SPLIT",
    });
  });

  it("needs a ready brand split", () => {
    expect(run([100, 100, 100, 100, 50, 50, 50, 50], false)).toEqual({
      evaluable: false,
      reason: "NO_BRAND_SPLIT",
    });
  });
});
