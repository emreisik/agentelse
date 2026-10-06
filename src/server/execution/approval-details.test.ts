import { describe, expect, it } from "vitest";

import { approvalCategory, buildApprovalDetails } from "./approval-details";

// The rows on an approval card say what approving does. The title is only the
// first 80 characters of the request, which for a new social account said
// nothing about a browser agent opening a real account.

describe("buildApprovalDetails: a new social account", () => {
  it.each([
    ["INSTAGRAM", "Instagram"],
    ["TIKTOK", "TikTok"],
    ["LINKEDIN", "LinkedIn"],
  ])("names %s and says what happens", (platform, name) => {
    const rows = buildApprovalDetails("SOCIAL_ACCOUNT_SETUP", {
      request: "x",
      platform,
    });

    expect(rows).toEqual([
      { label: "Platform", value: name },
      {
        label: "What happens",
        value: `A browser agent opens a new ${name} account for the brand. You may be asked for a verification code along the way.`,
      },
    ]);
  });

  it.each([{ request: "x" }, { platform: "" }, null, undefined])(
    "says plainly that %j cannot run: no platform was chosen",
    (payload) => {
      const rows = buildApprovalDetails("SOCIAL_ACCOUNT_SETUP", payload)!;

      expect(rows[0]).toEqual({ label: "Platform", value: "Not chosen" });
      expect(rows[1]!.value).toContain("This task cannot run");
      expect(rows[1]!.value).toContain("Reject it and ask again");
    },
  );

  // Tasks made before the check existed can carry a platform no account can be
  // set up on (X has no browser profile). The card says which and why.
  it.each(["X", "FACEBOOK"])(
    "says an account cannot be set up on %s",
    (platform) => {
      const rows = buildApprovalDetails("SOCIAL_ACCOUNT_SETUP", { platform })!;

      expect(rows[0]).toEqual({
        label: "Platform",
        value: `${platform} (not supported)`,
      });
      expect(rows[1]!.value).toContain(`cannot be set up on ${platform}`);
      expect(rows[1]!.value).toContain("Instagram, TikTok or LinkedIn");
    },
  );
});

describe("buildApprovalDetails: everything else is as it was", () => {
  it("shows nothing for a capability with nothing structured to show", () => {
    expect(buildApprovalDetails("CREATE_COPY", { request: "x" })).toBeUndefined();
    expect(buildApprovalDetails("TIKTOK_PUBLISH", {})).toBeUndefined();
  });

  it("still shows a Meta ad set's budget, saying when the currency is unknown", () => {
    expect(
      buildApprovalDetails("META_ADSET_CREATE", { dailyBudgetCents: 2500 }),
    ).toEqual([{ label: "Daily budget", value: "25 (account currency)" }]);
  });
});

describe("buildApprovalDetails: Meta money in the account's currency (F0b)", () => {
  it("prints a zero-decimal currency without the 100x error", () => {
    expect(
      buildApprovalDetails("META_ADSET_CREATE", {
        dailyBudgetCents: 1500,
        currency: "JPY",
        durationDays: 7,
      }),
    ).toEqual([
      { label: "Daily budget", value: "1,500 JPY" },
      { label: "Runs for", value: "7 days from creation, then Meta stops it" },
    ]);
  });

  it("shows the campaign's whole spend on the first link of the chain", () => {
    expect(
      buildApprovalDetails("META_CAMPAIGN_CREATE", {
        objective: "OUTCOME_TRAFFIC",
        __pendingAdSet: {
          dailyBudgetCents: 2000,
          currency: "TRY",
          durationDays: 7,
          targeting: { countries: ["TR"] },
        },
      }),
    ).toEqual([
      { label: "Objective", value: "Traffic" },
      { label: "Daily budget", value: "20 TRY" },
      { label: "Runs for", value: "7 days from creation, then Meta stops it" },
      { label: "Countries", value: "TR" },
    ]);
  });

  it("shows a proposed budget change in the account's currency", () => {
    expect(
      buildApprovalDetails("META_ADSET_UPDATE", {
        currentDailyBudgetCents: 5000,
        proposedDailyBudgetCents: 4000,
        currency: "TRY",
      }),
    ).toEqual([{ label: "Daily budget", value: "50 TRY → 40 TRY" }]);
  });
});

describe("approvalCategory", () => {
  it("keeps account actions in the 'action' bucket", () => {
    expect(approvalCategory("ACCOUNT_ACTION_APPROVAL", "LEVEL_3_CLIENT")).toBe(
      "action",
    );
  });
});
