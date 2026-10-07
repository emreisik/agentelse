import { describe, expect, it } from "vitest";

import {
  SPLIT_INSTRUCTIONS,
  SPLIT_KIND_LABEL,
  SPLIT_PLACEBO_NOTE,
  SPLIT_REASON_TEXT,
  SPLIT_STATUS_LABEL,
  splitDetail,
  splitHeadline,
} from "./copy";
import { SPLIT_CHANGE_KINDS, SPLIT_STATUSES, type SplitEvaluation } from "./types";

// Bu dosyanın kanıtladığı: her tür ve durumun etiketi var; talimatlar 2-4
// adım ve sayı içermez; başlık ve ayrıntı sabit şablondur, sayılar yalnız
// değerlendirmeden gelir ve plasebo dipnotu daima bulunur.

function evaluation(over: Partial<SplitEvaluation> = {}): SplitEvaluation {
  return {
    v: 1,
    method: "DID",
    metric: "ctr_adj",
    anchorDay: "2026-08-05",
    preWeeks: [],
    postWeeks: [],
    testPages: 180,
    controlPages: 180,
    usedTest: 170,
    usedControl: 172,
    excluded: 3,
    effect: 0.123,
    low: 0.04,
    high: 0.21,
    placebo: null,
    treated: null,
    control: null,
    updates: [],
    truncated: false,
    reason: null,
    outcome: "WORKED",
    confidence: "SIGNIFICANT",
    evaluatedAt: "2026-09-10T12:00:00.000Z",
    ...over,
  };
}

describe("split copy", () => {
  it("labels every kind and status", () => {
    for (const kind of SPLIT_CHANGE_KINDS) expect(SPLIT_KIND_LABEL[kind]).toBeTruthy();
    for (const status of SPLIT_STATUSES) expect(SPLIT_STATUS_LABEL[status]).toBeTruthy();
    expect(SPLIT_STATUS_LABEL.DRAFT).toBe("Ready to apply");
    expect(SPLIT_STATUS_LABEL.DIDNT).toBe("Didn't work");
    expect(SPLIT_REASON_TEXT.PRE_TREND).toBe(
      "The two groups already moved differently before the change.",
    );
  });

  it("gives every kind two to four steps without digits", () => {
    for (const kind of SPLIT_CHANGE_KINDS) {
      const steps = SPLIT_INSTRUCTIONS[kind];
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.length).toBeLessThanOrEqual(4);
      for (const step of steps) expect(step).not.toMatch(/\d/);
    }
  });

  it("writes the headline from the outcome", () => {
    expect(splitHeadline(evaluation())).toBe(
      "The test pages gained +12.3% in click-through rate for their position",
    );
    expect(splitHeadline(evaluation({ outcome: "DIDNT", effect: -0.04 }))).toContain("-4.0%");
    expect(
      splitHeadline(evaluation({ outcome: "INCONCLUSIVE", reason: "PRE_TREND" })),
    ).toBe(SPLIT_REASON_TEXT.PRE_TREND);
    expect(splitHeadline(evaluation({ outcome: "INCONCLUSIVE" }))).toContain("No clear difference");
  });

  it("states the numbers, the exclusions, the hint and the placebo footnote", () => {
    const detail = splitDetail(evaluation({ confidence: "DIRECTIONAL" }));
    expect(detail).toContain("170 test pages with 172 control pages");
    expect(detail).toContain("+4.0% and +21.0%");
    expect(detail).toContain("3 pages were left out");
    expect(detail).toContain("Treat this as a hint");
    expect(detail.endsWith(SPLIT_PLACEBO_NOTE)).toBe(true);
    expect(splitDetail(evaluation({ excluded: 0, effect: null }))).not.toContain("left out");
  });
});
