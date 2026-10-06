import { describe, expect, it } from "vitest";

import { digestText, digestWorthy, type DigestFacts } from "./digest";
import { rangeForPreset } from "./date-range";

const quiet: DigestFacts = {
  currency: "TRY",
  yesterdaySpendMinor: 0,
  plannedDailyMinor: 0,
  runningCampaigns: 0,
  criticalAlerts: [],
  warnAlerts: [],
  pendingDecisions: 0,
  updatedText: null,
};

describe("daily digest", () => {
  it("says nothing when there is nothing to say", () => {
    expect(digestWorthy(quiet)).toBe(false);
  });

  it("compares yesterday with the plan and lists what needs attention", () => {
    const facts = {
      ...quiet,
      yesterdaySpendMinor: 12_000,
      plannedDailyMinor: 10_000,
      runningCampaigns: 2,
      criticalAlerts: ["Spending above plan: Leads TR"],
      pendingDecisions: 1,
      updatedText: "Numbers updated 10 minutes ago.",
    };
    expect(digestWorthy(facts)).toBe(true);
    expect(digestText(facts)).toBe(
      [
        "Yesterday you spent 120 TRY against a plan of 100 TRY (+20%).",
        "2 campaigns are running.",
        "Urgent: Spending above plan: Leads TR.",
        "1 change is waiting for your approval.",
        "Numbers updated 10 minutes ago.",
      ].join("\n"),
    );
  });
});

describe("rangeForPreset", () => {
  it("excludes today from last_Nd and includes it in this_month", () => {
    expect(rangeForPreset("last_7d", "2026-10-06")).toEqual({ since: "2026-09-29", until: "2026-10-05" });
    expect(rangeForPreset("this_month", "2026-10-06")).toEqual({ since: "2026-10-01", until: "2026-10-06" });
    expect(rangeForPreset("maximum", "2026-10-06")).toBeNull();
  });
});
