import { beforeEach, describe, expect, it, vi } from "vitest";

// docs/billing-payments.md: "20 calls per 10 minutes per user". billing-actions.test.ts
// proves the limiter is consulted per user, not what it is told, so a limit of 2000 or
// a counter shared by every action would pass it. Same mocks, narrower question.

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  requireUser: vi.fn(),
  membership: vi.fn(),
  manager: vi.fn(),
  deps: vi.fn(),
  limited: vi.fn(),
  revalidate: vi.fn(),
  workspace: vi.fn(),
  startSubscriptionCheckout: vi.fn(),
  startPackCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
  cancelAtPeriodEnd: vi.fn(),
  resumeSubscription: vi.fn(),
  changePlan: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/prisma", () => ({
  prisma: { workspace: { findUnique: mocks.workspace } },
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.limited }));
vi.mock("@/server/billing/ui-flag", () => ({
  isBillingUiEnabled: mocks.enabled,
}));
vi.mock("@/server/billing/payments/deps", () => ({
  getPaymentDeps: mocks.deps,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: mocks.requireUser,
  requireWorkspaceMembership: mocks.membership,
  isWorkspaceManager: mocks.manager,
}));
vi.mock("@/server/billing/payments/service", async (importActual) => ({
  ...(await importActual<typeof import("@/server/billing/payments/service")>()),
  startSubscriptionCheckout: mocks.startSubscriptionCheckout,
  startPackCheckout: mocks.startPackCheckout,
  openBillingPortal: mocks.openBillingPortal,
  cancelAtPeriodEnd: mocks.cancelAtPeriodEnd,
  resumeSubscription: mocks.resumeSubscription,
  changePlan: mocks.changePlan,
}));

const actions = await import("./billing-actions");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "u1", email: "a@b.co" });
  mocks.membership.mockResolvedValue({ workspaceId: "w-mine" });
  mocks.manager.mockResolvedValue(true);
  mocks.deps.mockReturnValue({
    gateway: {},
    mode: "test",
    appUrl: "https://app.test",
  });
  mocks.limited.mockReturnValue(false);
  mocks.workspace.mockResolvedValue({ name: "Acme" });
  for (const fn of [
    mocks.startSubscriptionCheckout,
    mocks.startPackCheckout,
    mocks.openBillingPortal,
    mocks.cancelAtPeriodEnd,
    mocks.resumeSubscription,
    mocks.changePlan,
  ]) {
    fn.mockResolvedValue({ ok: true, url: "https://stripe.test/x" });
  }
});

describe("the per-user limit on billing actions", () => {
  it("is 20 calls per 10 minutes, counted separately for each action", async () => {
    await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: false,
    });
    await actions.startPackCheckoutAction({ packKey: "images20" });
    await actions.openPortalAction();
    await actions.cancelSubscriptionAction();
    await actions.resumeSubscriptionAction();
    await actions.changePlanAction({ planKey: "business" });

    expect(mocks.limited.mock.calls).toEqual([
      ["billing:checkout:u1", 20, 600_000],
      ["billing:pack:u1", 20, 600_000],
      ["billing:portal:u1", 20, 600_000],
      ["billing:cancel:u1", 20, 600_000],
      ["billing:resume:u1", 20, 600_000],
      ["billing:plan:u1", 20, 600_000],
    ]);
  });

  it("is checked after the role check: a non-manager never uses up the counter", async () => {
    mocks.manager.mockResolvedValue(false);
    await actions.cancelSubscriptionAction();
    expect(mocks.limited).not.toHaveBeenCalled();
  });
});
