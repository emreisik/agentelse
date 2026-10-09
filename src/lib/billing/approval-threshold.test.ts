import { describe, expect, it } from "vitest";

import {
  APPROVE_ABOVE_MAX_FACTOR,
  APPROVE_ABOVE_MIN_USD,
  APPROVE_ABOVE_USD,
  ESTIMATED_IMAGE_COST_USD,
  approveAboveRange,
  costApprovalNote,
  effectiveApproveAbove,
  estimateCostUsd,
} from "./approval-threshold";
import { PLAN_KEYS } from "./plans";
import {
  APPROVE_ABOVE_ABSOLUTE_MAX_USD,
  autonomyFormView,
  clampUserLimits,
  monthlyAiBudgetUsd,
  userLimitRanges,
} from "./user-limits";

describe("approval threshold", () => {
  it("every plan has a default, and a bigger plan trusts bigger automatic tasks", () => {
    const sizes = PLAN_KEYS.map((key) => APPROVE_ABOVE_USD[key]);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    for (const size of sizes)
      expect(size).toBeGreaterThan(APPROVE_ABOVE_MIN_USD);
  });

  it("the plan default is inside its own range", () => {
    for (const key of PLAN_KEYS) {
      const range = approveAboveRange(key);
      expect(range.planDefault).toBeGreaterThanOrEqual(range.min);
      expect(range.planDefault).toBeLessThanOrEqual(range.max);
      expect(range.max).toBe(range.planDefault * APPROVE_ABOVE_MAX_FACTOR);
    }
  });

  it("uses the plan default unless the user chose, and keeps a choice inside the range", () => {
    expect(effectiveApproveAbove("growth", null)).toBe(
      APPROVE_ABOVE_USD.growth,
    );
    expect(effectiveApproveAbove("growth", undefined)).toBe(
      APPROVE_ABOVE_USD.growth,
    );
    expect(effectiveApproveAbove("growth", Number.NaN)).toBe(
      APPROVE_ABOVE_USD.growth,
    );
    expect(effectiveApproveAbove("growth", 2)).toBe(2);
    expect(effectiveApproveAbove("growth", 0.01)).toBe(APPROVE_ABOVE_MIN_USD);
    expect(effectiveApproveAbove("growth", 1000)).toBe(
      APPROVE_ABOVE_USD.growth * APPROVE_ABOVE_MAX_FACTOR,
    );
  });

  it("sizes a task from what it needs: images at the average image cost, AI at its budget", () => {
    expect(estimateCostUsd({ unit: "IMAGE", amount: BigInt(2) })).toBeCloseTo(
      2 * ESTIMATED_IMAGE_COST_USD,
    );
    expect(
      estimateCostUsd({ unit: "AI_MICROS", amount: BigInt(250_000) }),
    ).toBeCloseTo(0.25);
    expect(estimateCostUsd({ unit: "IMAGE", amount: 1 })).toBeCloseTo(
      ESTIMATED_IMAGE_COST_USD,
    );
  });

  it("with the default sizes: one picture never asks, several can, on a small plan", () => {
    const one = estimateCostUsd({ unit: "IMAGE", amount: 1 });
    const three = estimateCostUsd({ unit: "IMAGE", amount: 3 });
    for (const key of PLAN_KEYS)
      expect(one).toBeLessThanOrEqual(APPROVE_ABOVE_USD[key]);
    expect(three).toBeGreaterThan(APPROVE_ABOVE_USD.starter);
    expect(three).toBeGreaterThan(APPROVE_ABOVE_USD.growth);
  });

  it("explains the question in plan terms, not dollars", () => {
    const images = costApprovalNote({ unit: "IMAGE", amount: BigInt(3) });
    expect(images).toContain("3 post images");
    expect(images).not.toMatch(/\$|USD|dollar/i);
    expect(costApprovalNote({ unit: "IMAGE", amount: BigInt(1) })).toContain(
      "1 post image ",
    );
    const ai = costApprovalNote({ unit: "AI_MICROS", amount: BigInt(900_000) });
    expect(ai).toContain("AI assistant usage");
    expect(ai).not.toMatch(/\$|USD|dollar/i);
  });
});

describe("user limits stay inside the plan", () => {
  it("the daily budget is at most the plan's monthly AI budget", () => {
    expect(
      clampUserLimits({
        planKey: "starter",
        approveAboveUsd: null,
        dailyBudgetUsd: 50,
      }).dailyBudgetUsd,
    ).toBe(monthlyAiBudgetUsd("starter"));
    expect(
      clampUserLimits({
        planKey: "starter",
        approveAboveUsd: null,
        dailyBudgetUsd: 1,
      }).dailyBudgetUsd,
    ).toBe(1);
    // Blank (no daily cap) stays blank.
    expect(
      clampUserLimits({
        planKey: "starter",
        approveAboveUsd: null,
        dailyBudgetUsd: null,
      }).dailyBudgetUsd,
    ).toBeNull();
  });

  it("the approval size is chosen inside the plan's range, blank stays blank", () => {
    const base = { planKey: "growth", dailyBudgetUsd: null } as const;
    expect(
      clampUserLimits({ ...base, approveAboveUsd: null }).approveAboveUsd,
    ).toBeNull();
    expect(
      clampUserLimits({ ...base, approveAboveUsd: 2.5 }).approveAboveUsd,
    ).toBe(2.5);
    expect(
      clampUserLimits({ ...base, approveAboveUsd: 0 }).approveAboveUsd,
    ).toBe(APPROVE_ABOVE_MIN_USD);
    expect(
      clampUserLimits({ ...base, approveAboveUsd: 99 }).approveAboveUsd,
    ).toBe(APPROVE_ABOVE_USD.growth * APPROVE_ABOVE_MAX_FACTOR);
    // Cents only.
    expect(
      clampUserLimits({ ...base, approveAboveUsd: 1.23456 }).approveAboveUsd,
    ).toBe(1.23);
  });

  it("without a plan only the absolute limits apply (the database bound is never exceeded)", () => {
    expect(
      clampUserLimits({
        planKey: null,
        approveAboveUsd: 5000,
        dailyBudgetUsd: 5000,
      }),
    ).toEqual({
      approveAboveUsd: APPROVE_ABOVE_ABSOLUTE_MAX_USD,
      dailyBudgetUsd: 5000,
    });
    expect(
      clampUserLimits({
        planKey: null,
        approveAboveUsd: 0,
        dailyBudgetUsd: null,
      }).approveAboveUsd,
    ).toBe(APPROVE_ABOVE_MIN_USD);
    for (const key of PLAN_KEYS) {
      expect(userLimitRanges(key).approveAbove.max).toBeLessThanOrEqual(
        APPROVE_ABOVE_ABSOLUTE_MAX_USD,
      );
    }
  });

  it("the ranges the settings page shows are the ones the action enforces", () => {
    for (const key of PLAN_KEYS) {
      const ranges = userLimitRanges(key);
      const low = clampUserLimits({
        planKey: key,
        approveAboveUsd: -5,
        dailyBudgetUsd: 1e9,
      });
      const high = clampUserLimits({
        planKey: key,
        approveAboveUsd: 1e9,
        dailyBudgetUsd: null,
      });
      expect(low.approveAboveUsd).toBe(ranges.approveAbove.min);
      expect(high.approveAboveUsd).toBe(ranges.approveAbove.max);
      expect(low.dailyBudgetUsd).toBe(ranges.dailyBudgetMax);
    }
  });
});

// What the Autonomy form shows (Settings → Autonomy): a saved value outside today's
// range must never reach the browser's min/max check, or it would refuse the WHOLE
// form over a field the person did not touch.
describe("the Autonomy form's view of the limits", () => {
  const stored = (
    approveAboveUsd: number | null,
    dailyBudgetUsd: number | null,
  ) => ({
    approveAboveUsd,
    dailyBudgetUsd,
  });

  it("shows a saved value inside the range as it is", () => {
    const view = autonomyFormView({
      mode: "enforce",
      planKey: "growth",
      stored: stored(1.5, 4),
    });
    expect(view).toMatchObject({
      approveAboveUsd: 1.5,
      dailyBudgetUsd: 4,
      approveAboveClamped: false,
      dailyBudgetClamped: false,
    });
  });

  it("pulls a stale value into the range, the way a save would store it, and says so", () => {
    // A daily budget saved before the plan's cap existed, and a size from a bigger
    // plan the workspace has since left (Agency's 12.5 on Starter, whose cap is 2.5).
    const view = autonomyFormView({
      mode: "enforce",
      planKey: "starter",
      stored: stored(12.5, 10),
    });
    const ranges = userLimitRanges("starter");
    expect(view.approveAboveUsd).toBe(ranges.approveAbove.max);
    expect(view.dailyBudgetUsd).toBe(ranges.dailyBudgetMax);
    expect(view.approveAboveClamped).toBe(true);
    expect(view.dailyBudgetClamped).toBe(true);
    // What the form shows can always be submitted: it satisfies the inputs' own min/max.
    expect(view.approveAboveUsd!).toBeLessThanOrEqual(ranges.approveAbove.max);
    expect(view.approveAboveUsd!).toBeGreaterThanOrEqual(
      ranges.approveAbove.min,
    );
    expect(view.dailyBudgetUsd!).toBeLessThanOrEqual(ranges.dailyBudgetMax!);
    // ... and is exactly what saving it would store.
    expect(view).toMatchObject(
      clampUserLimits({
        planKey: "starter",
        approveAboveUsd: 12.5,
        dailyBudgetUsd: 10,
      }),
    );
  });

  it("raises a size below the smallest allowed, and leaves blank blank", () => {
    expect(
      autonomyFormView({
        mode: "enforce",
        planKey: "growth",
        stored: stored(0.02, null),
      }),
    ).toMatchObject({
      approveAboveUsd: APPROVE_ABOVE_MIN_USD,
      approveAboveClamped: true,
      dailyBudgetUsd: null,
      dailyBudgetClamped: false,
    });
    expect(
      autonomyFormView({
        mode: "enforce",
        planKey: "growth",
        stored: stored(null, null),
      }),
    ).toMatchObject({ approveAboveUsd: null, approveAboveClamped: false });
  });

  it("has no cap on the daily budget without a plan", () => {
    const view = autonomyFormView({
      mode: "off",
      planKey: null,
      stored: stored(null, 500),
    });
    expect(view.dailyBudgetUsd).toBe(500);
    expect(view.dailyBudgetClamped).toBe(false);
  });

  it("shows the approval size only where it does something: an enforcing mode and a plan", () => {
    const show = (
      mode: "off" | "shadow" | "enforce",
      planKey: "starter" | null,
    ) =>
      autonomyFormView({ mode, planKey, stored: stored(null, null) })
        .showApproveAbove;
    expect(show("enforce", "starter")).toBe(true);
    expect(show("shadow", "starter")).toBe(false);
    expect(show("off", "starter")).toBe(false);
    expect(show("enforce", null)).toBe(false);
  });
});
