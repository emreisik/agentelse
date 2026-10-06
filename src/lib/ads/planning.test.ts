import { describe, expect, it } from "vitest";

import { estimatedGrossMinor, locationFeeShare } from "./fees";
import { weeklyResultsRange } from "./forecast";
import {
  breakevenCost,
  kpiMetricFor,
  learningBudget,
  learningFeasible,
  targetCost,
} from "./kpi";
import { recipeReady, recommendedGoal } from "./objectives";

describe("KPI target (F5b)", () => {
  it("is 70% of break-even from the sale value and the close rate", () => {
    // 1,000 TRY sale × 3 of 10 × 30% share = 90 TRY break-even → 63 TRY.
    expect(breakevenCost({ mode: "value", saleValue: 1_000, closeOutOfTen: 3 })).toBe(90);
    expect(targetCost({ mode: "value", saleValue: 1_000, closeOutOfTen: 3 })).toBe(63);
    expect(targetCost({ mode: "max", maxCost: 40 })).toBe(40);
    expect(targetCost({ mode: "value", saleValue: 1_000, closeOutOfTen: 0 })).toBeNull();
    expect(targetCost(undefined)).toBeNull();
  });

  it("names the metric after the result", () => {
    expect(kpiMetricFor("lead").metricKey).toBe("ads.cpl");
    expect(kpiMetricFor("onsite_conversion.messaging_conversation_started_7d").metric).toBe(
      "COST_PER_CONVERSATION",
    );
    expect(kpiMetricFor(null).metricKey).toBe("ads.cpa");
  });

  it("warns when the budget can't buy ~50 results a week", () => {
    expect(learningFeasible(20, 30)).toBe(false);
    expect(learningBudget(30)).toBe(215);
    expect(learningFeasible(215, 30)).toBe(true);
    expect(learningFeasible(5, null)).toBe(true);
  });
});

describe("fees and forecast", () => {
  it("adds the location fee by where the ad shows", () => {
    expect(locationFeeShare(["TR"])).toBeCloseTo(0.05);
    expect(locationFeeShare(["TR", "DE"])).toBeCloseTo(0.025);
    expect(estimatedGrossMinor(10_000, ["TR"])).toBe(10_500);
    expect(estimatedGrossMinor(10_000, ["US"])).toBe(10_000);
  });

  it("gives a directional weekly range from the account's own cost", () => {
    expect(weeklyResultsRange({ dailyBudgetMinor: 10_000, baselineCostMinor: 2_000, targetCostMinor: null })).toEqual([24, 46]);
    expect(weeklyResultsRange({ dailyBudgetMinor: 10_000, baselineCostMinor: null, targetCostMinor: 2_000 })).toEqual([14, 56]);
    expect(weeklyResultsRange({ dailyBudgetMinor: 10_000, baselineCostMinor: null, targetCostMinor: null })).toBeNull();
  });

  it("keeps forms off until the permission arrives and recommends a goal", () => {
    expect(recipeReady("leads_instant_form")).toBe(false);
    expect(recipeReady("messages_whatsapp")).toBe(true);
    expect(recommendedGoal({ hasPixel: false, messagesOffered: true }).goal).toBe("MESSAGES");
    expect(recommendedGoal({ hasPixel: true, messagesOffered: true }).goal).toBe("TRAFFIC");
  });
});
