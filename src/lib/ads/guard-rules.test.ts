import { describe, expect, it } from "vitest";

import {
  deliveryFindings,
  feedbackText,
  noDeliveryFindings,
  runawaySpend,
  type GuardObject,
} from "./guard-rules";

const now = new Date("2026-10-06T10:00:00Z");
const twoDaysAgo = new Date("2026-10-04T10:00:00Z");

function object(partial: Partial<GuardObject> & Pick<GuardObject, "externalId" | "level">): GuardObject {
  return {
    name: partial.externalId,
    parentExternalId: null,
    campaignExternalId: "c1",
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    startTime: null,
    endTime: null,
    createdAt: twoDaysAgo,
    goneAt: null,
    budgetRemainingMinor: null,
    issues: null,
    reviewFeedback: null,
    ...partial,
  };
}

describe("runawaySpend (G1)", () => {
  it("flags more than twice the daily budget today", () => {
    expect(runawaySpend({ dailyBudgetMinor: 1000, todaySpendMinor: 2001, weekSpendMinor: 2001 })).toBe("daily");
    expect(runawaySpend({ dailyBudgetMinor: 1000, todaySpendMinor: 1750, weekSpendMinor: 1750 })).toBeNull();
  });

  it("flags a week above 7× the daily budget", () => {
    expect(runawaySpend({ dailyBudgetMinor: 1000, todaySpendMinor: 900, weekSpendMinor: 7400 })).toBe("weekly");
  });

  it("skips lifetime budgets", () => {
    expect(runawaySpend({ dailyBudgetMinor: null, todaySpendMinor: 99_999, weekSpendMinor: 99_999 })).toBeNull();
  });
});

describe("deliveryFindings (G5)", () => {
  it("reports rejected ads and all-rejected ad sets", () => {
    const findings = deliveryFindings(
      [
        object({ externalId: "s1", level: "ADSET" }),
        object({
          externalId: "a1",
          level: "AD",
          parentExternalId: "s1",
          effectiveStatus: "DISAPPROVED",
          reviewFeedback: { global: { "Prohibited content": "Ads can't promote..." } },
        }),
      ],
      now,
    );
    expect(findings.map((f) => f.kind).sort()).toEqual(["AD_DISAPPROVED", "ALL_ADS_REJECTED"]);
    expect(findings.find((f) => f.kind === "AD_DISAPPROVED")?.detail).toContain("Prohibited content");
  });

  it("ignores paused or finished objects", () => {
    expect(
      deliveryFindings(
        [object({ externalId: "a1", level: "AD", configuredStatus: "PAUSED", effectiveStatus: "DISAPPROVED" })],
        now,
      ),
    ).toEqual([]);
  });

  it("calls out a slow review only after a day", () => {
    const review = (createdAt: Date) =>
      deliveryFindings([object({ externalId: "a1", level: "AD", effectiveStatus: "PENDING_REVIEW", createdAt })], now);
    expect(review(twoDaysAgo)[0]?.kind).toBe("REVIEW_SLOW");
    expect(review(new Date("2026-10-06T05:00:00Z"))).toEqual([]);
  });

  it("reads Meta's feedback shapes", () => {
    expect(feedbackText([{ error_message: "Payment failed" }])).toBe("Payment failed");
    expect(feedbackText(null)).toBeNull();
  });
});

describe("noDeliveryFindings (G8)", () => {
  const campaign = object({ externalId: "c1", level: "CAMPAIGN", campaignExternalId: "c1" });
  const adSet = object({ externalId: "s1", level: "ADSET" });
  const ad = object({ externalId: "a1", level: "AD", parentExternalId: "s1" });

  it("flags an on ad set with no impressions for a day", () => {
    const findings = noDeliveryFindings({
      objects: [campaign, adSet, ad],
      impressionsByAdSet: new Map(),
      accountCapReached: false,
      now,
    });
    expect(findings.map((f) => f.externalId)).toEqual(["s1"]);
  });

  it("stays quiet when it delivered, is new, ended, waits for review or the cap is reached", () => {
    const run = (overrides: Partial<Parameters<typeof noDeliveryFindings>[0]>) =>
      noDeliveryFindings({
        objects: [campaign, adSet, ad],
        impressionsByAdSet: new Map(),
        accountCapReached: false,
        now,
        ...overrides,
      });
    expect(run({ impressionsByAdSet: new Map([["s1", 10]]) })).toEqual([]);
    expect(run({ accountCapReached: true })).toEqual([]);
    expect(run({ objects: [campaign, { ...adSet, createdAt: new Date("2026-10-06T08:00:00Z") }, ad] })).toEqual([]);
    expect(run({ objects: [campaign, { ...adSet, endTime: new Date("2026-10-05T00:00:00Z") }, ad] })).toEqual([]);
    expect(run({ objects: [campaign, adSet, { ...ad, effectiveStatus: "PENDING_REVIEW" }] })).toEqual([]);
  });
});
