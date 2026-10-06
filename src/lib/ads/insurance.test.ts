import { describe, expect, it } from "vitest";

import { guardsOf, safetyThresholdMinor } from "./insurance";

describe("safetyThresholdMinor", () => {
  it("is twice the highest daily budget in effect today", () => {
    expect(safetyThresholdMinor({ currentDailyMinor: 5_000, highestTodayMinor: null })).toBe(10_000);
    // Düşürülen bütçe: o gün eski bütçenin iki katı kalır.
    expect(safetyThresholdMinor({ currentDailyMinor: 3_000, highestTodayMinor: 5_000 })).toBe(10_000);
    // Artış: hemen yükselir.
    expect(safetyThresholdMinor({ currentDailyMinor: 8_000, highestTodayMinor: 5_000 })).toBe(16_000);
  });

  it("has no threshold without a budget", () => {
    expect(safetyThresholdMinor({ currentDailyMinor: null, highestTodayMinor: null })).toBeNull();
    expect(safetyThresholdMinor({ currentDailyMinor: 0, highestTodayMinor: 0 })).toBeNull();
  });

  it("reads guards defensively", () => {
    expect(guardsOf(null)).toEqual({});
    expect(guardsOf([1])).toEqual({});
    expect(guardsOf({ ruleId: "9" }).ruleId).toBe("9");
  });
});
