import { describe, expect, it } from "vitest";

import {
  ADS_BRIEF_ISSUE,
  adsFlowData,
  adsLaunchPayload,
  audienceLine,
  briefChangesPlan,
  briefIssue,
  budgetMinorUnits,
  clipWords,
  defaultAdsCountries,
  defaultAdsPlan,
  formatBudget,
  normalizeBudget,
  parseAdsFlowState,
  planIssue,
  spendLine,
  viewStepOf,
  withScheme,
  type AdsBrief,
  type AdsBriefInput,
  type AdsPlan,
} from "./state";

const BRIEF: AdsBrief = {
  objective: "OUTCOME_TRAFFIC",
  dailyBudget: 20,
  days: 7,
  countries: ["TR", "DE"],
  ageMin: 18,
  ageMax: 65,
  gender: "all",
  link: "https://example.com/spring",
  callToAction: "LEARN_MORE",
  source: {
    creativeId: "cr1",
    assetId: "as1",
    title: "Spring menu",
    caption:
      "Our spring menu is here: fresh herbs, local cheese and a new lemonade. Visit https://example.com today! #spring #food",
  },
  currency: "TRY",
  pageName: "Cafe Lale",
};

const PLAN: AdsPlan = {
  campaignName: "Spring menu · Traffic",
  adSetName: "TR, DE · 18–65+",
  adName: "Spring menu",
  primaryText: "Fresh herbs, local cheese and a new lemonade: our spring menu.",
};

const INPUT: AdsBriefInput = {
  creativeId: "cr1",
  objective: "OUTCOME_TRAFFIC",
  dailyBudget: 20,
  days: 7,
  countries: ["TR"],
  ageMin: 18,
  ageMax: 65,
  gender: "all",
  link: "https://example.com",
  callToAction: "LEARN_MORE",
};

describe("parseAdsFlowState", () => {
  it("reads each part on its own and drops a broken one", () => {
    const state = parseAdsFlowState({
      hint: { sourceCreativeId: "cr9" },
      brief: BRIEF,
      plan: { ...PLAN, primaryText: "x".repeat(400) },
      launch: { claimId: "c1", startedAt: "2026-10-05T10:00:00.000Z" },
      stray: 1,
    });
    expect(state.hint).toEqual({ sourceCreativeId: "cr9" });
    expect(state.brief?.source.assetId).toBe("as1");
    // Too long for Meta's visible text: not a plan.
    expect(state.plan).toBeUndefined();
    expect(state.launch?.claimId).toBe("c1");
    expect(adsFlowData(state)).not.toHaveProperty("stray");
  });

  it("never throws on what is not an object", () => {
    expect(parseAdsFlowState(null)).toEqual({});
    expect(parseAdsFlowState([1, 2])).toEqual({});
    expect(
      parseAdsFlowState({ brief: { objective: "OUTCOME_SALES" } }),
    ).toEqual({});
  });
});

describe("viewStepOf", () => {
  it("holds a step back while what it needs is missing", () => {
    expect(viewStepOf("review", {})).toBe("brief");
    expect(viewStepOf("create", { brief: BRIEF })).toBe("plan");
    expect(viewStepOf("brief", { brief: BRIEF, plan: PLAN })).toBe("brief");
    expect(viewStepOf("review", { brief: BRIEF, plan: PLAN })).toBe("review");
    // Deliver without a launch (a released claim) is the Review again.
    expect(viewStepOf("deliver", { brief: BRIEF, plan: PLAN })).toBe("review");
  });

  it("stays on Launch once launched", () => {
    const launch = { claimId: "c1", startedAt: "2026-10-05T10:00:00.000Z" };
    expect(viewStepOf("brief", { brief: BRIEF, plan: PLAN, launch })).toBe(
      "deliver",
    );
  });
});

describe("briefIssue", () => {
  it("is null for a full brief", () => {
    expect(briefIssue(INPUT)).toBeNull();
  });

  it("names the first problem in the form's order", () => {
    expect(briefIssue({ ...INPUT, creativeId: undefined })).toBe(
      ADS_BRIEF_ISSUE.post,
    );
    expect(briefIssue({ ...INPUT, dailyBudget: Number.NaN })).toBe(
      ADS_BRIEF_ISSUE.budget,
    );
    expect(briefIssue({ ...INPUT, dailyBudget: 0, countries: [] })).toBe(
      ADS_BRIEF_ISSUE.budget,
    );
    expect(briefIssue({ ...INPUT, countries: [] })).toBe(
      ADS_BRIEF_ISSUE.countries,
    );
    expect(briefIssue({ ...INPUT, ageMin: 40, ageMax: 30 })).toBe(
      ADS_BRIEF_ISSUE.ages,
    );
    expect(briefIssue({ ...INPUT, ageMin: 12 })).toBe(ADS_BRIEF_ISSUE.ages);
    expect(briefIssue({ ...INPUT, link: "example" })).toBe(
      ADS_BRIEF_ISSUE.link,
    );
    expect(briefIssue({ ...INPUT, link: "javascript:alert(1)" })).toBe(
      ADS_BRIEF_ISSUE.link,
    );
    expect(briefIssue({ ...INPUT, days: 5 })).toBe(ADS_BRIEF_ISSUE.other);
  });

  it("takes a link typed without its scheme", () => {
    expect(withScheme("example.com/spring")).toBe("https://example.com/spring");
    expect(withScheme("http://example.com")).toBe("http://example.com");
    expect(
      briefIssue({ ...INPUT, link: withScheme("example.com") }),
    ).toBeNull();
  });
});

describe("planIssue", () => {
  it("asks for names, then for a short enough text", () => {
    expect(planIssue(PLAN)).toBeNull();
    expect(planIssue({ ...PLAN, adName: "  " })).toMatch(/name/);
    expect(planIssue({ ...PLAN, primaryText: "x".repeat(126) })).toMatch(
      /125 characters/,
    );
  });
});

describe("money", () => {
  it("counts Meta's minor units per currency", () => {
    expect(budgetMinorUnits(20, "TRY")).toBe(2000);
    expect(budgetMinorUnits(12.345, "EUR")).toBe(1235);
    // Whole units: no 100x error.
    expect(budgetMinorUnits(1500, "JPY")).toBe(1500);
    expect(budgetMinorUnits(7, undefined)).toBe(700);
    expect(normalizeBudget(12.5, "JPY")).toBe(13);
  });

  it("prints the spend with the currency when it is known", () => {
    expect(spendLine(BRIEF)).toBe("20 TRY a day × 7 days = 140 TRY");
    expect(spendLine({ dailyBudget: 12.5, days: 3, currency: "EUR" })).toBe(
      "12.50 EUR a day × 3 days = 37.50 EUR",
    );
    expect(formatBudget(1234.5)).toBe("1,234.50");
  });
});

describe("words", () => {
  it("reads the audience in one line", () => {
    expect(audienceLine(BRIEF)).toBe("Turkey, Germany · 18–65+ · All genders");
    expect(
      audienceLine({
        countries: ["TR", "DE", "FR", "NL"],
        ageMin: 25,
        ageMax: 44,
        gender: "women",
      }),
    ).toBe("Turkey, Germany, France +1 · 25–44 · Women");
  });

  it("clips at a word and marks the cut", () => {
    expect(clipWords("one two three", 20)).toBe("one two three");
    expect(clipWords("one two three four", 13)).toBe("one two three");
    expect(clipWords("one two three four", 14, true)).toBe("one two three…");
  });

  it("starts the Plan from the post's own words, without links or hashtags", () => {
    const plan = defaultAdsPlan(BRIEF);
    expect(plan.campaignName).toBe("Spring menu · Traffic");
    expect(plan.adName).toBe("Spring menu");
    expect(plan.adSetName).toBe("TR, DE · 18–65+ · All genders");
    expect(plan.primaryText).not.toMatch(/https?:|#/);
    expect(plan.primaryText.length).toBeLessThanOrEqual(125);
    expect(planIssue(plan)).toBeNull();
  });

  it("drops a market the targeting list does not know", () => {
    expect(defaultAdsCountries(["DE", "ZZ", "tr"], "TR")).toEqual(["TR", "DE"]);
    expect(defaultAdsCountries([], null)).toEqual([]);
  });
});

describe("briefChangesPlan", () => {
  it("only another post or goal makes the written ad stale", () => {
    const budgetOnly: AdsBrief = { ...BRIEF, dailyBudget: 50 };
    expect(briefChangesPlan(undefined, BRIEF)).toBe(true);
    expect(briefChangesPlan(BRIEF, budgetOnly)).toBe(false);
    expect(
      briefChangesPlan(BRIEF, { ...BRIEF, objective: "OUTCOME_AWARENESS" }),
    ).toBe(true);
    expect(
      briefChangesPlan(BRIEF, {
        ...BRIEF,
        source: { ...BRIEF.source, creativeId: "cr2" },
      }),
    ).toBe(true);
  });
});

describe("adsLaunchPayload", () => {
  it("is the campaign the relays continue: ad set and ad pending, all paused", () => {
    const payload = adsLaunchPayload(
      { ...BRIEF, gender: "women", objective: "OUTCOME_ENGAGEMENT" },
      PLAN,
    );
    expect(payload).toEqual({
      name: PLAN.campaignName,
      objective: "OUTCOME_ENGAGEMENT",
      status: "PAUSED",
      currency: "TRY",
      __pendingAdSet: {
        name: PLAN.adSetName,
        dailyBudgetCents: 2000,
        // F0b: the end date is set from this when the ad set is created.
        durationDays: 7,
        advantageAudience: 0,
        currency: "TRY",
        billingEvent: "IMPRESSIONS",
        optimizationGoal: "POST_ENGAGEMENT",
        targeting: {
          countries: ["TR", "DE"],
          ageMin: 18,
          ageMax: 65,
          genders: [2],
        },
        pendingAd: {
          name: PLAN.adName,
          message: PLAN.primaryText,
          link: BRIEF.link,
          imageAssetId: "as1",
          callToActionType: "LEARN_MORE",
          format: "SINGLE_IMAGE",
          status: "PAUSED",
        },
      },
    });
    // The budget lives on the ad set only (Meta takes one or the other).
    expect(payload).not.toHaveProperty("dailyBudgetCents");
  });

  it("pins the Brief's ad account on every link and sends the EU disclosure (F0b)", () => {
    const payload = adsLaunchPayload(
      {
        ...BRIEF,
        adAccountId: "act_7",
        dsaBeneficiary: "Cafe Lale",
        dsaPayor: "Cafe Lale GmbH",
      },
      PLAN,
    );
    expect(payload).toMatchObject({
      adAccountId: "act_7",
      __pendingAdSet: {
        adAccountId: "act_7",
        dsa: { beneficiary: "Cafe Lale", payor: "Cafe Lale GmbH" },
      },
    });
  });

  it("sends no EU disclosure outside the EU", () => {
    const payload = adsLaunchPayload(
      {
        ...BRIEF,
        countries: ["TR"],
        dsaBeneficiary: "Cafe Lale",
        dsaPayor: "Cafe Lale",
      },
      PLAN,
    );
    expect(payload.__pendingAdSet).not.toHaveProperty("dsa");
  });

  it("targets every gender by leaving genders out", () => {
    const payload = adsLaunchPayload(BRIEF, PLAN);
    expect(payload.__pendingAdSet.targeting).not.toHaveProperty("genders");
    expect(payload.__pendingAdSet.optimizationGoal).toBe("LINK_CLICKS");
  });
});

describe("carousel brief rules", () => {
  const input = {
    creativeId: "c1",
    objective: "OUTCOME_TRAFFIC",
    dailyBudget: 20,
    days: 7,
    countries: ["TR"],
    ageMin: 18,
    ageMax: 65,
    gender: "all",
    link: "https://example.com",
    callToAction: "LEARN_MORE",
  };

  it("needs at least one more post and allows up to nine", () => {
    expect(briefIssue({ ...input, adFormat: "carousel" })).not.toBeNull();
    expect(
      briefIssue({ ...input, adFormat: "carousel", extraCreativeIds: ["c2"] }),
    ).toBeNull();
    const nine = Array.from({ length: 9 }, (_, i) => `x${i}`);
    expect(briefIssue({ ...input, adFormat: "carousel", extraCreativeIds: nine })).toBeNull();
    expect(
      briefIssue({ ...input, adFormat: "carousel", extraCreativeIds: [...nine, "x9"] }),
    ).not.toBeNull();
  });

  it("separate ads still stop at two extra posts", () => {
    expect(briefIssue({ ...input, extraCreativeIds: ["c2", "c3"] })).toBeNull();
    expect(briefIssue({ ...input, extraCreativeIds: ["c2", "c3", "c4"] })).not.toBeNull();
  });

  it("is for website goals only", () => {
    expect(
      briefIssue({
        ...input,
        objective: "OUTCOME_ENGAGEMENT",
        adFormat: "carousel",
        extraCreativeIds: ["c2"],
        link: "",
        messages: { app: "MESSENGER" },
      }),
    ).not.toBeNull();
  });
});

describe("business hours brief rules", () => {
  const input = {
    creativeId: "c1",
    objective: "OUTCOME_TRAFFIC",
    dailyBudget: 20,
    days: 7,
    countries: ["TR"],
    ageMin: 18,
    ageMax: 65,
    gender: "all",
    link: "https://example.com",
    callToAction: "LEARN_MORE",
    budgetMode: "fixed",
    hours: { from: 9, to: 18, weekdaysOnly: true },
  };

  it("accepts business hours with a total budget", () => {
    expect(briefIssue(input)).toBeNull();
  });

  it("needs a total budget, a later end hour and a new campaign", () => {
    expect(briefIssue({ ...input, budgetMode: "daily" })).toBe(ADS_BRIEF_ISSUE.hours);
    expect(briefIssue({ ...input, hours: { from: 18, to: 9, weekdaysOnly: true } })).toBe(
      ADS_BRIEF_ISSUE.hours,
    );
    expect(briefIssue({ ...input, existingAdSetId: "123" })).toBe(ADS_BRIEF_ISSUE.hours);
  });
});

describe("Instagram profile brief rules", () => {
  const input = {
    creativeId: "c1",
    objective: "OUTCOME_TRAFFIC",
    dailyBudget: 20,
    days: 7,
    countries: ["TR"],
    ageMin: 18,
    ageMax: 65,
    gender: "all",
    link: "",
    callToAction: "LEARN_MORE",
    trafficEvent: "PROFILE_VISITS",
  };

  it("needs no website link", () => {
    expect(briefIssue(input)).toBeNull();
    expect(briefIssue({ ...input, trafficEvent: "LINK_CLICKS" })).toBe(ADS_BRIEF_ISSUE.link);
  });

  it("is for the website goal only, without messages", () => {
    expect(briefIssue({ ...input, objective: "OUTCOME_AWARENESS" })).toBe(ADS_BRIEF_ISSUE.profile);
    expect(
      briefIssue({
        ...input,
        objective: "OUTCOME_ENGAGEMENT",
        messages: { app: "MESSENGER" },
      }),
    ).not.toBeNull();
  });
});
