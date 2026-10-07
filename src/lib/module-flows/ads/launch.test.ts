import { describe, expect, it } from "vitest";

import { chainFromLaunch } from "./chain";
import { launchSpecFromFlow } from "./launch";
import type { AdsBrief } from "./state";

const brief: AdsBrief = {
  objective: "OUTCOME_ENGAGEMENT",
  dailyBudget: 20,
  days: 7,
  countries: ["TR", "DE"],
  ageMin: 18,
  ageMax: 65,
  gender: "women",
  link: "https://example.com",
  callToAction: "LEARN_MORE",
  source: { creativeId: "c1", assetId: "a1", title: "Spring" },
  currency: "TRY",
  dsaBeneficiary: "Acme",
  dsaPayor: "Acme Ltd",
};
const plan = { campaignName: "Spring", adSetName: "TR DE", adName: "Ad", primaryText: "Hello" };
const context = {
  adAccountId: "act_1",
  currency: "TRY",
  timezone: "Europe/Istanbul",
  pageId: "9",
  minCampaignSpendCapMinor: null,
  dsaBeneficiary: null,
  dsaPayor: null,
};

describe("launchSpecFromFlow", () => {
  it("maps the card to one campaign, ad set and ad with brakes", () => {
    const spec = launchSpecFromFlow({ brief, plan, context, activate: true });
    expect(spec.recipe).toBe("engagement_post");
    expect(spec.budget).toEqual({ mode: "DAILY", dailyMinor: 2_000, durationDays: 7 });
    expect(spec.adSets[0]).toMatchObject({
      optimizationGoal: "POST_ENGAGEMENT",
      destinationType: "ON_POST",
      advantageAudience: 0,
      targeting: { countries: ["TR", "DE"], genders: [2] },
      dsa: { beneficiary: "Acme", payor: "Acme Ltd" },
    });
    expect(spec.guards.campaignSpendCapMinor).toBe(15_400);
    expect(spec.ads[0]?.creative.imageAssetId).toBe("a1");
  });
});

describe("launchSpecFromFlow business hours", () => {
  const hours = { from: 9, to: 18, weekdaysOnly: true };

  it("puts the schedule on the ad set when the budget is a total", () => {
    const spec = launchSpecFromFlow({
      brief: { ...brief, budgetMode: "fixed", hours },
      plan,
      context,
      activate: false,
    });
    expect(spec.adSets[0]?.schedule).toEqual({
      days: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1080,
    });
  });

  it("drops it for a daily budget or an existing ad set", () => {
    expect(
      launchSpecFromFlow({ brief: { ...brief, hours }, plan, context, activate: false }).adSets[0]
        ?.schedule,
    ).toBeUndefined();
    expect(
      launchSpecFromFlow({
        brief: { ...brief, budgetMode: "fixed", hours, existingAdSetId: "123" },
        plan,
        context,
        activate: false,
      }).adSets[0]?.schedule,
    ).toBeUndefined();
  });
});

describe("launchSpecFromFlow carousel", () => {
  const traffic: AdsBrief = {
    ...brief,
    objective: "OUTCOME_TRAFFIC",
    adFormat: "carousel",
    extraSources: [
      { creativeId: "c2", assetId: "a2", title: "Summer" },
      { creativeId: "c3", assetId: "a3", title: "" },
    ],
  };

  it("turns every picked post into a card of one ad", () => {
    const spec = launchSpecFromFlow({ brief: traffic, plan, context, activate: false });
    expect(spec.ads).toHaveLength(1);
    expect(spec.ads[0]?.creative.cards).toEqual([
      { imageAssetId: "a1", headline: "Spring", link: "https://example.com" },
      { imageAssetId: "a2", headline: "Summer", link: "https://example.com" },
      { imageAssetId: "a3", link: "https://example.com" },
    ]);
    expect(spec.ads[0]?.creative.imageAssetId).toBe("a1");
  });

  it("keeps separate ads without the carousel format, and never mixes it with messages or forms", () => {
    const separate = launchSpecFromFlow({
      brief: { ...traffic, adFormat: "single" },
      plan,
      context,
      activate: false,
    });
    expect(separate.ads).toHaveLength(3);
    expect(separate.ads.every((ad) => !ad.creative.cards)).toBe(true);
    const messages = launchSpecFromFlow({
      brief: {
        ...traffic,
        objective: "OUTCOME_ENGAGEMENT",
        messages: { app: "MESSENGER" },
        link: "",
      },
      plan,
      context,
      activate: false,
    });
    expect(messages.ads.every((ad) => !ad.creative.cards)).toBe(true);
  });
});

describe("chainFromLaunch", () => {
  const base = { launchId: "l1", adSetCount: 1, adCount: 1, error: null };

  it("shows the single approval on the campaign link", () => {
    const chain = chainFromLaunch({ ...base, status: "AWAITING_APPROVAL", progress: {}, pendingApprovalId: "ap1" });
    expect(chain.links[0]).toMatchObject({ state: "approval", approvalId: "ap1" });
    expect(chain.v2?.canRetry).toBe(false);
  });

  it("follows the creation and ends live", () => {
    const creating = chainFromLaunch({ ...base, status: "CREATING", progress: { campaign: "c1" } });
    expect(creating.links.map((link) => link.state)).toEqual(["created", "running", "waiting"]);
    const live = chainFromLaunch({
      ...base,
      status: "ACTIVE",
      progress: { campaign: "c1", adSets: { 0: "s1" }, ads: { 0: "a1" }, endTime: 1_791_000_000 },
    });
    expect(live.complete).toBe(true);
    expect(live.v2).toMatchObject({ live: true, canTurnOn: false });
    expect(live.v2?.endsAt).toBeDefined();
  });

  it("puts a failure on its link and offers retry and discard", () => {
    const failed = chainFromLaunch({
      ...base,
      status: "FAILED",
      progress: { campaign: "c1" },
      error: { step: "adset:0", message: "Daily budget is below Meta's minimum." },
    });
    expect(failed.links.map((link) => link.state)).toEqual(["created", "failed", "blocked"]);
    expect(failed.stopped).toBe(true);
    expect(failed.v2).toMatchObject({ canRetry: true, canDiscard: true });
  });

  it("offers Turn on for a paused creation", () => {
    const paused = chainFromLaunch({
      ...base,
      status: "CREATED_PAUSED",
      progress: { campaign: "c1", adSets: { 0: "s1" }, ads: { 0: "a1" } },
    });
    expect(paused.v2).toMatchObject({ canTurnOn: true, canDiscard: true, live: false });
  });
});
