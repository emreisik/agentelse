import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The buttons call server actions and the router; here only what they show matters.
vi.mock("@/server/actions/billing-actions", () => ({
  startCheckoutAction: vi.fn(),
  checkPromoCodeAction: vi.fn(),
  startPackCheckoutAction: vi.fn(),
  openPortalAction: vi.fn(),
  cancelSubscriptionAction: vi.fn(),
  resumeSubscriptionAction: vi.fn(),
  changePlanAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { comparisonRows, planCards } from "@/lib/billing/catalog";
import { YEARLY_DISCOUNT_PCT } from "@/lib/billing/plans";
import type { BillingOverview } from "@/server/billing/overview";

import { BILLING_TABS, BillingTabs, parseBillingTab } from "./billing-tabs";
import { PlanPicker } from "./plan-picker";
import { SubscriptionPanel, cancelDescription } from "./subscription-panel";
import { TasksPanel } from "./tasks-panel";
import { UsagePanel } from "./usage-panel";

// The Plan & usage screens rendered on the server with realistic data: what a
// person reads, and that the states (running low, used up, no plan yet, paused
// work) say the right thing. The prices come from plans.ts, so these numbers are
// the product's.

const EMPTY: BillingOverview = {
  mode: "off",
  subscription: null,
  allowances: [],
  measured: {
    since: "2026-10-01T00:00:00.000Z",
    images: 0,
    aiRequests: 0,
    byModule: [],
    daily: [],
  },
  tasks: { active: [], paused: [], awaitingApproval: [] },
};

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

// The button's class list always mentions "disabled:" (a style variant); only the
// attribute says whether it is disabled.
const isDisabled = (button: string) => / disabled=""/.test(button);

describe("BillingTabs", () => {
  it("falls back to the plans tab for anything unknown", () => {
    expect(parseBillingTab(undefined)).toBe("plans");
    expect(parseBillingTab("nope")).toBe("plans");
    expect(parseBillingTab(["usage", "tasks"])).toBe("usage");
    for (const tab of BILLING_TABS)
      expect(parseBillingTab(tab.id)).toBe(tab.id);
  });

  it("links every tab by address and marks the open one", () => {
    const markup = html(createElement(BillingTabs, { active: "usage" }));
    for (const tab of BILLING_TABS) {
      expect(markup).toContain(`href="/billing?tab=${tab.id}"`);
      expect(markup).toContain(tab.label);
    }
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-current="page"[^>]*>Usage</);
  });
});

describe("PlanPicker", () => {
  const props = {
    cards: planCards(),
    comparison: comparisonRows(),
    currentPlanKey: null,
    yearlyDiscountPct: YEARLY_DISCOUNT_PCT,
    mode: { kind: "browse" },
  } as const satisfies Parameters<typeof PlanPicker>[0];

  it("shows the four plans at their monthly prices and what each includes", () => {
    const markup = html(createElement(PlanPicker, props));
    for (const label of ["Starter", "Growth", "Business", "Agency"]) {
      expect(markup).toContain(label);
    }
    for (const price of ["$79", "$149", "$299", "$599"]) {
      expect(markup).toContain(price);
    }
    expect(markup).toContain("20 post images a month");
    expect(markup).toContain("300 post images a month");
    expect(markup).toContain("Limited background automation");
    expect(markup).toContain("Full background automation");
  });

  it("has the discount button, the promo field and the yearly switch", () => {
    const markup = html(createElement(PlanPicker, props));
    expect(markup).toContain("Apply first-month discount");
    expect(markup).toContain("Promo code");
    expect(markup).toContain(`Yearly · save ${YEARLY_DISCOUNT_PCT}%`);
    expect(markup).toContain("Monthly");
  });

  it("does not offer a plan that cannot be bought yet, and says so", () => {
    const markup = html(createElement(PlanPicker, props));
    expect(markup).toContain("Plans are not on sale yet");
    // Every plan button is disabled.
    const buttons =
      markup.match(/<button[^>]*>Choose [A-Za-z]+<\/button>/g) ?? [];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(isDisabled(button)).toBe(true);
  });

  it("a workspace with no paying subscription gets a Subscribe button on every plan", () => {
    const markup = html(
      createElement(PlanPicker, {
        ...props,
        mode: { kind: "subscribe", firstMonthAvailable: true },
      }),
    );
    expect(markup).not.toContain("Plans are not on sale yet");
    const buttons =
      markup.match(/<button[^>]*>Subscribe to [A-Za-z]+<\/button>/g) ?? [];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(isDisabled(button)).toBe(false);
    expect(markup).toContain("Payment is handled by Stripe");
    // The discount button works.
    expect(
      isDisabled(
        markup.match(
          /<button[^>]*>(?:<svg.*?<\/svg>)?Apply first-month discount<\/button>/,
        )![0],
      ),
    ).toBe(false);
  });

  it("the promo code field works once plans can be bought, and is off while they cannot", () => {
    const open = html(
      createElement(PlanPicker, {
        ...props,
        mode: { kind: "subscribe", firstMonthAvailable: true },
      }),
    );
    const field = open.match(/<input[^>]*aria-label="Promo code"[^>]*>/)![0];
    expect(isDisabled(field)).toBe(false);
    expect(field).toContain('maxLength="40"');
    expect(isDisabled(open.match(/<button[^>]*>Apply<\/button>/)![0])).toBe(
      true,
    ); // nothing typed yet

    const closed = html(createElement(PlanPicker, props));
    expect(
      isDisabled(closed.match(/<input[^>]*aria-label="Promo code"[^>]*>/)![0]),
    ).toBe(true);
  });

  it("offers the first-month discount only to a first subscription", () => {
    const markup = html(
      createElement(PlanPicker, {
        ...props,
        mode: { kind: "subscribe", firstMonthAvailable: false },
      }),
    );
    expect(markup).toContain(
      "The first-month discount is for a first subscription",
    );
    expect(
      isDisabled(
        markup.match(
          /<button[^>]*>(?:<svg.*?<\/svg>)?Apply first-month discount<\/button>/,
        )![0],
      ),
    ).toBe(true);
  });

  it("a paying workspace switches plans: upgrade above, switch below, its own plan marked", () => {
    const markup = html(
      createElement(PlanPicker, {
        ...props,
        currentPlanKey: "growth",
        mode: {
          kind: "change",
          planKey: "growth",
          interval: "month",
          pendingPlanKey: null,
          renewsOn: "2026-12-01T00:00:00.000Z",
        },
      }),
    );
    expect(markup).toContain("Current plan");
    expect(markup).toContain("Your plan");
    expect(markup).toContain("Switch to Starter");
    expect(markup).toContain("Upgrade to Business");
    expect(markup).toContain("Upgrade to Agency");
    expect(markup).not.toContain("Subscribe to");
    expect(markup).not.toContain("Apply first-month discount");
    // The interval is the subscription's; the other one cannot be picked.
    expect(markup).toMatch(/aria-pressed="false"[^>]*disabled=""[^>]*>Yearly/);
    expect(markup).toContain("Dec 1, 2026");
  });

  it("shows a scheduled downgrade: the paid plan can be kept, the scheduled one says when it starts", () => {
    const markup = html(
      createElement(PlanPicker, {
        ...props,
        currentPlanKey: "business",
        mode: {
          kind: "change",
          planKey: "business",
          interval: "month",
          pendingPlanKey: "growth",
          renewsOn: "2026-12-01T00:00:00.000Z",
        },
      }),
    );
    expect(markup).toContain("Keep this plan");
    expect(markup).toMatch(/<button[^>]*>Starts Dec 1, 2026<\/button>/);
  });

  it.each([
    ["not-manager", "Only a workspace owner or admin can change the plan"],
    ["past-due", "The last payment did not go through"],
    ["ending", "Your subscription is set to end"],
  ] as const)(
    "a blocked workspace (%s) cannot press anything and is told why",
    (reason, text) => {
      const markup = html(
        createElement(PlanPicker, {
          ...props,
          currentPlanKey: "growth",
          mode: { kind: "blocked", reason },
        }),
      );
      expect(markup).toContain(text);
      const buttons =
        markup.match(/<button[^>]*>Choose [A-Za-z]+<\/button>/g) ?? [];
      expect(buttons).toHaveLength(3);
      for (const button of buttons) expect(isDisabled(button)).toBe(true);
    },
  );

  it("compares the plans in a table and lists what the product works with", () => {
    const markup = html(createElement(PlanPicker, props));
    expect(markup).toContain("Compare plans");
    expect(markup).toContain("Post images per month");
    expect(markup).toContain("120 (90 in the first month)");
    expect(markup).toContain("Works with");
    for (const name of [
      "Instagram",
      "Facebook",
      "Meta Ads",
      "Google Analytics",
    ]) {
      expect(markup).toContain(name);
    }
  });

  it("sells no video", () => {
    expect(html(createElement(PlanPicker, props)).toLowerCase()).not.toContain(
      "video",
    );
  });
});

describe("SubscriptionPanel with payments connected", () => {
  const paying: BillingOverview = {
    ...EMPTY,
    subscription: {
      planKey: "growth",
      planLabel: "Growth",
      interval: "MONTH",
      status: "ACTIVE",
      paidThrough: "2026-12-01T00:00:00.000Z",
      trialEndsAt: null,
      trialActive: false,
      cancelAtPeriodEnd: false,
      pending: null,
      exempt: false,
      stripeLinked: true,
      introOffer: false,
      paidAccess: true,
      endedReason: null,
    },
  };
  const render = (
    overview: BillingOverview,
    extra: Partial<Parameters<typeof SubscriptionPanel>[0]> = {},
  ) =>
    html(
      createElement(SubscriptionPanel, {
        overview,
        canManage: true,
        paymentsOpen: true,
        ...extra,
      }),
    );

  it("lets an owner cancel and open the payment method page", () => {
    const markup = render(paying);
    const cancel = markup.match(
      /<button[^>]*>Cancel subscription<\/button>/,
    )![0];
    const payment = markup.match(/<button[^>]*>Payment method<\/button>/)![0];
    expect(isDisabled(cancel)).toBe(false);
    expect(isDisabled(payment)).toBe(false);
  });

  it("offers Resume instead of Cancel once the subscription is set to end", () => {
    const markup = render({
      ...paying,
      subscription: { ...paying.subscription!, cancelAtPeriodEnd: true },
    });
    expect(markup).toContain("Resume subscription");
    expect(markup).not.toContain("Cancel subscription");
    expect(markup).toContain("Ends on");
  });

  it("keeps the buttons off for someone who cannot manage billing, or without a Stripe subscription", () => {
    expect(
      isDisabled(
        render(paying, { canManage: false }).match(
          /<button[^>]*>Cancel subscription<\/button>/,
        )![0],
      ),
    ).toBe(true);
    const notLinked: BillingOverview = {
      ...paying,
      subscription: { ...paying.subscription!, stripeLinked: false },
    };
    expect(
      isDisabled(
        render(notLinked).match(/<button[^>]*>Payment method<\/button>/)![0],
      ),
    ).toBe(true);
  });

  it("says what the date means in each state, and why an ended subscription ended", () => {
    const at = (
      overrides: Partial<NonNullable<BillingOverview["subscription"]>>,
    ) =>
      render({
        ...paying,
        subscription: { ...paying.subscription!, ...overrides },
      });

    expect(at({})).toContain("Renews on");
    expect(at({ status: "PAST_DUE" })).toContain("Paid through");
    // Paid time still running after a cancel: access, not a renewal.
    expect(at({ status: "CANCELED", paidAccess: true })).toContain(
      "Access until",
    );
    // A refunded subscription ended; nothing "renews" and the reason is shown.
    const refunded = at({
      status: "CANCELED",
      paidAccess: false,
      endedReason: "REFUNDED",
    });
    expect(refunded).toContain("Ended on");
    expect(refunded).not.toContain("Renews on");
    expect(refunded).toContain("Refunded");
    expect(
      at({ status: "CANCELED", paidAccess: false, endedReason: "CHARGEBACK" }),
    ).toContain("Payment disputed");
  });

  it("tells an existing subscriber when billing changes are unavailable (payments closed), without touching the subscription", () => {
    const closed = html(
      createElement(SubscriptionPanel, {
        overview: paying,
        canManage: true,
        paymentsOpen: false,
      }),
    );
    expect(closed).toContain("temporarily unavailable");
    expect(closed).toContain("Your subscription is not affected");
    // Open payments, and a workspace that never paid, do not get the note.
    expect(render(paying)).not.toContain("temporarily unavailable");
    expect(
      html(
        createElement(SubscriptionPanel, {
          overview: EMPTY,
          canManage: true,
        }),
      ),
    ).not.toContain("temporarily unavailable");
  });

  it("promises no trial and says plans can be chosen once payments are open", () => {
    const open = html(
      createElement(SubscriptionPanel, {
        overview: EMPTY,
        canManage: true,
        paymentsOpen: true,
      }),
    );
    expect(open).toContain("Choose a plan in Plans");
    expect(open).not.toContain("not on sale yet");
    expect(open).not.toMatch(/trial/i);
    const closed = html(
      createElement(SubscriptionPanel, {
        overview: EMPTY,
        canManage: true,
      }),
    );
    expect(closed).toContain("not on sale yet");
    expect(closed).not.toMatch(/trial/i);
  });

  it("qualifies the read-only warning by the billing mode", () => {
    const until = "2026-12-01T00:00:00.000Z";
    expect(cancelDescription(until, "enforce")).toContain(
      "after that the workspace becomes read-only",
    );
    for (const mode of ["off", "shadow"] as const) {
      const text = cancelDescription(until, mode);
      expect(text).toContain("after that your plan ends");
      expect(text).not.toContain("read-only");
    }
    expect(cancelDescription(null, "off")).toContain(
      "the end of the paid period",
    );
  });

  it("an overdue subscription's cancel text never promises access 'until' a date that has passed or says nothing more is charged", () => {
    const passed = "2026-10-07T00:00:00.000Z";
    for (const mode of ["off", "enforce"] as const) {
      const text = cancelDescription(passed, mode, "PAST_DUE");
      expect(text).toContain("past due");
      expect(text).toContain("does not cancel the unpaid invoice");
      expect(text).not.toContain("Oct 7");
      expect(text).not.toContain("Nothing more is charged");
      expect(text).not.toContain("until");
    }
    // the healthy state keeps its text
    expect(cancelDescription(passed, "enforce", "ACTIVE")).toContain(
      "until Oct 7, 2026",
    );
  });

  it("shows the amount due for an unpaid invoice, hides drafts' noise and says when invoices could not load", () => {
    const row = {
      id: "in_open",
      number: "ABC-0002",
      createdAt: "2026-11-01T00:00:00.000Z",
      amountPaid: 0,
      amountDue: 7_900,
      currency: "usd",
      status: "open",
      hostedInvoiceUrl: null,
      invoicePdf: null,
    };
    const markup = render(paying, { invoices: [row] });
    expect(markup).toContain("$79");
    expect(markup).toContain("Unpaid");
    expect(markup).not.toContain("$0");

    const failed = render(paying, { invoices: [], invoicesFailed: true });
    expect(failed).toContain("could not load your invoices");
    expect(failed).not.toContain("Nothing to show yet");
  });

  it("lists invoices with links", () => {
    const markup = render(paying, {
      invoices: [
        {
          id: "in_1",
          number: "ABC-0001",
          createdAt: "2026-11-01T00:00:00.000Z",
          amountPaid: 14_900,
          amountDue: 0,
          currency: "usd",
          status: "paid",
          hostedInvoiceUrl: "https://invoice.stripe.com/i/x",
          invoicePdf: "https://pay.stripe.com/invoice/x/pdf",
        },
      ],
    });
    expect(markup).toContain("ABC-0001");
    expect(markup).toContain("$149");
    expect(markup).toContain("Nov 1, 2026");
    expect(markup).toContain('href="https://invoice.stripe.com/i/x"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("Nothing to show yet");
  });
});

describe("SubscriptionPanel during and after the free trial", () => {
  const trial = (trialActive: boolean): BillingOverview => ({
    ...EMPTY,
    subscription: {
      planKey: null,
      planLabel: null,
      interval: "MONTH",
      status: "TRIALING",
      paidThrough: null,
      trialEndsAt: "2026-11-22T12:00:00.000Z",
      trialActive,
      cancelAtPeriodEnd: false,
      pending: null,
      exempt: false,
      stripeLinked: false,
      introOffer: false,
      paidAccess: false,
      endedReason: null,
    },
  });
  const render = (overview: BillingOverview) =>
    html(
      createElement(SubscriptionPanel, {
        overview,
        canManage: true,
        paymentsOpen: true,
      }),
    );

  it("says what the trial includes and when it ends, without printing the internal AI budget", () => {
    const markup = render(trial(true));

    expect(markup).toContain("Free trial");
    expect(markup).toContain(">Trial<");
    expect(markup).toContain("Trial ends");
    expect(markup).toContain(
      "7-day free trial: 5 post images and a starter amount of AI assistant usage",
    );
    expect(markup).not.toContain("No plan chosen");
    expect(markup).not.toContain("$");
  });

  it("says plainly when the trial is over and what to do", () => {
    const markup = render(trial(false));

    expect(markup).toContain("Trial ended");
    expect(markup).toContain(
      "Your free trial has ended. Choose a plan in Plans",
    );
    expect(markup).not.toContain("Trial ends");
    expect(markup).not.toContain("You are on the");
  });

  it("a full-access workspace never gets the trial text", () => {
    const overview = trial(true);
    overview.subscription!.exempt = true;

    expect(render(overview)).not.toContain("free trial");
  });
});

describe("UsagePanel", () => {
  const withAllowances: BillingOverview = {
    ...EMPTY,
    mode: "enforce",
    allowances: [
      {
        unit: "IMAGE",
        granted: 50,
        used: 42,
        reserved: 0,
        available: 8,
        extraAvailable: 0,
        endsAt: "2026-11-01T00:00:00.000Z",
        window: "renews",
      },
      {
        unit: "AI_MICROS",
        granted: 8_000_000,
        used: 8_000_000,
        reserved: 0,
        available: 0,
        extraAvailable: 0,
        endsAt: "2026-11-01T00:00:00.000Z",
        window: "renews",
      },
    ],
    measured: {
      since: "2026-10-01T00:00:00.000Z",
      images: 42,
      aiRequests: 310,
      byModule: [
        { module: "SOCIAL", images: 40, aiRequests: 120 },
        { module: "CHAT", images: 2, aiRequests: 190 },
      ],
      daily: [
        { day: "2026-10-08", images: 3, aiRequests: 25 },
        { day: "2026-10-07", images: 0, aiRequests: 4 },
      ],
    },
  };

  it("shows what is left of each allowance, with a bar and the renewal date", () => {
    const markup = html(
      createElement(UsagePanel, { overview: withAllowances }),
    );
    expect(markup).toContain("Post images");
    expect(markup).toContain("left of 50");
    expect(markup).toContain("AI assistant usage");
    expect(markup).toContain("Renews");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="84"'); // 42 of 50 spent
    expect(markup).toContain('aria-valuenow="100"');
  });

  it("warns before an allowance runs out and again when it is used up", () => {
    const markup = html(
      createElement(UsagePanel, { overview: withAllowances }),
    );
    expect(markup).toContain("You are running low on post images");
    expect(markup).toContain("You have used all of your AI assistant usage");
    expect(markup).toContain("continues by itself");
    expect(markup).not.toContain("Usage is measured, not limited yet");
  });

  describe("the end date of the window says what is really going to happen", () => {
    const withWindow = (
      window:
        | "renews"
        | "ends"
        | "overdue"
        | "renewing"
        | "ended"
        | "trial-ended",
      patch: Partial<(typeof withAllowances)["allowances"][number]> = {},
    ): BillingOverview => ({
      ...withAllowances,
      allowances: withAllowances.allowances.map((row) => ({
        ...row,
        ...patch,
        window,
      })),
    });
    const render = (overview: BillingOverview) =>
      html(createElement(UsagePanel, { overview }));

    it("a plan that is ending never says Renews or promises that the work continues by itself", () => {
      const markup = render(withWindow("ends"));

      expect(markup).toContain("Available until Nov 1, 2026");
      expect(markup).not.toContain("Renews");
      expect(markup).not.toContain("continues by itself");
      expect(markup).toContain("does not renew because your plan is ending");
      expect(markup).toContain("so it does not renew");
    });

    it("an overdue renewal says the allowance is paused instead of 'used all ... until it renews'", () => {
      // The closed window has nothing of its own left (the overview zeroes it): only extras.
      const markup = render(
        withWindow("overdue", {
          granted: 0,
          used: 0,
          available: 0,
          extraAvailable: 0,
        }),
      );

      expect(markup).toContain("Paused: the renewal payment is overdue");
      expect(markup).not.toContain("Renews");
      expect(markup).not.toContain("You have used all");
      expect(markup).not.toContain("running low");
      expect(markup).not.toContain("left of 0");
      expect(markup).toContain(">0%<");
    });

    it("an ended plan says so, and still shows the extra usage that was bought and never expires", () => {
      const markup = render(
        withWindow("ended", {
          granted: 15,
          used: 0,
          available: 15,
          extraAvailable: 15,
        }),
      );

      expect(markup).toContain("Your plan has ended");
      expect(markup).not.toContain("Renews");
      expect(markup).toContain("left of 15");
      expect(markup).not.toContain("You have used all");
    });

    it("a free trial that is over says so and points to the plans, instead of 'Your plan has ended'", () => {
      const markup = render(
        withWindow("trial-ended", { granted: 0, used: 0, available: 0 }),
      );

      expect(markup).toContain("Your free trial has ended");
      expect(markup).toContain("Choose a plan in Plans");
      expect(markup).not.toContain("Your plan has ended");
      expect(markup).not.toContain("Renews");
    });

    it("a window waiting for its renewal to be recorded says it is renewing, not that it renews on a past date", () => {
      const markup = render(
        withWindow("renewing", { granted: 0, used: 0, available: 0 }),
      );

      expect(markup).toContain("Renewing");
      expect(markup).not.toContain("Renews Nov");
    });
  });

  it("shows neither tokens nor dollars of cost", () => {
    const markup = html(
      createElement(UsagePanel, { overview: withAllowances }),
    );
    expect(markup.toLowerCase()).not.toContain("token");
  });

  it("breaks the month down by module and lists the last days", () => {
    const markup = html(
      createElement(UsagePanel, { overview: withAllowances }),
    );
    expect(markup).toContain("Social Media");
    expect(markup).toContain("Assistant chat");
    expect(markup).toContain("40 pictures");
    expect(markup).toContain("Last 14 days");
    expect(markup).toContain("Oct 8");
  });

  it("without a plan it says usage is measured, not limited, and still shows the numbers", () => {
    const markup = html(
      createElement(UsagePanel, {
        overview: {
          ...EMPTY,
          measured: { ...EMPTY.measured, images: 7, aiRequests: 31 },
        },
      }),
    );
    expect(markup).toContain("Usage is measured, not limited yet");
    expect(markup).toContain(">7<");
    expect(markup).toContain(">31<");
    expect(markup).toContain("Nothing used yet this month");
    expect(markup).toContain("No activity in the last 14 days");
  });

  it("offers the extra packs that are sold, at their prices, not buyable yet", () => {
    const markup = html(createElement(UsagePanel, { overview: EMPTY }));
    expect(markup).toContain("20 post images");
    expect(markup).toContain("$12");
    expect(markup).toContain("$2.50 of AI assistant usage");
    expect(markup).toContain("$10");
    expect(markup).toContain("Buying opens together with plans");
    const buy = markup.match(/<button[^>]*>Buy<\/button>/g) ?? [];
    expect(buy).toHaveLength(2);
    for (const button of buy) expect(isDisabled(button)).toBe(true);
  });

  it("with a plan and payments connected the packs can be bought", () => {
    const markup = html(
      createElement(UsagePanel, { overview: EMPTY, packsOpen: true }),
    );
    const buy = markup.match(/<button[^>]*>Buy<\/button>/g) ?? [];
    expect(buy).toHaveLength(2);
    for (const button of buy) expect(isDisabled(button)).toBe(false);
    expect(markup).toContain("Payment is handled by Stripe");
    expect(markup).not.toContain("Buying opens together with plans");
  });

  it("says why buying is off when payments are connected but the workspace cannot buy", () => {
    const markup = html(
      createElement(UsagePanel, {
        overview: EMPTY,
        packsOpen: false,
        packsNote: "Extra usage can be added while you have a plan.",
      }),
    );
    expect(markup).toContain("Extra usage can be added while you have a plan.");
  });
});

describe("SubscriptionPanel", () => {
  it("with no plan: says so, sends the person to the plans, offers nothing to cancel", () => {
    const markup = html(
      createElement(SubscriptionPanel, { overview: EMPTY, canManage: true }),
    );
    expect(markup).toContain("No plan yet");
    expect(markup).toContain('href="/billing?tab=plans"');
    expect(markup).toContain("See plans");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Cancel subscription</);
    expect(markup).toContain("Invoices and payments");
    expect(markup).toContain("Nothing to show yet");
  });

  const active: BillingOverview = {
    ...EMPTY,
    subscription: {
      planKey: "growth",
      planLabel: "Growth",
      interval: "MONTH",
      status: "ACTIVE",
      paidThrough: "2026-11-15T00:00:00.000Z",
      trialEndsAt: null,
      trialActive: false,
      cancelAtPeriodEnd: false,
      pending: null,
      exempt: false,
      stripeLinked: true,
      introOffer: false,
      paidAccess: true,
      endedReason: null,
    },
  };

  it("shows the plan, its price, its status and the renewal date", () => {
    const markup = html(
      createElement(SubscriptionPanel, { overview: active, canManage: true }),
    );
    expect(markup).toContain("Growth");
    expect(markup).toContain("$149/month");
    expect(markup).toContain("Active");
    expect(markup).toContain("Renews on");
    expect(markup).toContain("Nov 15, 2026");
    expect(markup).toContain("Change plan");
  });

  it("says when the plan ends instead of renewing, and what is scheduled", () => {
    const markup = html(
      createElement(SubscriptionPanel, {
        canManage: true,
        overview: {
          ...active,
          subscription: {
            ...active.subscription!,
            cancelAtPeriodEnd: true,
            pending: {
              planKey: "starter",
              interval: "MONTH",
              effectiveAt: "2026-11-15T00:00:00.000Z",
            },
          },
        },
      }),
    );
    expect(markup).toContain("Ends on");
    expect(markup).not.toContain("Renews on");
    expect(markup).toContain("Scheduled change");
    expect(markup).toContain("Starter on Nov 15, 2026");
  });

  it("shows the yearly invoice for a yearly plan", () => {
    const markup = html(
      createElement(SubscriptionPanel, {
        canManage: true,
        overview: {
          ...active,
          subscription: { ...active.subscription!, interval: "YEAR" },
        },
      }),
    );
    expect(markup).toContain("$1,430.40 billed yearly");
  });

  it("an internal account reads as full access", () => {
    const markup = html(
      createElement(SubscriptionPanel, {
        canManage: true,
        overview: {
          ...active,
          subscription: { ...active.subscription!, exempt: true },
        },
      }),
    );
    expect(markup).toContain("Full access");
  });

  it("tells a member who cannot change the plan who can", () => {
    const markup = html(
      createElement(SubscriptionPanel, { overview: EMPTY, canManage: false }),
    );
    expect(markup).toContain(
      "Only a workspace owner or admin can change the plan",
    );
  });
});

describe("TasksPanel", () => {
  it("says so when there is nothing in any list", () => {
    const markup = html(createElement(TasksPanel, { tasks: EMPTY.tasks }));
    expect(markup).toContain("Nothing is waiting for you");
    expect(markup).toContain("Nothing is paused");
    expect(markup).toContain("Nothing is running right now");
  });

  it("lists paused work with the reason and how it continues", () => {
    const at = new Date().toISOString();
    const markup = html(
      createElement(TasksPanel, {
        tasks: {
          active: [
            {
              id: "j1",
              title: "Research competitors",
              capability: "COMPETITOR_RESEARCH",
              projectId: "p1",
              projectName: "Acme",
              at,
            },
          ],
          paused: [
            {
              id: "j2",
              title: "Weekend post",
              capability: "CREATE_SOCIAL_CREATIVE",
              projectId: "p1",
              projectName: "Acme",
              at,
              pausedFor: "allowance",
            },
            {
              id: "j3",
              title: "Story",
              capability: "CREATE_SOCIAL_CREATIVE",
              projectId: "p2",
              projectName: "Globex",
              at,
              pausedFor: "no-plan",
            },
          ],
          awaitingApproval: [
            {
              id: "a1",
              title: "Publish to Instagram",
              projectId: "p1",
              projectName: "Acme",
              at,
            },
          ],
        },
      }),
    );
    expect(markup).toContain("Weekend post");
    expect(markup).toContain("Allowance used up");
    expect(markup).toContain("Needs a plan");
    expect(markup).toContain("continue by themselves");
    expect(markup).toContain("Research competitors");
    expect(markup).toContain("Publish to Instagram");
    expect(markup).toContain('href="/projects/p1"');
    expect(markup).toContain('href="/projects/p2"');
    // Nothing is held back here: no word about the automatic share.
    expect(markup).not.toContain("Automatic work");
  });

  // Automatic work that reached its own share: the allowance is not used up, and
  // the screen says so in a percentage (never a token or a dollar figure).
  it("tells work held back for the automatic share from work that ran out of allowance", () => {
    const at = new Date().toISOString();
    const markup = html(
      createElement(TasksPanel, {
        tasks: {
          active: [],
          paused: [
            {
              id: "j1",
              title: "Weekly auto post",
              capability: "CREATE_SOCIAL_CREATIVE",
              projectId: "p1",
              projectName: "Acme",
              at,
              pausedFor: "held-back",
            },
          ],
          awaitingApproval: [],
          backgroundSharePct: 45,
        },
      }),
    );
    expect(markup).toContain("Weekly auto post");
    expect(markup).toContain("Automatic work limit");
    expect(markup).not.toContain("Allowance used up");
    expect(markup).toContain("limited to 45% of your plan");
    expect(markup).toContain("your own requests are not affected");
    expect(markup).toContain("continue by themselves");
    expect(markup).not.toMatch(/\$|token/i);
  });
});
