import { describe, expect, it } from "vitest";

import { dailyRowFrom, sharedResultType, sumRows } from "./insight-rows";
import {
  metaResultsOf,
  resultActionTypeForGoal,
  resultCountFor,
  resultLabel,
} from "./results";

const raw = {
  date_start: "2026-10-05",
  adset_id: "120",
  spend: "38.20",
  impressions: "1000",
  reach: "800",
  frequency: "1.25",
  clicks: "40",
  inline_link_clicks: "30",
  actions: [
    { action_type: "link_click", value: "30" },
    { action_type: "landing_page_view", value: "22" },
    { action_type: "lead", value: "3" },
    { action_type: "video_view", value: "120" },
    { action_type: "comment", value: "2" },
  ],
  action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "99.90" }],
};

describe("dailyRowFrom", () => {
  it("uses Meta's own results field first", () => {
    const row = dailyRowFrom(
      { ...raw, results: [{ indicator: "actions:lead", values: [{ value: "3" }] }] },
      "ADSET",
      { currency: "TRY", resultActionType: "link_click" },
    );
    expect(row).toMatchObject({
      externalId: "120",
      date: "2026-10-05",
      spendMinor: 3820,
      impressions: 1000,
      reach: 800,
      linkClicks: 30,
      landingPageViews: 22,
      results: 3,
      resultActionType: "lead",
      actionValuesMinor: 9990,
      video3s: 120,
    });
    // Only the kept action keys are stored.
    expect(row?.actions).not.toHaveProperty("comment");
  });

  it("falls back to the ad set's result type", () => {
    const row = dailyRowFrom(raw, "ADSET", { currency: "TRY", resultActionType: "landing_page_view" });
    expect(row).toMatchObject({ results: 22, resultActionType: "landing_page_view" });
  });

  it("leaves results unknown without either source", () => {
    expect(dailyRowFrom(raw, "ADSET", { currency: "TRY" })?.results).toBeNull();
  });

  it("names the account row and handles zero-decimal currencies", () => {
    const row = dailyRowFrom(
      { date_start: "2026-10-05", account_id: "77", spend: "1500" },
      "ACCOUNT",
      { currency: "JPY" },
    );
    expect(row).toMatchObject({ externalId: "act_77", spendMinor: 1500 });
  });

  it("skips rows without a date or id", () => {
    expect(dailyRowFrom({ spend: "1" }, "AD")).toBeNull();
  });
});

describe("results helpers", () => {
  it("maps goals to result types", () => {
    expect(resultActionTypeForGoal("OFFSITE_CONVERSIONS", "PURCHASE")).toBe(
      "offsite_conversion.fb_pixel_purchase",
    );
    expect(resultActionTypeForGoal("VALUE")).toBe("offsite_conversion.fb_pixel_purchase");
    expect(resultActionTypeForGoal("THRUPLAY")).toBe("video_thruplay_watched");
    expect(resultActionTypeForGoal("REACH")).toBe("reach");
    expect(resultActionTypeForGoal("APP_INSTALLS")).toBeNull();
  });

  it("counts lead from either lead action", () => {
    expect(
      resultCountFor({ actions: [{ action_type: "onsite_conversion.lead_grouped", value: "4" }] }, "lead"),
    ).toBe(4);
    expect(resultCountFor({ reach: "900" }, "reach")).toBe(900);
  });

  it("treats an empty results field as unknown", () => {
    expect(metaResultsOf({ results: [] })).toBeNull();
    expect(metaResultsOf({ results: [{ indicator: "reach", values: [] }] })).toBeNull();
    expect(resultLabel("onsite_conversion.messaging_conversation_started_7d")).toBe(
      "Conversations started",
    );
  });

  it("shares a result type only when every ad set agrees", () => {
    expect(sharedResultType(["lead", "lead", null])).toBe("lead");
    expect(sharedResultType(["lead", "link_click"])).toBeNull();
  });

  it("sums known results only", () => {
    const totals = sumRows([
      { spendMinor: 100, impressions: 10, clicks: 1, linkClicks: 1, results: null, actionValuesMinor: null },
      { spendMinor: 200, impressions: 20, clicks: 2, linkClicks: 2, results: 3, actionValuesMinor: 500 },
    ]);
    expect(totals).toEqual({
      spendMinor: 300,
      impressions: 30,
      clicks: 3,
      linkClicks: 3,
      results: 3,
      actionValuesMinor: 500,
    });
  });
});
