import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("../config", () => ({ getBillingConfig: () => config.current }));

import { prisma } from "@/lib/prisma";
import type { PlanKey } from "@/lib/billing/plans";
import { describeIntegration } from "@/test-support/integration-suite";

import { productIdForPlan } from "../stripe/catalog";
import { StripeApiError, StripeNetworkError } from "../stripe/client";
import type { ChangePlanInput } from "../stripe/gateway";
import {
  cancelAtPeriodEnd,
  changePlan,
  checkPromoCode,
  resumeSubscription,
  startSubscriptionCheckout,
  type PaymentDeps,
} from "./service";
import { syncSubscriptionState } from "./subscription-state";
import { createFakeStripe, type FakeStripe } from "./test-support/fake-stripe";

// Round 2 of the independent review of Faz 4: what the request path (change plan, cancel,
// checkout) does with a snapshot that is stale, a Stripe that disagrees with the local row,
// a request that may or may not have gone through, and the rules of a promotion code.
// Real Postgres, fake Stripe.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_r2_${runId}_${++counter}`;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const APP = "https://app.test";

const pay = (
  fake: FakeStripe,
  mode: "test" | "live" = "test",
): PaymentDeps => ({ gateway: fake.gateway, mode, appUrl: APP });

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });

// A workspace with a Stripe customer and a paid, linked subscription.
async function subscribed(
  fake: FakeStripe,
  workspaceId: string,
  planKey: PlanKey = "growth",
  options: { livemode?: boolean } = {},
) {
  const livemode = options.livemode ?? false;
  const customerId = `cus_${livemode ? "live" : "test"}_${workspaceId}`;
  await prisma.billingCustomer.create({
    data: { workspaceId, livemode, stripeCustomerId: customerId },
  });
  const sub = fake.subscription({
    customerId,
    planKey,
    livemode,
    metadata: { workspaceId, intro: "0" },
  });
  const paid = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: "subscription_create",
    livemode,
  });
  await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
  return { sub, customerId };
}

const planCalls = (fake: FakeStripe) =>
  fake
    .callsNamed("changeSubscriptionPlan")
    .map((call) => call.args as ChangePlanInput)
    .map((args) => `${args.proration}:${args.planKey}`);

const outcome = (result: { ok: boolean }) =>
  result.ok ? "ok" : (result as unknown as { error: string }).error;

describeIntegration("Faz 4 review fixes, round 2", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_r2_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.billingCustomer.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
  });

  describe("changePlan decides on Stripe's CURRENT state", () => {
    // Another request (a second tab, a webhook) already moved the subscription to Business
    // and wrote it; this request read Stripe a moment earlier and still saw Growth.
    const staleGrowth = (fake: FakeStripe, subId: string) => ({
      ...fake.subs.get(subId)!,
      planKey: "growth" as const,
      productId: productIdForPlan("growth"),
      fetchedAt: new Date(Date.now() - HOUR),
    });

    it("a snapshot older than what is already written is read again, so a switch back to Growth is really scheduled in Stripe", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "business");
      vi.spyOn(fake.gateway, "getSubscription").mockResolvedValueOnce(
        staleGrowth(fake, sub.id),
      );

      const result = await changePlan(
        { workspaceId, planKey: "growth" },
        pay(fake),
        NOW,
      );

      expect(result).toEqual({ ok: true, kind: "downgrade-scheduled" });
      // With the stale view (Stripe "already on Growth") nothing would have been sent and the
      // renewal would have charged Business while the screen said "switch scheduled".
      expect(planCalls(fake)).toEqual(["none:growth"]);
      expect(fake.subs.get(sub.id)!.planKey).toBe("growth");
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        pendingPlanKey: "growth",
      });
    });

    it("when every read is stale it refuses to guess: a change is being processed, nothing is sent", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "business");
      vi.spyOn(fake.gateway, "getSubscription").mockResolvedValue(
        staleGrowth(fake, sub.id),
      );

      const result = await changePlan(
        { workspaceId, planKey: "growth" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "CHANGE_IN_PROGRESS" });
      expect(planCalls(fake)).toEqual([]);
    });

    it("Stripe already says past due: the row is brought in line and the person is told about the payment, not 'no subscription'", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, status: "past_due" });

      const result = await changePlan(
        { workspaceId, planKey: "business" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "PAYMENT_PROBLEM" });
      expect((await rowOf(workspaceId)).status).toBe("PAST_DUE");
      expect(planCalls(fake)).toEqual([]);
    });

    it("Stripe already ended the subscription: the row is closed too", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        status: "canceled",
        endedAt: NOW,
        cancellationReason: "cancellation_requested",
      });

      const result = await changePlan(
        { workspaceId, planKey: "business" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "NO_SUBSCRIPTION" });
      expect((await rowOf(workspaceId)).status).toBe("CANCELED");
    });
  });

  describe("an upgrade whose outcome is unknown", () => {
    async function businessWithScheduledGrowth() {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "business");
      expect(
        await changePlan({ workspaceId, planKey: "growth" }, pay(fake), NOW),
      ).toEqual({ ok: true, kind: "downgrade-scheduled" });
      expect((await rowOf(workspaceId)).pendingPlanKey).toBe("growth");
      fake.callsNamed("changeSubscriptionPlan").length = 0;
      fake.calls.length = 0;
      return { fake, workspaceId, sub };
    }

    it("did not go through: the downgrade the person chose is put back, not silently lost", async () => {
      const { fake, workspaceId, sub } = await businessWithScheduledGrowth();
      // The upgrade request dies on the network before Stripe applies it.
      fake.failures.changePlanWhen = (input) =>
        input.proration === "always_invoice"
          ? new StripeNetworkError("socket hang up")
          : null;

      const result = await changePlan(
        { workspaceId, planKey: "agency" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "OUTCOME_UNKNOWN" });
      // revert to the paid plan, the failed upgrade, then the scheduled downgrade again
      expect(planCalls(fake)).toEqual([
        "none:business",
        "always_invoice:agency",
        "none:growth",
      ]);
      expect(fake.subs.get(sub.id)!.planKey).toBe("growth");
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        pendingPlanKey: "growth",
      });
    });

    it("went through although the answer was lost: nothing is put back over it", async () => {
      const { fake, workspaceId, sub } = await businessWithScheduledGrowth();
      const real = fake.gateway.changeSubscriptionPlan.bind(fake.gateway);
      vi.spyOn(fake.gateway, "changeSubscriptionPlan").mockImplementation(
        async (input) => {
          const applied = await real(input);
          if (input.proration === "always_invoice") {
            throw new StripeNetworkError("connection reset after the answer");
          }
          return applied;
        },
      );

      const result = await changePlan(
        { workspaceId, planKey: "agency" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "OUTCOME_UNKNOWN" });
      expect(planCalls(fake)).toEqual([
        "none:business",
        "always_invoice:agency",
      ]);
      expect(fake.subs.get(sub.id)!.planKey).toBe("agency");
      // the upgrade is paid in the fake, so the read-back adopted it
      expect((await rowOf(workspaceId)).planKey).toBe("agency");
    });
  });

  describe("a 409 is not a refusal", () => {
    it("the same key is (or was) in flight at Stripe: the change may be applied, so the person is not told 'nothing was charged'", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await subscribed(fake, workspaceId, "growth");
      fake.failures.setCancel = new StripeApiError({
        status: 409,
        code: "idempotency_key_in_use",
        message: "Stripe 409 idempotency_key_in_use",
      });

      const result = await cancelAtPeriodEnd(workspaceId, pay(fake), NOW);

      expect(result).toMatchObject({ ok: false, error: "OUTCOME_UNKNOWN" });
    });

    it("an ordinary 4xx refusal is still a plain refusal", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await subscribed(fake, workspaceId, "growth");
      fake.failures.setCancel = new StripeApiError({
        status: 400,
        code: "parameter_invalid_empty",
        message: "Stripe 400",
      });

      const result = await cancelAtPeriodEnd(workspaceId, pay(fake), NOW);

      expect(result).toMatchObject({ ok: false, error: "PROVIDER_ERROR" });
    });
  });

  describe("cancel / resume that Stripe refuses because the subscription is already over", () => {
    it("the row follows Stripe (closed) and the person is not left with 'try again' forever", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      // The cancellation event was lost: Stripe ended it, the row still says ACTIVE.
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        status: "canceled",
        endedAt: NOW,
        cancellationReason: "cancellation_requested",
      });
      fake.failures.setCancel = new StripeApiError({
        status: 400,
        code: "resource_already_exists",
        message: "Stripe 400: subscription is canceled",
      });
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");

      const result = await resumeSubscription(workspaceId, pay(fake), NOW);

      expect(result).toMatchObject({ ok: false, error: "NO_SUBSCRIPTION" });
      expect((await rowOf(workspaceId)).status).toBe("CANCELED");
    });

    it("a refusal for another reason leaves a living subscription alone", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await subscribed(fake, workspaceId, "growth");
      fake.failures.setCancel = new StripeApiError({
        status: 400,
        message: "Stripe 400: something else",
      });

      const result = await resumeSubscription(workspaceId, pay(fake), NOW);

      expect(result).toMatchObject({ ok: false, error: "PROVIDER_ERROR" });
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
    });
  });

  describe("checkout answers from Stripe's state, not from the row it read before looking", () => {
    it("Stripe says the renewal failed (the row still says active): the person is sent to fix the payment, not told to change the plan", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, status: "past_due" });
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");

      const result = await startSubscriptionCheckout(
        {
          workspaceId,
          planKey: "business",
          interval: "MONTH",
          applyFirstMonth: false,
        },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "PAYMENT_PROBLEM" });
      expect((await rowOf(workspaceId)).status).toBe("PAST_DUE");
    });
  });

  describe("the first-month discount, as the server decides it, with a test row under the live key", () => {
    it("a workspace whose only Stripe history is a TEST-mode subscription still gets the live discount; under the test key it does not", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth", {
        livemode: false,
      });
      // The test subscription is over, in Stripe and in the row.
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, status: "canceled" });
      await prisma.subscription.update({
        where: { workspaceId },
        data: {
          status: "CANCELED",
          paidThrough: new Date(NOW.getTime() - HOUR),
        },
      });
      const request = {
        workspaceId,
        planKey: "growth" as const,
        interval: "MONTH" as const,
        applyFirstMonth: true,
      };

      const live = await startSubscriptionCheckout(
        request,
        pay(fake, "live"),
        NOW,
      );
      const test = await startSubscriptionCheckout(
        request,
        pay(fake, "test"),
        NOW,
      );

      expect(outcome(live)).toBe("ok");
      expect(
        fake.callsNamed("createSubscriptionCheckout")[0]!.args,
      ).toMatchObject({ firstMonth: true });
      expect(test).toMatchObject({
        ok: false,
        error: "DISCOUNT_NOT_AVAILABLE",
      });
    });
  });

  describe("promotion codes: the rules Stripe enforces are checked before the person is told the code works", () => {
    const base = (workspaceId: string) => ({
      workspaceId,
      planKey: "growth" as const,
      interval: "MONTH" as const,
      applyFirstMonth: false,
    });

    it("a first-purchase-only code is refused for a workspace that has paid before, and fine for one that has not", async () => {
      const fake = createFakeStripe();
      fake.promotion({ code: "FIRSTONLY", firstTimeOnly: true });
      const returning = newWs();
      await subscribed(fake, returning, "growth");
      const fresh = newWs();

      expect(
        await checkPromoCode(
          { workspaceId: returning, code: "FIRSTONLY" },
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: false, error: "PROMO_INVALID" });
      expect(
        await checkPromoCode(
          { workspaceId: fresh, code: "FIRSTONLY" },
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: true, code: "FIRSTONLY" });
      expect(
        await startSubscriptionCheckout(
          { ...base(returning), interval: "MONTH", promoCode: "FIRSTONLY" },
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: false });
    });

    it("a minimum in another currency can never be met by a US-dollar checkout", async () => {
      const fake = createFakeStripe();
      fake.promotion({
        code: "EUROMIN",
        minimumAmount: 1_000,
        minimumAmountCurrency: "eur",
      });
      fake.promotion({
        code: "USDMIN",
        minimumAmount: 1_000,
        minimumAmountCurrency: "usd",
      });
      const workspaceId = newWs();

      expect(
        await checkPromoCode({ workspaceId, code: "EUROMIN" }, pay(fake), NOW),
      ).toMatchObject({ ok: false, error: "PROMO_INVALID" });
      expect(
        await checkPromoCode({ workspaceId, code: "USDMIN" }, pay(fake), NOW),
      ).toMatchObject({ ok: true });
    });

    it("a code made for this customer is found even when another customer's code has the same text", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { customerId } = await subscribed(fake, workspaceId, "growth");
      fake.promotion({ code: "WELCOME-BACK", customerId: "cus_someone_else" });
      fake.promotion({ code: "WELCOME-BACK", customerId });

      const result = await checkPromoCode(
        { workspaceId, code: "WELCOME-BACK" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: true, code: "WELCOME-BACK" });
    });

    it("a code only another customer can use is just 'not valid'", async () => {
      const fake = createFakeStripe();
      fake.promotion({ code: "THEIRS", customerId: "cus_someone_else" });

      expect(
        await checkPromoCode(
          { workspaceId: newWs(), code: "THEIRS" },
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: false, error: "PROMO_INVALID" });
    });

    it("when Stripe itself refuses the code at checkout, the person hears that the code is not valid, not a generic 'try again'", async () => {
      const fake = createFakeStripe();
      fake.promotion({ code: "SPRING20" });
      fake.failures.checkout = new StripeApiError({
        status: 400,
        param: "discounts[0][promotion_code]",
        message: "Stripe 400: This promotion code cannot be redeemed.",
      });

      const result = await startSubscriptionCheckout(
        { ...base(newWs()), promoCode: "SPRING20" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "PROMO_INVALID" });
    });

    it("an unrelated 400 at checkout stays a provider error", async () => {
      const fake = createFakeStripe();
      fake.promotion({ code: "SPRING20" });
      fake.failures.checkout = new StripeApiError({
        status: 400,
        param: "success_url",
        message: "Stripe 400: Invalid URL",
      });

      const result = await startSubscriptionCheckout(
        { ...base(newWs()), promoCode: "SPRING20" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "PROVIDER_ERROR" });
    });
  });
});
