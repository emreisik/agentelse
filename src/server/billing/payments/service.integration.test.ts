import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
import { quotaFor, type PlanKey } from "@/lib/billing/plans";
import { describeIntegration } from "@/test-support/integration-suite";

import { StripeApiError, StripeNetworkError } from "../stripe/client";
import {
  cancelAtPeriodEnd,
  changePlan,
  checkPromoCode,
  describePromotion,
  firstMonthEligible,
  listWorkspaceInvoices,
  openBillingPortal,
  reconcileCheckoutReturn,
  resumeSubscription,
  startPackCheckout,
  startSubscriptionCheckout,
  type PaymentDeps,
} from "./service";
import { syncSubscriptionState } from "./subscription-state";
import {
  createFakeStripe,
  T0,
  T1,
  type FakeStripe,
} from "./test-support/fake-stripe";

// Kullanıcının başlattığı eylemler (Checkout, portal, plan değiştirme, iptal) GERÇEK
// Postgres'e karşı; Stripe sahte ağ geçididir.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_svc_${runId}_${++counter}`;
const APP = "https://app.test";
const AT = new Date("2026-11-15T12:00:00.000Z");

const depsFor = (fake: FakeStripe): PaymentDeps => ({
  gateway: fake.gateway,
  mode: "test",
  appUrl: APP,
});

async function subscribed(
  fake: FakeStripe,
  workspaceId: string,
  planKey: PlanKey = "growth",
  now = new Date("2026-11-15T12:00:00.000Z"),
) {
  const customerId = `cus_${workspaceId}`;
  await prisma.billingCustomer.create({
    data: { workspaceId, livemode: false, stripeCustomerId: customerId },
  });
  const sub = fake.subscription({
    customerId,
    planKey,
    metadata: { workspaceId, intro: "0" },
  });
  const paid = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: "subscription_create",
  });
  await syncSubscriptionState({ workspaceId, sub, paid, now });
  return { sub, customerId };
}

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });

describeIntegration(
  "billing actions (checkout, portal, plan change, cancel)",
  () => {
    afterEach(() => {
      config.current = {
        mode: "enforce",
        legacyBefore: null,
        legacyUntil: null,
      };
    });

    afterAll(async () => {
      const where = { workspaceId: { startsWith: `ws_svc_${runId}` } };
      await prisma.usageReservation.deleteMany({ where });
      await prisma.usageGrant.deleteMany({ where });
      await prisma.usageBalance.deleteMany({ where });
      await prisma.subscription.deleteMany({ where });
      await prisma.billingCustomer.deleteMany({ where });
    });

    describe("subscription checkout", () => {
      it("opens a Stripe checkout for the plan, creating the customer once", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();

        const first = await startSubscriptionCheckout(
          {
            workspaceId,
            email: "a@b.co",
            name: "Acme",
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: false,
          },
          depsFor(fake),
        );
        const second = await startSubscriptionCheckout(
          {
            workspaceId,
            planKey: "business",
            interval: "YEAR",
            applyFirstMonth: false,
          },
          depsFor(fake),
        );

        expect(first).toEqual({
          ok: true,
          url: "https://checkout.test/subscription",
        });
        expect(second.ok).toBe(true);
        expect(fake.callsNamed("createCustomer")).toHaveLength(1);
        expect(fake.callsNamed("createCustomer")[0]!.args).toMatchObject({
          workspaceId,
          email: "a@b.co",
          name: "Acme",
        });
        const sessions = fake
          .callsNamed("createSubscriptionCheckout")
          .map((call) => call.args);
        expect(sessions[0]).toMatchObject({
          workspaceId,
          planKey: "growth",
          interval: "MONTH",
          firstMonth: false,
          successUrl: `${APP}/billing?tab=subscription&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${APP}/billing?tab=plans&checkout=cancelled`,
        });
        expect(sessions[1]).toMatchObject({
          planKey: "business",
          interval: "YEAR",
        });
        expect(
          await prisma.billingCustomer.findMany({ where: { workspaceId } }),
        ).toHaveLength(1);
      });

      it("never takes a plan or interval it does not know", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();

        for (const bad of [
          { planKey: "enterprise", interval: "MONTH" },
          { planKey: "growth", interval: "WEEK" },
          { planKey: undefined, interval: "MONTH" },
        ]) {
          expect(
            await startSubscriptionCheckout(
              { workspaceId, ...bad, applyFirstMonth: false },
              depsFor(fake),
            ),
          ).toMatchObject({ ok: false, error: "INVALID_INPUT" });
        }
        expect(fake.calls).toHaveLength(0);
      });

      it("applies the first-month discount only to a first monthly subscription", async () => {
        const fake = createFakeStripe();
        const fresh = newWs();

        const ok = await startSubscriptionCheckout(
          {
            workspaceId: fresh,
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: true,
          },
          depsFor(fake),
        );
        expect(ok.ok).toBe(true);
        expect(
          fake.callsNamed("createSubscriptionCheckout")[0]!.args,
        ).toMatchObject({ firstMonth: true });

        const yearly = await startSubscriptionCheckout(
          {
            workspaceId: fresh,
            planKey: "growth",
            interval: "YEAR",
            applyFirstMonth: true,
          },
          depsFor(fake),
        );
        expect(yearly).toMatchObject({
          ok: false,
          error: "DISCOUNT_NOT_AVAILABLE",
        });

        // Someone who already used the intro month (then left) does not get it again.
        const returning = newWs();
        await prisma.subscription.create({
          data: {
            workspaceId: returning,
            status: "CANCELED",
            introOffer: true,
            planKey: "growth",
            interval: "MONTH",
          },
        });
        expect(
          await startSubscriptionCheckout(
            {
              workspaceId: returning,
              planKey: "growth",
              interval: "MONTH",
              applyFirstMonth: true,
            },
            depsFor(fake),
          ),
        ).toMatchObject({ ok: false, error: "DISCOUNT_NOT_AVAILABLE" });
        // ...but they can still subscribe at the normal price.
        expect(
          (
            await startSubscriptionCheckout(
              {
                workspaceId: returning,
                planKey: "growth",
                interval: "MONTH",
                applyFirstMonth: false,
              },
              depsFor(fake),
            )
          ).ok,
        ).toBe(true);
      });

      it("eligibility rule on its own", () => {
        expect(firstMonthEligible(null, "growth", "MONTH")).toBe(true);
        expect(
          firstMonthEligible(
            { introOffer: false, stripeSubscriptionId: null },
            "growth",
            "MONTH",
          ),
        ).toBe(true);
        expect(
          firstMonthEligible(
            { introOffer: true, stripeSubscriptionId: null },
            "growth",
            "MONTH",
          ),
        ).toBe(false);
        expect(
          firstMonthEligible(
            { introOffer: false, stripeSubscriptionId: "sub_1" },
            "growth",
            "MONTH",
          ),
        ).toBe(false);
        expect(firstMonthEligible(null, "growth", "YEAR")).toBe(false);
      });

      it("refuses a second subscription while one is paying, allows one after it ended", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId);

        expect(
          await startSubscriptionCheckout(
            {
              workspaceId,
              planKey: "business",
              interval: "MONTH",
              applyFirstMonth: false,
            },
            depsFor(fake),
          ),
        ).toMatchObject({ ok: false, error: "ALREADY_SUBSCRIBED" });

        await prisma.subscription.update({
          where: { workspaceId },
          data: { status: "CANCELED" },
        });
        expect(
          (
            await startSubscriptionCheckout(
              {
                workspaceId,
                planKey: "business",
                interval: "MONTH",
                applyFirstMonth: false,
              },
              depsFor(fake),
            )
          ).ok,
        ).toBe(true);
      });

      it("turns a declined card into a safe message and an outage into a retry message, without leaking Stripe text", async () => {
        const workspaceId = newWs();

        const declined = createFakeStripe();
        declined.failures.checkout = new StripeApiError({
          status: 402,
          type: "card_error",
          code: "card_declined",
          message: "Stripe 402 card_declined: secret detail",
        });
        const a = await startSubscriptionCheckout(
          {
            workspaceId,
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: false,
          },
          depsFor(declined),
        );
        expect(a).toMatchObject({ ok: false, error: "CARD_DECLINED" });
        expect(JSON.stringify(a)).not.toContain("secret detail");

        const down = createFakeStripe();
        down.failures.checkout = new StripeNetworkError("fetch failed");
        expect(
          await startSubscriptionCheckout(
            {
              workspaceId,
              planKey: "growth",
              interval: "MONTH",
              applyFirstMonth: false,
            },
            depsFor(down),
          ),
        ).toMatchObject({ ok: false, error: "PROVIDER_ERROR" });
      });

      it("recovers from a customer that was deleted on the Stripe side", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await prisma.billingCustomer.create({
          data: { workspaceId, livemode: false, stripeCustomerId: "cus_gone" },
        });
        let first = true;
        const gateway = {
          ...fake.gateway,
          createSubscriptionCheckout: async (
            input: Parameters<
              typeof fake.gateway.createSubscriptionCheckout
            >[0],
          ) => {
            if (first) {
              first = false;
              throw new StripeApiError({
                status: 400,
                code: "resource_missing",
                param: "customer",
                message: "No such customer",
              });
            }
            return fake.gateway.createSubscriptionCheckout(input);
          },
        };

        const result = await startSubscriptionCheckout(
          {
            workspaceId,
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: false,
          },
          { ...depsFor(fake), gateway },
        );

        expect(result.ok).toBe(true);
        const link = await prisma.billingCustomer.findUniqueOrThrow({
          where: { workspaceId_livemode: { workspaceId, livemode: false } },
        });
        expect(link.stripeCustomerId).not.toBe("cus_gone");
      });
    });

    describe("promo codes", () => {
      const usd = (cents: number) => ({
        id: "c_usd",
        valid: true,
        percentOff: null,
        amountOff: cents,
        currency: "usd",
        duration: "once",
        durationInMonths: null,
        redeemBy: null,
      });
      const percent = (
        percentOff: number,
        duration = "once",
        months: number | null = null,
      ) => ({
        id: "c_pct",
        valid: true,
        percentOff,
        amountOff: null,
        currency: null,
        duration,
        durationInMonths: months,
        redeemBy: null,
      });

      it("describes what a code gives in plain words", () => {
        const fake = createFakeStripe();
        const words = (
          coupon: ReturnType<typeof percent> | ReturnType<typeof usd>,
          code = "A-1",
        ) => describePromotion(fake.promotion({ code, coupon }));

        expect(words(percent(20))).toBe("20% off your first payment");
        expect(words(percent(12.5, "repeating", 3), "A-2")).toBe(
          "12.5% off for 3 months",
        );
        expect(words(percent(10, "repeating", 1), "A-3")).toBe(
          "10% off for 1 month",
        );
        expect(words(percent(50, "forever"), "A-4")).toBe(
          "50% off every payment",
        );
        expect(words(usd(1000), "A-5")).toBe("$10 off your first payment");
        expect(
          describePromotion(
            fake.promotion({
              code: "A-6",
              coupon: { ...usd(500), currency: "eur" },
            }),
          ),
        ).toBe("A discount your first payment");
      });

      it("accepts a live code (any letter case) and says what it gives", async () => {
        const fake = createFakeStripe();
        fake.promotion({ code: "SPRING20" });

        const result = await checkPromoCode(
          { workspaceId: newWs(), code: "  spring20 " },
          depsFor(fake),
          AT,
        );

        expect(result).toEqual({
          ok: true,
          code: "SPRING20",
          description: "20% off your first payment",
        });
      });

      it.each([
        ["a code that does not exist", () => "NOPE-1"],
        ["a code with odd characters", () => "no spaces!"],
        ["an empty code", () => ""],
        ["a code that is too long", () => "X".repeat(41)],
        ["something that is not text", () => 42 as unknown as string],
      ])("refuses %s with one generic message", async (_name, code) => {
        const fake = createFakeStripe();
        fake.promotion({ code: "SPRING20" });

        const result = await checkPromoCode(
          { workspaceId: newWs(), code: code() },
          depsFor(fake),
          AT,
        );

        expect(result).toMatchObject({
          ok: false,
          error: "PROMO_INVALID",
          message: "That code is not valid or has expired.",
        });
      });

      it("refuses a code that is expired, used up, inactive, or whose coupon is no longer valid, without saying which", async () => {
        const fake = createFakeStripe();
        fake.promotion({
          code: "OLD",
          expiresAt: new Date(AT.getTime() - 1000),
        });
        fake.promotion({ code: "FULL", maxRedemptions: 5, timesRedeemed: 5 });
        fake.promotion({ code: "OFF", active: false });
        fake.promotion({
          code: "DEAD",
          coupon: { ...percent(20), valid: false },
        });
        fake.promotion({
          code: "LATE",
          coupon: { ...percent(20), redeemBy: new Date(AT.getTime() - 1000) },
        });
        fake.promotion({ code: "NOCOUPON", coupon: null, couponId: null });

        for (const code of ["OLD", "FULL", "OFF", "DEAD", "LATE", "NOCOUPON"]) {
          expect(
            await checkPromoCode(
              { workspaceId: newWs(), code },
              depsFor(fake),
              AT,
            ),
          ).toMatchObject({
            ok: false,
            error: "PROMO_INVALID",
          });
        }
      });

      it("a code made for one customer works only for that customer's workspace", async () => {
        const fake = createFakeStripe();
        const owner = newWs();
        await prisma.billingCustomer.create({
          data: {
            workspaceId: owner,
            livemode: false,
            stripeCustomerId: "cus_vip",
          },
        });
        fake.promotion({ code: "VIP", customerId: "cus_vip" });

        expect(
          (
            await checkPromoCode(
              { workspaceId: owner, code: "VIP" },
              depsFor(fake),
              AT,
            )
          ).ok,
        ).toBe(true);
        expect(
          await checkPromoCode(
            { workspaceId: newWs(), code: "VIP" },
            depsFor(fake),
            AT,
          ),
        ).toMatchObject({
          ok: false,
          error: "PROMO_INVALID",
        });
      });

      it("a lookup failure is a provider error, not 'invalid code'", async () => {
        const fake = createFakeStripe();
        fake.failures.read = new StripeNetworkError("fetch failed");

        expect(
          await checkPromoCode(
            { workspaceId: newWs(), code: "SPRING20" },
            depsFor(fake),
            AT,
          ),
        ).toMatchObject({
          ok: false,
          error: "PROVIDER_ERROR",
        });
      });

      it("checkout carries the code and no first-month discount", async () => {
        const fake = createFakeStripe();
        const promo = fake.promotion({ code: "SPRING20" });
        const workspaceId = newWs();

        const result = await startSubscriptionCheckout(
          {
            workspaceId,
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: false,
            promoCode: "spring20",
          },
          depsFor(fake),
          AT,
        );

        expect(result.ok).toBe(true);
        expect(
          fake.callsNamed("createSubscriptionCheckout")[0]!.args,
        ).toMatchObject({
          promotionCodeId: promo.id,
          firstMonth: false,
        });
      });

      it("works for yearly billing too", async () => {
        const fake = createFakeStripe();
        fake.promotion({ code: "SPRING20" });

        const result = await startSubscriptionCheckout(
          {
            workspaceId: newWs(),
            planKey: "growth",
            interval: "YEAR",
            applyFirstMonth: false,
            promoCode: "SPRING20",
          },
          depsFor(fake),
          AT,
        );

        expect(result.ok).toBe(true);
      });

      it("a code and the first-month discount together are refused (the code replaces it)", async () => {
        const fake = createFakeStripe();
        fake.promotion({ code: "SPRING20" });

        const result = await startSubscriptionCheckout(
          {
            workspaceId: newWs(),
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: true,
            promoCode: "SPRING20",
          },
          depsFor(fake),
          AT,
        );

        expect(result).toMatchObject({ ok: false, error: "INVALID_INPUT" });
        expect(fake.callsNamed("createSubscriptionCheckout")).toHaveLength(0);
      });

      it("a bad code stops before any customer is created at Stripe", async () => {
        const fake = createFakeStripe();

        const result = await startSubscriptionCheckout(
          {
            workspaceId: newWs(),
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: false,
            promoCode: "TYPO-1",
          },
          depsFor(fake),
          AT,
        );

        expect(result).toMatchObject({ ok: false, error: "PROMO_INVALID" });
        expect(fake.callsNamed("createCustomer")).toHaveLength(0);
        expect(fake.callsNamed("createSubscriptionCheckout")).toHaveLength(0);
      });

      it("honors a code's minimum amount against the plan chosen", async () => {
        const fake = createFakeStripe();
        fake.promotion({ code: "BIGONLY", minimumAmount: 20_000 });

        const small = await startSubscriptionCheckout(
          {
            workspaceId: newWs(),
            planKey: "starter",
            interval: "MONTH",
            applyFirstMonth: false,
            promoCode: "BIGONLY",
          },
          depsFor(fake),
          AT,
        );
        const big = await startSubscriptionCheckout(
          {
            workspaceId: newWs(),
            planKey: "business",
            interval: "MONTH",
            applyFirstMonth: false,
            promoCode: "BIGONLY",
          },
          depsFor(fake),
          AT,
        );

        expect(small).toMatchObject({ ok: false, error: "PROMO_INVALID" });
        expect(big.ok).toBe(true);
      });

      it("an empty promo field is simply no code", async () => {
        const fake = createFakeStripe();

        const result = await startSubscriptionCheckout(
          {
            workspaceId: newWs(),
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: true,
            promoCode: "",
          },
          depsFor(fake),
          AT,
        );

        expect(result.ok).toBe(true);
        expect(fake.callsNamed("lookupPromotionCode")).toHaveLength(0);
        expect(
          fake.callsNamed("createSubscriptionCheckout")[0]!.args,
        ).toMatchObject({ firstMonth: true });
      });
    });

    describe("pack checkout", () => {
      it("needs a plan", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();

        expect(
          await startPackCheckout(
            { workspaceId, packKey: "images20" },
            depsFor(fake),
          ),
        ).toMatchObject({
          ok: false,
          error: "PLAN_REQUIRED",
        });
        await prisma.subscription.create({
          data: { workspaceId, status: "TRIALING" },
        });
        expect(
          await startPackCheckout(
            { workspaceId, packKey: "images20" },
            depsFor(fake),
          ),
        ).toMatchObject({
          error: "PLAN_REQUIRED",
        });
      });

      it("opens a checkout for a paying customer, and for a canceled one while the paid time lasts", async () => {
        const fake = createFakeStripe();
        const paying = newWs();
        await subscribed(fake, paying);
        const ok = await startPackCheckout(
          { workspaceId: paying, packKey: "images20" },
          depsFor(fake),
        );
        expect(ok).toEqual({ ok: true, url: "https://checkout.test/pack" });
        expect(fake.callsNamed("createPackCheckout")[0]!.args).toMatchObject({
          workspaceId: paying,
          packKey: "images20",
          successUrl: `${APP}/billing?tab=usage&purchase=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${APP}/billing?tab=usage&purchase=cancelled`,
        });

        const now = new Date("2026-11-20T00:00:00.000Z");
        await prisma.subscription.update({
          where: { workspaceId: paying },
          data: { status: "CANCELED" },
        });
        expect(
          (
            await startPackCheckout(
              { workspaceId: paying, packKey: "images20" },
              depsFor(fake),
              now,
            )
          ).ok,
        ).toBe(true);
        expect(
          await startPackCheckout(
            { workspaceId: paying, packKey: "images20" },
            depsFor(fake),
            new Date(T1.getTime() + 1000),
          ),
        ).toMatchObject({ error: "PLAN_REQUIRED" });
      });

      it("rejects a pack that does not exist", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId);
        for (const packKey of ["images999", "toString", 5, undefined]) {
          expect(
            await startPackCheckout({ workspaceId, packKey }, depsFor(fake)),
          ).toMatchObject({
            error: "INVALID_INPUT",
          });
        }
      });
    });

    describe("portal and invoices", () => {
      it("opens the portal only for a workspace that has a billing profile", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        expect(
          await openBillingPortal({ workspaceId }, depsFor(fake)),
        ).toMatchObject({ error: "NO_CUSTOMER" });

        await subscribed(fake, workspaceId);
        expect(await openBillingPortal({ workspaceId }, depsFor(fake))).toEqual(
          {
            ok: true,
            url: "https://portal.test/session",
          },
        );
        expect(fake.callsNamed("createPortalSession")[0]!.args).toMatchObject({
          customerId: `cus_${workspaceId}`,
          returnUrl: `${APP}/billing?tab=subscription`,
        });
      });

      it("lists a customer's invoices, nothing for a workspace without one", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        expect(
          await listWorkspaceInvoices({ workspaceId }, depsFor(fake)),
        ).toEqual([]);

        await subscribed(fake, workspaceId);
        fake.invoiceRows.push({
          id: "in_1",
          number: "N-1",
          createdAt: T0,
          amountPaid: 100,
          currency: "usd",
          status: "paid",
          hostedInvoiceUrl: null,
          invoicePdf: null,
        });
        expect(
          await listWorkspaceInvoices({ workspaceId }, depsFor(fake)),
        ).toHaveLength(1);
      });
    });

    describe("cancel and resume", () => {
      it("cancels at the end of the paid period and takes it back", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId);

        expect(await cancelAtPeriodEnd(workspaceId, depsFor(fake), AT)).toEqual(
          {
            ok: true,
          },
        );
        expect((await rowOf(workspaceId)).cancelAtPeriodEnd).toBe(true);
        expect(
          await resumeSubscription(workspaceId, depsFor(fake), AT),
        ).toEqual({
          ok: true,
        });
        expect((await rowOf(workspaceId)).cancelAtPeriodEnd).toBe(false);
      });

      it("has nothing to cancel without a paying subscription", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        expect(
          await cancelAtPeriodEnd(workspaceId, depsFor(fake), AT),
        ).toMatchObject({ error: "NO_SUBSCRIPTION" });
        await prisma.subscription.create({
          data: { workspaceId, status: "LEGACY" },
        });
        expect(
          await resumeSubscription(workspaceId, depsFor(fake), AT),
        ).toMatchObject({ error: "NO_SUBSCRIPTION" });
      });
    });

    describe("changing the plan", () => {
      it("an upgrade is charged now (proration invoiced) and takes effect immediately", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId, "starter");

        const result = await changePlan(
          { workspaceId, planKey: "growth" },
          depsFor(fake),
          AT,
        );

        expect(result).toEqual({ ok: true, kind: "upgraded" });
        expect(
          fake.callsNamed("changeSubscriptionPlan").map((call) => call.args),
        ).toEqual([
          expect.objectContaining({
            planKey: "growth",
            interval: "MONTH",
            proration: "always_invoice",
          }),
        ]);
        expect((await rowOf(workspaceId)).planKey).toBe("growth");
        const image = await prisma.usageBalance.findUniqueOrThrow({
          where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        });
        expect(Number(image.periodGranted)).toBeGreaterThan(
          quotaFor("starter").IMAGE,
        );
      });

      it("a downgrade moves no money, waits for the renewal, and the user keeps the paid plan until then", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId, "business");

        const result = await changePlan(
          { workspaceId, planKey: "growth" },
          depsFor(fake),
          AT,
        );

        expect(result).toEqual({ ok: true, kind: "downgrade-scheduled" });
        expect(
          fake.callsNamed("changeSubscriptionPlan")[0]!.args,
        ).toMatchObject({ proration: "none" });
        const row = await rowOf(workspaceId);
        expect(row.planKey).toBe("business");
        expect(row.pendingPlanKey).toBe("growth");
      });

      it("choosing the plan you already have changes nothing", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId, "growth");

        expect(
          await changePlan(
            { workspaceId, planKey: "growth" },
            depsFor(fake),
            AT,
          ),
        ).toEqual({
          ok: true,
          kind: "unchanged",
        });
        expect(fake.callsNamed("changeSubscriptionPlan")).toHaveLength(0);
      });

      it("changing your mind after a scheduled downgrade just undoes it, with no charge", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId, "business");
        await changePlan({ workspaceId, planKey: "growth" }, depsFor(fake), AT);

        const back = await changePlan(
          { workspaceId, planKey: "business" },
          depsFor(fake),
          AT,
        );

        expect(back).toEqual({ ok: true, kind: "unchanged" });
        const calls = fake
          .callsNamed("changeSubscriptionPlan")
          .map((call) => call.args);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({
          planKey: "business",
          proration: "none",
        });
        expect(await rowOf(workspaceId)).toMatchObject({
          planKey: "business",
          pendingPlanKey: null,
        });
      });

      it("upgrading past a scheduled downgrade first restores the paid plan (no money), then charges only the real difference", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId, "business");
        await changePlan({ workspaceId, planKey: "growth" }, depsFor(fake), AT);

        const result = await changePlan(
          { workspaceId, planKey: "agency" },
          depsFor(fake),
          AT,
        );

        expect(result).toEqual({ ok: true, kind: "upgraded" });
        const calls = fake
          .callsNamed("changeSubscriptionPlan")
          .map((call) => call.args);
        expect(calls.slice(1)).toEqual([
          expect.objectContaining({ planKey: "business", proration: "none" }),
          expect.objectContaining({
            planKey: "agency",
            proration: "always_invoice",
          }),
        ]);
        expect(await rowOf(workspaceId)).toMatchObject({
          planKey: "agency",
          pendingPlanKey: null,
        });
      });

      it("a declined card on an upgrade changes nothing", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        await subscribed(fake, workspaceId, "starter");
        fake.failures.changePlan = new StripeApiError({
          status: 402,
          type: "card_error",
          code: "card_declined",
          message: "declined",
        });

        const result = await changePlan(
          { workspaceId, planKey: "growth" },
          depsFor(fake),
          AT,
        );

        expect(result).toMatchObject({ ok: false, error: "CARD_DECLINED" });
        expect(await rowOf(workspaceId)).toMatchObject({
          planKey: "starter",
          pendingPlanKey: null,
        });
        expect(
          await prisma.usageGrant.count({
            where: { workspaceId, reason: "PLAN_CHANGE" },
          }),
        ).toBe(0);
      });

      it("is not allowed while a payment is failing, without a subscription, or with a plan that does not exist", async () => {
        const fake = createFakeStripe();
        const pastDue = newWs();
        await subscribed(fake, pastDue);
        await prisma.subscription.update({
          where: { workspaceId: pastDue },
          data: { status: "PAST_DUE" },
        });
        expect(
          await changePlan(
            { workspaceId: pastDue, planKey: "business" },
            depsFor(fake),
            AT,
          ),
        ).toMatchObject({
          error: "PAYMENT_PROBLEM",
        });

        expect(
          await changePlan(
            { workspaceId: newWs(), planKey: "business" },
            depsFor(fake),
            AT,
          ),
        ).toMatchObject({
          error: "NO_SUBSCRIPTION",
        });
        expect(
          await changePlan(
            { workspaceId: pastDue, planKey: "enterprise" },
            depsFor(fake),
            AT,
          ),
        ).toMatchObject({
          error: "INVALID_INPUT",
        });
      });
    });

    describe("returning from Checkout", () => {
      it("activates the plan without waiting for the webhook, and only for the workspace's own session", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        const customerId = `cus_${workspaceId}`;
        await prisma.billingCustomer.create({
          data: { workspaceId, livemode: false, stripeCustomerId: customerId },
        });
        const sub = fake.subscription({
          customerId,
          planKey: "growth",
          metadata: { workspaceId },
        });
        const invoice = fake.invoice({
          subscriptionId: sub.id,
          customerId,
          billingReason: "subscription_create",
        });
        fake.subs.set(sub.id, {
          ...sub,
          latestInvoice: {
            id: invoice.id,
            status: "paid",
            billingReason: "subscription_create",
          },
        });
        const session = fake.session({
          id: "cs_test_returnsession1",
          mode: "subscription",
          customerId,
          subscriptionId: sub.id,
          clientReferenceId: workspaceId,
        });

        const stranger = newWs();
        expect(
          await reconcileCheckoutReturn(
            { workspaceId: stranger, sessionId: session.id },
            depsFor(fake),
            AT,
          ),
        ).toBe("unknown");
        expect(
          await prisma.subscription.findUnique({ where: { workspaceId } }),
        ).toBeNull();

        expect(
          await reconcileCheckoutReturn(
            { workspaceId, sessionId: session.id },
            depsFor(fake),
            AT,
          ),
        ).toBe("active");
        expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
      });

      it("reports a payment that has not cleared yet as pending, and refuses malformed ids", async () => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        const customerId = `cus_${workspaceId}`;
        await prisma.billingCustomer.create({
          data: { workspaceId, livemode: false, stripeCustomerId: customerId },
        });
        const sub = fake.subscription({
          customerId,
          metadata: { workspaceId },
        });
        const session = fake.session({
          id: "cs_test_pendingsession1",
          mode: "subscription",
          paymentStatus: "unpaid",
          customerId,
          subscriptionId: sub.id,
          clientReferenceId: workspaceId,
        });

        expect(
          await reconcileCheckoutReturn(
            { workspaceId, sessionId: session.id },
            depsFor(fake),
            AT,
          ),
        ).toBe("pending");
        for (const bad of [
          "",
          "nonsense",
          "cs_live_x",
          undefined,
          5,
          "../etc/passwd",
        ]) {
          expect(
            await reconcileCheckoutReturn(
              { workspaceId, sessionId: bad },
              depsFor(fake),
              AT,
            ),
          ).toBe("unknown");
        }
      });
    });
  },
);
