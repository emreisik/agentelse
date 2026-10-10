import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about the billing server actions: who may call them (a signed-in
// owner/admin of the caller's OWN workspace, with payments connected), that nothing the
// client sends can point them at another workspace, and that a successful change
// refreshes the page. The money logic itself is service.integration.test.ts.

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
  checkPromoCode: vi.fn(),
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
  checkPromoCode: mocks.checkPromoCode,
  startPackCheckout: mocks.startPackCheckout,
  openBillingPortal: mocks.openBillingPortal,
  cancelAtPeriodEnd: mocks.cancelAtPeriodEnd,
  resumeSubscription: mocks.resumeSubscription,
  changePlan: mocks.changePlan,
}));

const actions = await import("./billing-actions");

const DEPS = { gateway: {}, mode: "test", appUrl: "https://app.test" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.requireUser.mockResolvedValue({ userId: "u1", email: "a@b.co" });
  mocks.membership.mockResolvedValue({ workspaceId: "w-mine" });
  mocks.manager.mockResolvedValue(true);
  mocks.deps.mockReturnValue(DEPS);
  mocks.limited.mockReturnValue(false);
  mocks.workspace.mockResolvedValue({ name: "Acme" });
  for (const fn of [
    mocks.startSubscriptionCheckout,
    mocks.startPackCheckout,
    mocks.openBillingPortal,
  ]) {
    fn.mockResolvedValue({ ok: true, url: "https://stripe.test/x" });
  }
  mocks.checkPromoCode.mockResolvedValue({
    ok: true,
    code: "SPRING20",
    description: "20% off your first payment",
  });
  for (const fn of [mocks.cancelAtPeriodEnd, mocks.resumeSubscription]) {
    fn.mockResolvedValue({ ok: true });
  }
  mocks.changePlan.mockResolvedValue({ ok: true, kind: "upgraded" });
});

const everyAction: Array<[string, () => Promise<unknown>]> = [
  [
    "startCheckoutAction",
    () =>
      actions.startCheckoutAction({
        planKey: "growth",
        interval: "MONTH",
        applyFirstMonth: false,
      }),
  ],
  [
    "checkPromoCodeAction",
    () => actions.checkPromoCodeAction({ code: "SPRING20" }),
  ],
  [
    "startPackCheckoutAction",
    () => actions.startPackCheckoutAction({ packKey: "images20" }),
  ],
  ["openPortalAction", () => actions.openPortalAction()],
  ["cancelSubscriptionAction", () => actions.cancelSubscriptionAction()],
  ["resumeSubscriptionAction", () => actions.resumeSubscriptionAction()],
  ["changePlanAction", () => actions.changePlanAction({ planKey: "business" })],
];

describe.each(everyAction)("%s guard", (_name, call) => {
  it("does nothing while the billing screens are switched off", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await call()).toMatchObject({ ok: false, error: "PAYMENTS_CLOSED" });
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });

  it("is for owners and admins only", async () => {
    mocks.manager.mockResolvedValue(false);
    expect(await call()).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(mocks.manager).toHaveBeenCalledWith("u1", "w-mine");
  });

  it("does nothing when payments are not connected", async () => {
    mocks.deps.mockReturnValue(null);
    expect(await call()).toMatchObject({ ok: false, error: "PAYMENTS_CLOSED" });
  });

  it("is rate limited per user", async () => {
    mocks.limited.mockReturnValue(true);
    expect(await call()).toMatchObject({ ok: false, error: "RATE_LIMITED" });
    expect(mocks.limited.mock.calls[0]![0]).toContain("u1");
  });

  it("needs a signed-in user", async () => {
    mocks.requireUser.mockRejectedValue(new Error("Authentication required"));
    await expect(call()).rejects.toThrow("Authentication required");
  });
});

describe("what the actions pass on", () => {
  it("checkout: the caller's own workspace, the workspace name and the chosen plan", async () => {
    const result = await actions.startCheckoutAction({
      planKey: "growth",
      interval: "YEAR",
      applyFirstMonth: true,
    });

    expect(result).toEqual({ ok: true, url: "https://stripe.test/x" });
    expect(mocks.startSubscriptionCheckout).toHaveBeenCalledWith(
      {
        workspaceId: "w-mine",
        email: "a@b.co",
        name: "Acme",
        planKey: "growth",
        interval: "YEAR",
        applyFirstMonth: true,
      },
      DEPS,
    );
  });

  it("the discount flag must be exactly true", async () => {
    await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: "yes" as unknown as boolean,
    });
    expect(mocks.startSubscriptionCheckout.mock.calls[0]![0]).toMatchObject({
      applyFirstMonth: false,
    });
  });

  it("a client cannot name another workspace: the argument is simply not read", async () => {
    await actions.changePlanAction({
      planKey: "business",
      workspaceId: "w-victim",
    } as unknown as { planKey: string });
    expect(mocks.changePlan).toHaveBeenCalledWith(
      { workspaceId: "w-mine", planKey: "business" },
      DEPS,
    );
  });

  it("pack and portal use the caller's workspace", async () => {
    await actions.startPackCheckoutAction({ packKey: "ai250" });
    expect(mocks.startPackCheckout.mock.calls[0]![0]).toMatchObject({
      workspaceId: "w-mine",
      packKey: "ai250",
    });
    await actions.openPortalAction();
    expect(mocks.openBillingPortal).toHaveBeenCalledWith(
      { workspaceId: "w-mine" },
      DEPS,
    );
  });

  it("refreshes the billing page after every attempt that reached the service, but not when the guard refused", async () => {
    await actions.cancelSubscriptionAction();
    await actions.resumeSubscriptionAction();
    await actions.changePlanAction({ planKey: "business" });
    expect(mocks.revalidate).toHaveBeenCalledTimes(3);
    expect(mocks.revalidate).toHaveBeenCalledWith("/billing");

    mocks.revalidate.mockClear();
    mocks.cancelAtPeriodEnd.mockResolvedValue({
      ok: false,
      error: "NO_SUBSCRIPTION",
      message: "x",
    });
    mocks.changePlan.mockResolvedValue({
      ok: false,
      error: "CARD_DECLINED",
      message: "x",
    });
    await actions.cancelSubscriptionAction();
    await actions.changePlanAction({ planKey: "business" });
    // A failed attempt may still have re-read Stripe (unknown outcome, a restored
    // scheduled downgrade): the screen must not keep showing the old state.
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);

    mocks.revalidate.mockClear();
    mocks.manager.mockResolvedValue(false);
    await actions.cancelSubscriptionAction();
    await actions.resumeSubscriptionAction();
    await actions.changePlanAction({ planKey: "business" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("hands the service's safe message straight back", async () => {
    mocks.changePlan.mockResolvedValue({
      ok: false,
      error: "CARD_DECLINED",
      message: "The card was declined.",
    });
    expect(await actions.changePlanAction({ planKey: "business" })).toEqual({
      ok: false,
      error: "CARD_DECLINED",
      message: "The card was declined.",
    });
  });
});

describe("a refused checkout, pack or portal call refreshes the page", () => {
  it("only when the service refused: it may have healed the row from Stripe first; a success leaves the page anyway", async () => {
    await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: false,
    });
    await actions.startPackCheckoutAction({ packKey: "images20" });
    await actions.openPortalAction();
    expect(mocks.revalidate).not.toHaveBeenCalled();

    const refusal = { ok: false, error: "ALREADY_SUBSCRIBED", message: "x" };
    mocks.startSubscriptionCheckout.mockResolvedValue(refusal);
    mocks.startPackCheckout.mockResolvedValue({
      ...refusal,
      error: "PLAN_REQUIRED",
    });
    mocks.openBillingPortal.mockResolvedValue({
      ...refusal,
      error: "NO_CUSTOMER",
    });
    await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: false,
    });
    await actions.startPackCheckoutAction({ packKey: "images20" });
    await actions.openPortalAction();

    expect(mocks.revalidate).toHaveBeenCalledTimes(3);
    expect(mocks.revalidate).toHaveBeenCalledWith("/billing");
  });

  it("not when the guard refused before the service was reached", async () => {
    mocks.manager.mockResolvedValue(false);
    await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: false,
    });
    await actions.startPackCheckoutAction({ packKey: "images20" });
    await actions.openPortalAction();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

describe("promo codes", () => {
  it("checks a code for the caller's own workspace, with a stricter limit than other actions", async () => {
    const result = await actions.checkPromoCodeAction({ code: "SPRING20" });

    expect(result).toEqual({
      ok: true,
      code: "SPRING20",
      description: "20% off your first payment",
    });
    expect(mocks.checkPromoCode).toHaveBeenCalledWith(
      { workspaceId: "w-mine", code: "SPRING20" },
      DEPS,
    );
    // 10 tries / 10 minutes (the other billing actions allow 20): guessing codes is slow.
    expect(mocks.limited).toHaveBeenCalledWith("billing:promo:u1", 10, 600_000);
    mocks.limited.mockClear();
    await actions.cancelSubscriptionAction();
    expect(mocks.limited).toHaveBeenCalledWith(
      "billing:cancel:u1",
      20,
      600_000,
    );
  });

  it("hands the code to checkout, and a client cannot name another workspace", async () => {
    await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: false,
      promoCode: "SPRING20",
      workspaceId: "w-victim",
    } as unknown as Parameters<typeof actions.startCheckoutAction>[0]);

    expect(mocks.startSubscriptionCheckout.mock.calls[0]![0]).toMatchObject({
      workspaceId: "w-mine",
      promoCode: "SPRING20",
    });
  });

  it("a checkout WITH a code is a code guess too: it spends the same 10-per-10-minutes allowance as Apply", async () => {
    await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: false,
      promoCode: "FREE100",
    });

    expect(mocks.limited).toHaveBeenCalledWith(
      "billing:checkout:u1",
      20,
      600_000,
    );
    expect(mocks.limited).toHaveBeenCalledWith("billing:promo:u1", 10, 600_000);
  });

  it("when the code allowance is spent, the checkout is refused before the service (and Stripe) is touched", async () => {
    mocks.limited.mockImplementation((key: string) =>
      key.startsWith("billing:promo:"),
    );

    const result = await actions.startCheckoutAction({
      planKey: "growth",
      interval: "MONTH",
      applyFirstMonth: false,
      promoCode: "GUESS",
    });

    expect(result).toMatchObject({ ok: false, error: "RATE_LIMITED" });
    expect(mocks.startSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it("a checkout without a code (or with a blank one) never touches the code allowance", async () => {
    for (const promoCode of [undefined, "", "   "]) {
      await actions.startCheckoutAction({
        planKey: "growth",
        interval: "MONTH",
        applyFirstMonth: false,
        promoCode,
      });
    }

    const keys = mocks.limited.mock.calls.map((call) => call[0]);
    expect(keys.some((key) => String(key).startsWith("billing:promo:"))).toBe(
      false,
    );
  });

  it("answers a bad code with the service's one generic message", async () => {
    mocks.checkPromoCode.mockResolvedValue({
      ok: false,
      error: "PROMO_INVALID",
      message: "That code is not valid or has expired.",
    });

    expect(await actions.checkPromoCodeAction({ code: "NOPE" })).toEqual({
      ok: false,
      error: "PROMO_INVALID",
      message: "That code is not valid or has expired.",
    });
  });
});
