import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingOverview } from "@/server/billing/overview";

// Gaps found by the mutation review of Faz 4 (the /billing wiring): what the page does
// NOT do (Stripe reads on the wrong tab or a crafted address, buying for a non-manager)
// and what it shows while payments are closed. Same mocks as page.test.ts.

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

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
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
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-shell": "" }, children),
}));

import BillingPage from "./page";

const PAYING: BillingOverview = {
  mode: "off",
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
    endedReason: null,
  },
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
const DEPS = { mode: "test", gateway: {}, appUrl: "https://app.test" };

async function render(
  params: Record<string, string | string[] | undefined> = {},
) {
  const element = (await BillingPage({
    searchParams: Promise.resolve(params),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}
const isDisabled = (button: string) => / disabled=""/.test(button);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "u1" });
  mocks.membership.mockResolvedValue({ workspaceId: "w1" });
  mocks.manager.mockResolvedValue(true);
  mocks.overview.mockResolvedValue(PAYING);
  mocks.deps.mockReturnValue(DEPS);
  mocks.reconcile.mockResolvedValue("active");
  mocks.invoices.mockResolvedValue({ rows: [], failed: false });
});

describe("/billing while payments are closed", () => {
  it("shows the plans as not on sale and offers no way to subscribe", async () => {
    mocks.deps.mockReturnValue(null);
    mocks.overview.mockResolvedValue({ ...PAYING, subscription: null });

    const markup = await render();

    expect(markup).toContain("Plans are not on sale yet");
    expect(markup).not.toContain("Subscribe to");
    expect(markup).not.toContain("Upgrade to");
  });
});

describe("/billing never reads Stripe without a reason", () => {
  it("lists invoices only on the subscription tab", async () => {
    await render({ tab: "usage" });
    await render({ tab: "plans" });
    await render({ tab: "tasks" });
    expect(mocks.invoices).not.toHaveBeenCalled();

    await render({ tab: "subscription" });
    expect(mocks.invoices).toHaveBeenCalledTimes(1);
  });

  it("a session_id in the address alone does not trigger a payment check; it needs the success marker", async () => {
    await render({ tab: "subscription", session_id: "cs_test_abc12345" });
    await render({
      tab: "subscription",
      checkout: "cancelled",
      session_id: "cs_test_abc12345",
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();

    await render({
      tab: "usage",
      purchase: "success",
      session_id: "cs_test_abc12345",
    });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });
});

describe("/billing extra packs", () => {
  it("a member who cannot manage billing sees why the Buy buttons are off", async () => {
    mocks.manager.mockResolvedValue(false);

    const markup = await render({ tab: "usage" });

    expect(markup).toContain(
      "Only a workspace owner or admin can buy extra usage.",
    );
    const buy = markup.match(/<button[^>]*>Buy<\/button>/g) ?? [];
    expect(buy).toHaveLength(2);
    for (const button of buy) expect(isDisabled(button)).toBe(true);
  });

  it("a manager of a paying workspace can press them", async () => {
    const markup = await render({ tab: "usage" });
    const buy = markup.match(/<button[^>]*>Buy<\/button>/g) ?? [];
    expect(buy).toHaveLength(2);
    for (const button of buy) expect(isDisabled(button)).toBe(false);
  });
});
