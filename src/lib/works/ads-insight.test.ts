import { describe, expect, it } from "vitest";

import {
  ZERO_DECIMAL_CURRENCIES,
  adsHref,
  buildAdsDigest,
  buildAdsInsight,
  canShowAmount,
  chipLabelFor,
  formatMinorUnits,
  isPauseProposal,
  proposalChangeText,
  type AdsDigest,
  type AdsPulse,
  type AdsPulseProposal,
} from "./ads-insight";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();

function digest(over: Partial<AdsDigest> = {}): AdsDigest {
  return {
    at: hoursAgo(2),
    currency: "TRY",
    campaigns: [
      {
        id: "c1",
        name: "Lead gen",
        dailyBudgetCents: 40_000,
        spend: 900,
        resultLabel: "Leads",
        resultCount: 24,
        costPerResult: 38.2,
        prevCostPerResult: 32.4,
        costChangePct: 17.9,
      },
    ],
    ...over,
  };
}

const proposal = (over: Partial<AdsPulseProposal> = {}): AdsPulseProposal => ({
  taskId: "t1",
  approvalId: "a1",
  capability: "META_CAMPAIGN_UPDATE",
  campaignId: "c1",
  campaignName: "Lead gen",
  currentDailyBudgetCents: 40_000,
  proposedDailyBudgetCents: 50_000,
  ...over,
});

function pulse(over: Partial<AdsPulse> = {}): AdsPulse {
  return {
    connected: true,
    hasAccount: true,
    digest: digest(),
    proposals: [],
    ...over,
  };
}

describe("currency rules (no amount without a usable currency)", () => {
  it("canShowAmount: known two-decimal currencies only", () => {
    expect(canShowAmount("TRY")).toBe(true);
    expect(canShowAmount("usd")).toBe(true);
    expect(canShowAmount("JPY")).toBe(false);
    expect(canShowAmount("KRW")).toBe(false);
    expect(canShowAmount("KWD")).toBe(false);
    expect(canShowAmount(undefined)).toBe(false);
    expect(canShowAmount("")).toBe(false);
    // Offset-1 currencies of Meta's table: 5,000,000 IDR must never print
    // as "50,000 IDR".
    for (const code of ["IDR", "HUF", "TWD", "COP", "CRC"]) {
      expect(canShowAmount(code), code).toBe(false);
    }
    expect(formatMinorUnits(5_000_000, "IDR")).toBeNull();
    expect(canShowAmount("TL")).toBe(false);
    expect(ZERO_DECIMAL_CURRENCIES).toEqual(
      expect.arrayContaining(["JPY", "KRW", "VND"]),
    );
  });

  it("formatMinorUnits: cents / 100, null without a usable currency", () => {
    expect(formatMinorUnits(50_000, "TRY")).toBe("500 TRY");
    expect(formatMinorUnits(1_250, "USD")).toBe("12.50 USD");
    expect(formatMinorUnits(50_000, "JPY")).toBeNull();
    expect(formatMinorUnits(50_000, undefined)).toBeNull();
    expect(formatMinorUnits(Number.NaN, "TRY")).toBeNull();
  });

  it("proposalChangeText names the change with amounts only when allowed", () => {
    expect(proposalChangeText(40_000, 50_000, "TRY")).toBe(
      "Raise the daily budget from 400 TRY to 500 TRY",
    );
    expect(proposalChangeText(50_000, 40_000, "TRY")).toBe(
      "Lower the daily budget from 500 TRY to 400 TRY",
    );
    const generic = "Change the daily budget (waiting for your approval)";
    expect(proposalChangeText(40_000, 50_000, "JPY")).toBe(generic);
    expect(proposalChangeText(40_000, 50_000, undefined)).toBe(generic);
    expect(proposalChangeText(undefined, 50_000, "TRY")).toBe(generic);
    expect(proposalChangeText(40_000, undefined, "TRY")).toBe(generic);
    expect(proposalChangeText(40_000, 40_000, "TRY")).toBe(generic);
  });
});

describe("chipLabelFor (guard ads-pure)", () => {
  it("says CPL only for Leads", () => {
    expect(chipLabelFor("Leads")).toBe("CPL");
    expect(chipLabelFor("Post Engagement")).toBe("Cost / Post Engagement");
    expect(chipLabelFor("Link Clicks")).toBe("Cost / Link Clicks");
    expect(chipLabelFor(undefined)).toBe("Cost / result");
    expect(chipLabelFor("  ")).toBe("Cost / result");
  });
});

describe("buildAdsDigest", () => {
  const campaigns = Array.from({ length: 7 }, (_, i) => ({
    campaignId: `c${i}`,
    name: `Campaign ${i}`,
    effectiveStatus: "ACTIVE",
    dailyBudgetCents: 10_000,
  }));

  it("keeps the top 5 by spend", () => {
    const insights = new Map(
      campaigns.map((c, i) => [c.campaignId, { spend: 10 * (i + 1) }]),
    );
    const result = buildAdsDigest({
      insights,
      campaigns,
      currency: "TRY",
      now: NOW,
    });
    expect(result.campaigns.map((c) => c.id)).toEqual([
      "c6",
      "c5",
      "c4",
      "c3",
      "c2",
    ]);
    expect(result.at).toBe(NOW.toISOString());
    expect(result.currency).toBe("TRY");
  });

  it("computes the change in percent to one decimal only when both costs exist", () => {
    const result = buildAdsDigest({
      insights: new Map([
        ["c0", { spend: 100, costPerResult: 38.2, resultLabel: "Leads" }],
        ["c1", { spend: 90, costPerResult: 10 }],
        ["c2", { spend: 80 }],
      ]),
      previousSnapshot: {
        "meta-campaign:c0": { costPerResult: 32.4 },
        "meta-campaign:c2": { costPerResult: 5 },
      },
      campaigns: campaigns.slice(0, 3),
      currency: "TRY",
      now: NOW,
    });
    const [c0, c1, c2] = result.campaigns;
    expect(c0?.costChangePct).toBe(17.9);
    expect(c0?.prevCostPerResult).toBe(32.4);
    expect(c1?.costChangePct).toBeUndefined();
    expect(c2?.costChangePct).toBeUndefined();
  });

  it("gives no baseline when the previous row counts another result", () => {
    const result = buildAdsDigest({
      insights: new Map([
        ["c0", { spend: 100, costPerResult: 25, resultLabel: "Leads" }],
        ["c1", { spend: 90, costPerResult: 10, resultLabel: "Leads" }],
      ]),
      previousSnapshot: {
        "meta-campaign:c0": { costPerResult: 2, resultLabel: "Link Clicks" },
        "meta-campaign:c1": { costPerResult: 8, resultLabel: "Leads" },
      },
      campaigns: campaigns.slice(0, 2),
      currency: "TRY",
      now: NOW,
    });
    const [c0, c1] = result.campaigns;
    expect(c0?.costChangePct).toBeUndefined();
    expect(c0?.prevCostPerResult).toBeUndefined();
    expect(c1?.costChangePct).toBe(25);
  });

  it("skips paused, spend-less and budget-less campaigns and never throws", () => {
    const result = buildAdsDigest({
      insights: {
        a: { spend: 5 },
        b: { spend: 0 },
        c: { spend: 5 },
        d: { spend: 5 },
      },
      campaigns: [
        {
          campaignId: "a",
          name: "A",
          effectiveStatus: "PAUSED",
          dailyBudgetCents: 1,
        },
        {
          campaignId: "b",
          name: "B",
          effectiveStatus: "ACTIVE",
          dailyBudgetCents: 1,
        },
        { campaignId: "c", name: "C", effectiveStatus: "ACTIVE" },
        {
          campaignId: "d",
          name: "D",
          effectiveStatus: "ACTIVE",
          dailyBudgetCents: 100,
        },
        {
          campaignId: "e",
          name: "E",
          effectiveStatus: "ACTIVE",
          dailyBudgetCents: 100,
        },
      ],
      currency: "TRY",
      now: NOW,
    });
    expect(result.campaigns.map((c) => c.id)).toEqual(["d"]);

    const broken = buildAdsDigest({
      insights: null as never,
      campaigns: [{ campaignId: "x", name: "X" }],
      currency: "TRY",
      now: new Date("nope"),
    });
    expect(broken.campaigns).toEqual([]);
  });
});

describe("buildAdsInsight: the five honest states (guard ads-pure)", () => {
  it("1. not connected", () => {
    const card = buildAdsInsight(
      pulse({ connected: false, hasAccount: false, digest: null }),
      NOW,
    );
    expect(card.state).toBe("needs-connect");
    expect(card.headline).toBe(
      "Connect Meta Ads to see cost per lead and budget suggestions.",
    );
    expect(card.chips).toEqual([]);
  });

  it("2. connected without an ad account", () => {
    const card = buildAdsInsight(
      pulse({ hasAccount: false, digest: null }),
      NOW,
    );
    expect(card.state).toBe("needs-account");
    expect(card.headline).toBe(
      "Meta Ads is connected, but no ad account is selected.",
    );
  });

  it("3. connected and never scanned", () => {
    const card = buildAdsInsight(pulse({ digest: null }), NOW);
    expect(card.state).toBe("no-data");
    expect(card.headline).toBe(
      "The first check runs within a few hours. You can check now.",
    );
  });

  it("4. scanned with nothing to report", () => {
    const card = buildAdsInsight(
      pulse({ digest: digest({ campaigns: [] }), lastScanAt: hoursAgo(2) }),
      NOW,
    );
    expect(card.state).toBe("nothing");
    expect(card.headline).toBe(
      "No active campaign with spend and a daily budget in the last 7 days. Campaigns with a lifetime budget aren't checked.",
    );
  });

  it("5. stale by age keeps the old numbers and says when", () => {
    const card = buildAdsInsight(
      pulse({ digest: digest({ at: "2026-09-29T08:00:00.000Z" }) }),
      NOW,
    );
    expect(card.state).toBe("stale");
    expect(card.headline).toBe(
      "These numbers are from 29 Sept and may be out of date.",
    );
    expect(card.asOf).toBe("2026-09-29T08:00:00.000Z");
    expect(card.chips[0]).toEqual({ label: "CPL", value: "38.20 TRY" });
  });

  it("5. stale by failures even when the numbers are young", () => {
    const card = buildAdsInsight(pulse({ failureCount: 2 }), NOW);
    expect(card.state).toBe("stale");
  });

  it("is fresh just inside 26 hours and stale just outside", () => {
    expect(
      buildAdsInsight(pulse({ digest: digest({ at: hoursAgo(25.9) }) }), NOW)
        .state,
    ).toBe("ok");
    expect(
      buildAdsInsight(pulse({ digest: digest({ at: hoursAgo(26.1) }) }), NOW)
        .state,
    ).toBe("stale");
  });

  it("never claims fresh numbers for an unreadable timestamp", () => {
    expect(
      buildAdsInsight(pulse({ digest: digest({ at: "garbage" }) }), NOW).state,
    ).toBe("stale");
  });
});

describe("buildAdsInsight: the ok card", () => {
  it("builds the headline, the CPL chip and the change chip", () => {
    const card = buildAdsInsight(pulse(), NOW);
    expect(card.state).toBe("ok");
    expect(card.headline).toBe("Lead gen: cost per Leads is 38.20 TRY");
    expect(card.campaignId).toBe("c1");
    expect(card.campaignName).toBe("Lead gen");
    expect(card.currency).toBe("TRY");
    expect(card.chips[0]).toEqual({ label: "CPL", value: "38.20 TRY" });
    expect(card.chips[1]).toMatchObject({
      label: "+17.9% vs last check",
      tone: "bad",
    });
  });

  it("labels a non-Leads result as Cost / label, never CPL", () => {
    const card = buildAdsInsight(
      pulse({
        digest: digest({
          campaigns: [
            {
              id: "c1",
              name: "Reach",
              dailyBudgetCents: 40_000,
              spend: 10,
              resultLabel: "Post Engagement",
              costPerResult: 0.4,
              costChangePct: -12,
            },
          ],
        }),
      }),
      NOW,
    );
    expect(card.headline).toBe("Reach: cost per Post Engagement is 0.40 TRY");
    expect(card.chips.map((c) => c.label)).not.toContain("CPL");
    expect(card.chips[0]?.label).toBe("Cost / Post Engagement");
    expect(card.chips[1]).toMatchObject({
      label: "-12% vs last check",
      tone: "good",
    });
  });

  it("prints no cost without a usable currency", () => {
    const card = buildAdsInsight(
      pulse({ digest: digest({ currency: "" }) }),
      NOW,
    );
    expect(card.state).toBe("ok");
    expect(card.chips.find((c) => c.label === "CPL")).toBeUndefined();
    expect(card.headline).toBe("Lead gen");
    expect(JSON.stringify(card)).not.toMatch(/38\.2/);
  });
});

describe("buildAdsInsight: proposals", () => {
  it("shows a pending proposal with the amounts and the Suggested chip", () => {
    const card = buildAdsInsight(
      pulse({ proposals: [proposal({ proposedStatus: "ACTIVE" })] }),
      NOW,
    );
    expect(card.proposal).toEqual({
      taskId: "t1",
      approvalId: "a1",
      capability: "META_CAMPAIGN_UPDATE",
      currentDailyBudgetCents: 40_000,
      proposedDailyBudgetCents: 50_000,
      proposedStatus: "ACTIVE",
      state: "pending",
      changeText: "Raise the daily budget from 400 TRY to 500 TRY",
    });
    expect(card.chips.map((c) => c.label)).toContain("Suggested 500 TRY / day");
    expect(card.more).toBeUndefined();
  });

  it("hides every amount without a usable currency (TRY-only 100x guard)", () => {
    for (const currency of ["JPY", "KRW", ""]) {
      const card = buildAdsInsight(
        pulse({ digest: digest({ currency }), proposals: [proposal()] }),
        NOW,
      );
      expect(card.proposal?.changeText).toBe(
        "Change the daily budget (waiting for your approval)",
      );
      expect(card.chips.some((c) => c.label.startsWith("Suggested"))).toBe(
        false,
      );
      expect(JSON.stringify(card.chips)).not.toMatch(/500|50000/);
    }
  });

  it("marks the proposal changed when the live budget moved, and offers no amounts", () => {
    const card = buildAdsInsight(
      pulse({ proposals: [proposal({ currentDailyBudgetCents: 30_000 })] }),
      NOW,
    );
    expect(card.proposal?.state).toBe("changed");
    expect(card.proposal?.changeText).toBe(
      "The budget changed since this was proposed. Dismiss it; a new suggestion can follow the next check.",
    );
    expect(card.proposal?.proposedDailyBudgetCents).toBeUndefined();
    expect(card.chips.some((c) => c.label.startsWith("Suggested"))).toBe(false);
  });

  it("does not call a proposal changed when its campaign is outside the digest", () => {
    // The digest keeps the top 5 by spend; the proposal is about another one.
    const card = buildAdsInsight(
      pulse({
        proposals: [
          proposal({
            campaignId: "c9-not-in-digest",
            currentDailyBudgetCents: 12_300,
          }),
        ],
      }),
      NOW,
    );
    expect(card.proposal?.state).toBe("pending");
    expect(card.proposal?.proposedDailyBudgetCents).toBe(50_000);
    // The headline still falls back to the top campaign.
    expect(card.campaignId).toBe("c1");
  });

  it("does not call a proposal without a campaign id changed", () => {
    const card = buildAdsInsight(
      pulse({
        proposals: [
          proposal({ campaignId: undefined, currentDailyBudgetCents: 12_300 }),
        ],
      }),
      NOW,
    );
    expect(card.proposal?.state).toBe("pending");
  });

  it("names a pause proposal as a pause, never as a budget change", () => {
    const pause = proposal({
      proposedStatus: "PAUSED",
      proposedDailyBudgetCents: undefined,
    });
    expect(isPauseProposal(pause)).toBe(true);
    expect(isPauseProposal(proposal({ proposedStatus: "PAUSED" }))).toBe(false);
    expect(isPauseProposal(proposal({ proposedStatus: "ACTIVE" }))).toBe(false);
    const card = buildAdsInsight(pulse({ proposals: [pause] }), NOW);
    expect(card.proposal?.state).toBe("pending");
    expect(card.proposal?.changeText).toBe(
      "Pause this campaign (waiting for your approval)",
    );
    expect(card.proposal?.changeText).not.toMatch(/budget/i);
    expect(card.chips.some((c) => c.label.startsWith("Suggested"))).toBe(false);
    expect(
      proposalChangeText(40_000, undefined, "TRY", "PAUSED"),
    ).toBe("Pause this campaign (waiting for your approval)");
    expect(proposalChangeText(40_000, undefined, "TRY")).toBe(
      "Change the daily budget (waiting for your approval)",
    );
  });

  it("lets the proposal's campaign win the headline and counts the rest as more", () => {
    const two = digest({
      campaigns: [
        { id: "c9", name: "Big", dailyBudgetCents: 1, spend: 99 },
        {
          id: "c1",
          name: "Lead gen",
          dailyBudgetCents: 40_000,
          spend: 10,
          resultLabel: "Leads",
          costPerResult: 20,
        },
      ],
    });
    const card = buildAdsInsight(
      pulse({
        digest: two,
        proposals: [proposal(), proposal({ taskId: "t2", approvalId: "a2" })],
      }),
      NOW,
    );
    expect(card.campaignId).toBe("c1");
    expect(card.more).toBe(1);
  });

  it("keeps a pending spend proposal reachable in the stale and nothing states", () => {
    expect(
      buildAdsInsight(
        pulse({ digest: digest({ campaigns: [] }), proposals: [proposal()] }),
        NOW,
      ).proposal?.state,
    ).toBe("pending");
    expect(
      buildAdsInsight(pulse({ failureCount: 1, proposals: [proposal()] }), NOW)
        .proposal,
    ).toBeDefined();
  });

  it("does not carry a proposal when Meta is not connected", () => {
    const card = buildAdsInsight(
      pulse({ connected: false, proposals: [proposal()] }),
      NOW,
    );
    expect(card.proposal).toBeUndefined();
  });
});

describe("adsHref", () => {
  it("builds the plain, create and detail forms", () => {
    expect(adsHref("p1")).toBe("/projects/p1/ads");
    expect(adsHref("p1", { create: true })).toBe(
      "/projects/p1/ads?create=campaign",
    );
    expect(adsHref("p1", { create: true, brief: "Summer sale" })).toBe(
      "/projects/p1/ads?create=campaign&brief=Summer+sale",
    );
    expect(adsHref("p1", { campaignDetail: "123" })).toBe(
      "/projects/p1/ads?campaignDetail=123",
    );
  });
});
