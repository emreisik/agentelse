import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingOverview } from "@/server/billing/overview";

// The /billing page wiring: hidden unless the screens are switched on, scoped to the
// caller's own workspace, and the open tab comes from the address.

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  requireUser: vi.fn(),
  membership: vi.fn(),
  manager: vi.fn(),
  overview: vi.fn(),
  deps: vi.fn(),
  reconcile: vi.fn(),
  invoices: vi.fn(),
}));

class NotFoundSignal extends Error {}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/server/billing/payments/deps", () => ({
  getPaymentDeps: mocks.deps,
}));
vi.mock("@/server/billing/payments/service", () => ({
  reconcileCheckoutReturn: mocks.reconcile,
  listWorkspaceInvoices: mocks.invoices,
}));
vi.mock("@/server/actions/billing-actions", () => ({
  startCheckoutAction: vi.fn(),
  startPackCheckoutAction: vi.fn(),
  openPortalAction: vi.fn(),
  cancelSubscriptionAction: vi.fn(),
  resumeSubscriptionAction: vi.fn(),
  changePlanAction: vi.fn(),
}));
vi.mock("@/server/billing/ui-flag", () => ({
  isBillingUiEnabled: mocks.enabled,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireWorkspaceMembership: mocks.membership,
  isWorkspaceManager: mocks.manager,
}));
vi.mock("@/server/billing/overview", () => ({
  getBillingOverview: mocks.overview,
}));
// The shell around every page needs a session and a database of its own.
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-shell": "" }, children),
}));

import BillingPage from "./page";

const OVERVIEW: BillingOverview = {
  mode: "off",
  subscription: null,
  allowances: [],
  measured: {
    since: "2026-10-01T00:00:00.000Z",
    images: 5,
    aiRequests: 9,
    byModule: [],
    daily: [],
  },
  tasks: { active: [], paused: [], awaitingApproval: [] },
};

async function render(
  params: Record<string, string | string[] | undefined> = {},
) {
  const element = (await BillingPage({
    searchParams: Promise.resolve(params),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.membership.mockResolvedValue({ workspaceId: "w1" });
  mocks.manager.mockResolvedValue(true);
  mocks.overview.mockResolvedValue(OVERVIEW);
  // Payments closed unless a test opens them.
  mocks.deps.mockReturnValue(null);
  mocks.reconcile.mockResolvedValue("active");
  mocks.invoices.mockResolvedValue([]);
});

describe("/billing", () => {
  it("is not found while the screens are switched off, and reads nothing", async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("opens on the plans, in the app shell, with the four tabs", async () => {
    const markup = await render();
    expect(markup).toContain("data-shell");
    expect(markup).toContain("Plan &amp; usage");
    expect(markup).toContain("Compare plans");
    for (const label of ["Plans", "My subscription", "Usage", "Tasks"]) {
      expect(markup).toContain(`>${label}<`);
    }
  });

  it("reads the caller's own workspace and nothing else", async () => {
    mocks.membership.mockResolvedValue({ workspaceId: "w-mine" });
    await render({ tab: "usage" });
    expect(mocks.membership).toHaveBeenCalledWith("u1");
    expect(mocks.overview).toHaveBeenCalledTimes(1);
    expect(mocks.overview.mock.calls[0]![0]).toBe("w-mine");
    expect(mocks.manager).toHaveBeenCalledWith("u1", "w-mine");
  });

  it("shows the tab the address names", async () => {
    expect(await render({ tab: "usage" })).toContain("This month so far");
    expect(await render({ tab: "tasks" })).toContain(
      "Waiting for your approval",
    );
    expect(await render({ tab: "subscription" })).toContain(
      "Invoices and payments",
    );
  });

  it("an unknown tab falls back to the plans", async () => {
    expect(await render({ tab: "nonsense" })).toContain("Compare plans");
  });

  it("tells a member who cannot manage the plan who can", async () => {
    mocks.manager.mockResolvedValue(false);
    expect(await render({ tab: "subscription" })).toContain(
      "Only a workspace owner or admin can change the plan",
    );
    mocks.manager.mockResolvedValue(true);
    expect(await render({ tab: "subscription" })).not.toContain(
      "Only a workspace owner or admin can change the plan",
    );
  });

  describe("with payments connected", () => {
    const DEPS = { mode: "test", gateway: {}, appUrl: "https://app.test" };
    const PAYING: BillingOverview = {
      ...OVERVIEW,
      subscription: {
        planKey: "growth",
        planLabel: "Growth",
        interval: "MONTH",
        status: "ACTIVE",
        paidThrough: "2999-12-01T00:00:00.000Z",
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        pending: null,
        exempt: false,
        stripeLinked: true,
        introOffer: false,
        paidAccess: true,
      },
    };

    beforeEach(() => {
      mocks.deps.mockReturnValue(DEPS);
    });

    it("badges test mode so nobody mistakes the charges for real ones", async () => {
      expect(await render()).toContain("Test mode");
      mocks.deps.mockReturnValue({ ...DEPS, mode: "live" });
      expect(await render()).not.toContain("Test mode");
    });

    it("offers Subscribe to a workspace that has not paid", async () => {
      const markup = await render();
      expect(markup).toContain("Subscribe to Starter");
      expect(markup).not.toContain("Plans are not on sale yet");
    });

    it("offers plan switching to a paying workspace", async () => {
      mocks.overview.mockResolvedValue(PAYING);
      const markup = await render();
      expect(markup).toContain("Upgrade to Business");
      expect(markup).toContain("Switch to Starter");
    });

    it("on return from Stripe it brings the plan up to date for the CALLER's workspace, not one named in the address", async () => {
      mocks.membership.mockResolvedValue({ workspaceId: "w-mine" });
      const markup = await render({
        tab: "subscription",
        checkout: "success",
        session_id: "cs_test_abc12345",
        workspaceId: "w-someone-else",
      });
      expect(mocks.reconcile).toHaveBeenCalledTimes(1);
      expect(mocks.reconcile).toHaveBeenCalledWith(
        { workspaceId: "w-mine", sessionId: "cs_test_abc12345" },
        DEPS,
      );
      expect(markup).toContain("Payment received. Your plan is active.");
    });

    it("says the payment is still being confirmed when it is not through yet", async () => {
      mocks.reconcile.mockResolvedValue("pending");
      const markup = await render({
        checkout: "success",
        session_id: "cs_test_abc12345",
      });
      expect(markup).toContain("still being confirmed");
    });

    it("does not call Stripe on an ordinary visit, or without a session, or when payments are closed", async () => {
      await render({ tab: "subscription" });
      await render({ checkout: "success" });
      mocks.deps.mockReturnValue(null);
      await render({ checkout: "success", session_id: "cs_test_abc12345" });
      expect(mocks.reconcile).not.toHaveBeenCalled();
    });

    it("shows a cancelled checkout without touching Stripe", async () => {
      const markup = await render({ checkout: "cancelled" });
      expect(markup).toContain("Checkout was cancelled. Nothing was charged.");
      expect(mocks.reconcile).not.toHaveBeenCalled();
    });

    it("lists invoices only to a manager of a workspace that has paid", async () => {
      mocks.overview.mockResolvedValue(PAYING);
      mocks.invoices.mockResolvedValue([
        {
          id: "in_1",
          number: "N-1",
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
          amountPaid: 14_900,
          currency: "usd",
          status: "paid",
          hostedInvoiceUrl: null,
          invoicePdf: null,
        },
      ]);

      expect(await render({ tab: "subscription" })).toContain("N-1");
      expect(mocks.invoices).toHaveBeenCalledWith({ workspaceId: "w1" }, DEPS);

      mocks.invoices.mockClear();
      mocks.manager.mockResolvedValue(false);
      expect(await render({ tab: "subscription" })).not.toContain("N-1");
      expect(mocks.invoices).not.toHaveBeenCalled();

      mocks.manager.mockResolvedValue(true);
      mocks.overview.mockResolvedValue(OVERVIEW);
      await render({ tab: "subscription" });
      expect(mocks.invoices).not.toHaveBeenCalled();
    });

    it("lets a paying manager buy extra packs, but not a workspace without a plan", async () => {
      mocks.overview.mockResolvedValue(PAYING);
      const paying = await render({ tab: "usage" });
      expect(paying).toContain("Payment is handled by Stripe");

      mocks.overview.mockResolvedValue(OVERVIEW);
      const free = await render({ tab: "usage" });
      expect(free).toContain("Extra usage can be added while you have a plan.");
    });
  });
});
