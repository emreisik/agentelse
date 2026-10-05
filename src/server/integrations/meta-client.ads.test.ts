import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  adSetDestinationType,
  createMetaAdSet,
  createMetaCampaign,
} from "./meta-client";

// The request bodies of the Ads Manager launch chain (docs/modules.md): what
// Graph v24+ needs for a campaign whose ad sets carry the budget, and the ad
// set's destination for an Engagement goal.

const fetchMock = vi.fn();

function lastBody(): URLSearchParams {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return new URLSearchParams(String(init?.body ?? ""));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: "meta-1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CAMPAIGN = {
  adAccountId: "act_1",
  accessToken: "tok",
  name: "Autumn boost",
  objective: "OUTCOME_TRAFFIC",
  status: "PAUSED" as const,
};

describe("createMetaCampaign", () => {
  it("without a campaign budget, says the ad sets do not share theirs", async () => {
    await expect(createMetaCampaign(CAMPAIGN)).resolves.toEqual({
      campaignId: "meta-1",
    });
    const body = lastBody();
    expect(body.get("is_adset_budget_sharing_enabled")).toBe("false");
    expect(body.has("daily_budget")).toBe(false);
    expect(body.get("objective")).toBe("OUTCOME_TRAFFIC");
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("special_ad_categories")).toBe("[]");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toMatch(
      /\/act_1\/campaigns$/,
    );
  });

  it("with a campaign budget, sends it and no sharing flag", async () => {
    await createMetaCampaign({ ...CAMPAIGN, dailyBudgetCents: 2000 });
    const body = lastBody();
    expect(body.get("daily_budget")).toBe("2000");
    expect(body.has("is_adset_budget_sharing_enabled")).toBe(false);
  });
});

const AD_SET = {
  adAccountId: "act_1",
  accessToken: "tok",
  campaignId: "c1",
  name: "Turkey 18-65",
  dailyBudgetCents: 2000,
  billingEvent: "IMPRESSIONS",
  targeting: { countries: ["TR"], ageMin: 18, ageMax: 65 },
  status: "PAUSED" as const,
};

describe("createMetaAdSet", () => {
  it("an Engagement ad set (POST_ENGAGEMENT) is on the post", async () => {
    await expect(
      createMetaAdSet({ ...AD_SET, optimizationGoal: "POST_ENGAGEMENT" }),
    ).resolves.toEqual({ adSetId: "meta-1" });
    const body = lastBody();
    expect(body.get("destination_type")).toBe("ON_POST");
    expect(body.get("optimization_goal")).toBe("POST_ENGAGEMENT");
    expect(body.get("daily_budget")).toBe("2000");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toMatch(
      /\/act_1\/adsets$/,
    );
  });

  it("Traffic (LINK_CLICKS) and Awareness (REACH) send no destination", async () => {
    for (const optimizationGoal of ["LINK_CLICKS", "REACH"]) {
      await createMetaAdSet({ ...AD_SET, optimizationGoal });
      const body = lastBody();
      expect(body.has("destination_type")).toBe(false);
      expect(body.get("optimization_goal")).toBe(optimizationGoal);
    }
  });

  it("adSetDestinationType names only the goal that needs one", () => {
    expect(adSetDestinationType("POST_ENGAGEMENT")).toBe("ON_POST");
    expect(adSetDestinationType("LINK_CLICKS")).toBeUndefined();
    expect(adSetDestinationType("REACH")).toBeUndefined();
  });
});
