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
