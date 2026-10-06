import { describe, expect, it } from "vitest";

import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";

import {
  adSetEndTime,
  blockingIssues,
  campaignSpendCap,
  specHash,
  validateLaunchSpec,
  type AdsLaunchSpec,
  type LaunchAccountFacts,
} from "./launch-spec";
import { isValidCombination } from "./objectives";
import { policyLint } from "./policy-lint";

const spec: AdsLaunchSpec = {
  version: 1,
  adAccountId: "act_1",
  currency: "TRY",
  timezone: "Europe/Istanbul",
  pageId: "9",
  objective: "OUTCOME_TRAFFIC",
  recipe: "traffic_link_clicks",
  specialAdCategories: [],
  campaignName: "Spring",
  budget: { mode: "DAILY", dailyMinor: 20_000, durationDays: 7 },
  adSets: [
    {
      name: "TR",
      optimizationGoal: "LINK_CLICKS",
      billingEvent: "IMPRESSIONS",
      targeting: { countries: ["TR"], ageMin: 18, ageMax: 65 },
      advantageAudience: 0,
    },
  ],
  ads: [
    {
      name: "Ad",
      adSetIndex: 0,
      creative: { imageAssetId: "a1", message: "Spring sale", link: "https://example.com", callToAction: "LEARN_MORE" },
      urlTags: "utm_source=meta",
    },
  ],
  guards: { campaignSpendCapMinor: 154_000 },
  creativeFeatures: { send: true, multiAdvertiser: "OPT_OUT" },
  activate: true,
};

const facts: LaunchAccountFacts = {
  accountStatus: 1,
  currency: "TRY",
  minDailyBudgetMinor: 3_500,
  minimumBudgets: null,
};

describe("validateLaunchSpec", () => {
  it("passes a sound spec", () => {
    expect(validateLaunchSpec(spec, facts)).toEqual([]);
  });

  it("blocks a budget below Meta's minimum (P1)", () => {
    const issues = validateLaunchSpec({ ...spec, budget: { mode: "DAILY", dailyMinor: 1_000, durationDays: 7 } }, facts);
    expect(issues[0]).toMatchObject({ rule: "P1", severity: "block" });
    expect(issues[0]?.message).toContain("35 TRY");
  });

  it("reads the goal's minimum from minimum_budgets", () => {
    const issues = validateLaunchSpec(
      { ...spec, budget: { mode: "DAILY", dailyMinor: 4_000, durationDays: 7 } },
      { ...facts, minimumBudgets: [{ currency: "TRY", min_daily_budget_high_freq: 5_000 }] },
    );
    expect(blockingIssues(issues).map((issue) => issue.rule)).toEqual(["P1"]);
  });

  it("blocks EU targeting without DSA and regional-identity countries (P5)", () => {
    const eu = validateLaunchSpec(
      { ...spec, adSets: [{ ...spec.adSets[0]!, targeting: { countries: ["DE"] } }] },
      facts,
    );
    expect(eu.map((issue) => issue.rule)).toContain("P5");
    const withDsa = validateLaunchSpec(
      { ...spec, adSets: [{ ...spec.adSets[0]!, targeting: { countries: ["DE"] }, dsa: { beneficiary: "Acme", payor: "Acme" } }] },
      facts,
    );
    expect(withDsa).toEqual([]);
    const brazil = validateLaunchSpec(
      { ...spec, adSets: [{ ...spec.adSets[0]!, targeting: { countries: ["BR"] } }] },
      facts,
    );
    expect(brazil[0]?.message).toContain("BR");
  });

  it("blocks Advantage+ audience with narrow ages (P3) and wrong combinations (P2)", () => {
    expect(
      validateLaunchSpec(
        { ...spec, adSets: [{ ...spec.adSets[0]!, advantageAudience: 1, targeting: { countries: ["TR"], ageMin: 30, ageMax: 65 } }] },
        facts,
      )[0]?.rule,
    ).toBe("P3");
    expect(
      validateLaunchSpec(
        { ...spec, adSets: [{ ...spec.adSets[0]!, optimizationGoal: "REACH" }] },
        facts,
      ).map((issue) => issue.rule),
    ).toContain("P2");
  });

  it("warns about risky ad text without blocking (P6)", () => {
    const issues = validateLaunchSpec(
      { ...spec, ads: [{ ...spec.ads[0]!, creative: { ...spec.ads[0]!.creative, message: "Guaranteed results. Are you overweight?" } }] },
      facts,
    );
    expect(issues.every((issue) => issue.severity === "warn")).toBe(true);
    expect(issues).toHaveLength(2);
  });

  it("blocks a closed account and a changed currency", () => {
    expect(validateLaunchSpec(spec, { ...facts, accountStatus: 2 })[0]?.rule).toBe("P12");
    expect(validateLaunchSpec(spec, { ...facts, currency: "USD" })[0]?.message).toContain("USD");
  });
});

describe("brakes", () => {
  it("caps the campaign at 110% of the envelope or the account minimum", () => {
    expect(campaignSpendCap(140_000, null)).toBe(154_000);
    expect(campaignSpendCap(10_000, 350_000)).toBe(350_000);
  });

  it("ends the ad set at 23:59 account time, days after the start", () => {
    const end = adSetEndTime(
      new Date("2026-10-06T21:30:00Z"), // 00:30 on 7 Oct in Istanbul
      7,
      "Europe/Istanbul",
      zonedDateTimeToUtc,
      dayKeyInTimezone,
    );
    expect(end.toISOString()).toBe("2026-10-14T20:59:00.000Z");
  });
});

describe("specHash", () => {
  it("changes with money or audience, not with the ad's words", () => {
    const base = specHash(spec);
    expect(specHash({ ...spec, ads: [{ ...spec.ads[0]!, creative: { ...spec.ads[0]!.creative, message: "New words" } }] })).toBe(base);
    expect(specHash({ ...spec, budget: { mode: "DAILY", dailyMinor: 30_000, durationDays: 7 } })).not.toBe(base);
    expect(specHash({ ...spec, adSets: [{ ...spec.adSets[0]!, targeting: { countries: ["DE"] } }] })).not.toBe(base);
  });
});

describe("objectives and lint", () => {
  it("knows Meta's combinations", () => {
    expect(isValidCombination({ objective: "OUTCOME_ENGAGEMENT", optimizationGoal: "POST_ENGAGEMENT", billingEvent: "IMPRESSIONS", destinationType: "ON_POST" })).toBe(true);
    expect(isValidCombination({ objective: "OUTCOME_AWARENESS", optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" })).toBe(false);
  });

  it("flags personal attributes, promises and shouting", () => {
    expect(policyLint("Spring sale on all shoes")).toEqual([]);
    expect(policyLint("Kilolu musun?").map((flag) => flag.rule)).toEqual(["personal_attributes"]);
    expect(policyLint("BUY NOW BEFORE IT IS GONE FOREVER").map((flag) => flag.rule)).toEqual(["shouting"]);
  });
});
