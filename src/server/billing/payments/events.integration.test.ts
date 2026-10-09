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
import { EXTRA_PACKS, quotaFor } from "@/lib/billing/plans";
import { describeIntegration } from "@/test-support/integration-suite";

import { StripeApiError } from "../stripe/client";
import type { StripeEventEnvelope } from "../stripe/facts";
import { processStripeEvent } from "./events";
import {
  createFakeStripe,
  T0,
  T1,
  type FakeStripe,
} from "./test-support/fake-stripe";

// Webhook olaylarının uçtan uca işlenmesi: gelen kutusu, tekrar teslim, sıra bozukluğu,
// kiracı eşleşmesi, iade/itiraz, ek paket. Stripe sahte ağ geçididir; veritabanı gerçek.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_evt_${runId}_${++counter}`;
const NOW = new Date("2026-11-15T12:00:00.000Z");

function evt(
  type: string,
  objectId: string | null,
  overrides: Partial<StripeEventEnvelope> = {},
): StripeEventEnvelope {
  return {
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    type,
    livemode: false,
    objectId,
    objectType: null,
    ...overrides,
  };
}

const deps = (fake: FakeStripe) => ({
  gateway: fake.gateway,
  mode: "test" as const,
  now: NOW,
});

async function customerFor(workspaceId: string) {
  const stripeCustomerId = `cus_${workspaceId}`;
  await prisma.billingCustomer.create({
    data: { workspaceId, livemode: false, stripeCustomerId },
  });
  return stripeCustomerId;
}

// Checkout'u tamamlamış, ilk faturası ödenmiş abonelik.
async function checkedOut(
  fake: FakeStripe,
  workspaceId: string,
  options: {
    planKey?: "starter" | "growth" | "business" | "agency";
    intro?: boolean;
  } = {},
) {
  const customerId = await customerFor(workspaceId);
  const sub = fake.subscription({
    customerId,
    planKey: options.planKey ?? "growth",
    metadata: { workspaceId, intro: options.intro ? "1" : "0" },
  });
  const invoice = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: "subscription_create",
    chargeId: undefined,
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
    mode: "subscription",
    customerId,
    subscriptionId: sub.id,
    clientReferenceId: workspaceId,
    metadata: { kind: "subscription", workspaceId },
  });
  return { customerId, sub: fake.subs.get(sub.id)!, invoice, session };
}

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });
const inboxOf = (eventId: string) =>
  prisma.billingEvent.findUniqueOrThrow({
    where: { provider_eventId: { provider: "stripe", eventId } },
  });

describeIntegration("billing webhook events", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_evt_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.billingCustomer.deleteMany({ where });
    await prisma.billingReversal.deleteMany({ where });
    await prisma.billingEvent.deleteMany({
      where: { workspaceId: { startsWith: `ws_evt_${runId}` } },
    });
  });

  describe("the inbox", () => {
    it("records the event, processes it once and answers a repeat without working again", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session } = await checkedOut(fake, workspaceId);
      const event = evt("checkout.session.completed", session.id);

      const first = await processStripeEvent(event, deps(fake));
      const reads = fake.calls.length;
      const second = await processStripeEvent(event, deps(fake));

      expect(first).toEqual({ result: "processed", note: undefined });
      expect(second).toEqual({ result: "duplicate" });
      expect(fake.calls.length).toBe(reads);
      expect(await inboxOf(event.id)).toMatchObject({
        status: "PROCESSED",
        workspaceId,
        type: "checkout.session.completed",
        attempts: 1,
      });
    });

    it("ignores event types it does not act on, and events of the other Stripe mode", async () => {
      const fake = createFakeStripe();
      const unhandled = evt("customer.created", "cus_x");
      const live = evt("invoice.paid", "in_x", { livemode: true });

      expect(await processStripeEvent(unhandled, deps(fake))).toEqual({
        result: "ignored",
        note: "unhandled-type",
      });
      expect(await processStripeEvent(live, deps(fake))).toEqual({
        result: "ignored",
        note: "livemode-mismatch",
      });
      expect(fake.calls).toHaveLength(0);
    });

    it("marks a failure FAILED, rethrows so Stripe retries, and the retry completes it", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session } = await checkedOut(fake, workspaceId);
      const event = evt("checkout.session.completed", session.id);
      fake.failures.read = new StripeApiError({
        status: 500,
        message: "Stripe is down",
      });

      await expect(
        processStripeEvent(event, deps(fake)),
      ).rejects.toBeInstanceOf(StripeApiError);
      expect(await inboxOf(event.id)).toMatchObject({
        status: "FAILED",
        attempts: 1,
      });
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId } }),
      ).toBeNull();

      delete fake.failures.read;
      const retry = await processStripeEvent(event, deps(fake));

      expect(retry.result).toBe("processed");
      expect(await inboxOf(event.id)).toMatchObject({
        status: "PROCESSED",
        attempts: 2,
      });
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
    });
  });

  describe("subscription lifecycle", () => {
    it("checkout completion activates the plan; the invoice event afterwards changes nothing", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session, invoice } = await checkedOut(fake, workspaceId, {
        planKey: "business",
        intro: true,
      });

      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      const row = await rowOf(workspaceId);
      expect(row).toMatchObject({
        status: "ACTIVE",
        planKey: "business",
        introOffer: true,
        periodIndex: 1,
      });
      const image = await prisma.usageBalance.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
      });
      expect(Number(image.periodGranted)).toBe(
        quotaFor("business", { firstMonth: true }).IMAGE,
      );

      await processStripeEvent(evt("invoice.paid", invoice.id), deps(fake));
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        paidThrough: T1,
      });
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "PLAN", unit: "IMAGE" },
        }),
      ).toBe(1);
    });

    it("works when the invoice event comes before the checkout event (order does not matter)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session, invoice, sub } = await checkedOut(fake, workspaceId);

      await processStripeEvent(
        evt("customer.subscription.created", sub.id),
        deps(fake),
      );
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId } }),
      ).toBeNull();
      await processStripeEvent(evt("invoice.paid", invoice.id), deps(fake));
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      await processStripeEvent(
        evt("customer.subscription.updated", sub.id),
        deps(fake),
      );

      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "PLAN", unit: "IMAGE" },
        }),
      ).toBe(1);
    });

    it("a renewal invoice extends the paid period", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session, sub, customerId } = await checkedOut(fake, workspaceId);
      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      const T2 = new Date("2027-01-01T00:00:00.000Z");
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });

      await processStripeEvent(evt("invoice.paid", renewal.id), {
        ...deps(fake),
        now: new Date("2026-12-01T02:00:00.000Z"),
      });

      expect(await rowOf(workspaceId)).toMatchObject({
        paidThrough: T2,
        periodIndex: 2,
      });
    });

    it("a failed payment starts the grace period; the end of the subscription cancels it", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session, sub, customerId } = await checkedOut(fake, workspaceId);
      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      const failing = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        status: "open",
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: new Date("2027-01-01T00:00:00.000Z"),
      });
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, status: "past_due" });

      await processStripeEvent(
        evt("invoice.payment_failed", failing.id),
        deps(fake),
      );
      expect(await rowOf(workspaceId)).toMatchObject({ status: "PAST_DUE" });
      // The open invoice gave no paid period.
      expect((await rowOf(workspaceId)).paidThrough).toEqual(T1);

      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        status: "canceled",
        cancellationReason: "payment_failed",
        endedAt: NOW,
      });
      await processStripeEvent(
        evt("customer.subscription.deleted", sub.id),
        deps(fake),
      );
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "PAYMENT_FAILED",
      });
    });

    it("an invoice event whose invoice is no longer paid (void) grants nothing", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, invoice } = await checkedOut(fake, workspaceId);
      fake.invoices.set(invoice.id, { ...invoice, status: "void" });

      const outcome = await processStripeEvent(
        evt("invoice.paid", invoice.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "awaiting-payment" });
      expect(sub.id).toBeTruthy();
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId } }),
      ).toBeNull();
    });

    it("a one-off invoice (pack receipt) is not a subscription payment", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const customerId = await customerFor(workspaceId);
      const receipt = fake.invoice({
        subscriptionId: null,
        customerId,
        billingReason: "manual",
      });

      const outcome = await processStripeEvent(
        evt("invoice.paid", receipt.id),
        deps(fake),
      );

      expect(outcome).toEqual({
        result: "ignored",
        note: "not-a-subscription-invoice",
      });
    });
  });

  describe("whose payment is it", () => {
    it("never applies a payment whose Stripe metadata names a different workspace than the customer's", async () => {
      const fake = createFakeStripe();
      const owner = newWs();
      const attacker = newWs();
      const customerId = await customerFor(owner);
      const sub = fake.subscription({
        customerId,
        metadata: { workspaceId: attacker },
      });
      const invoice = fake.invoice({ subscriptionId: sub.id, customerId });

      const outcome = await processStripeEvent(
        evt("invoice.paid", invoice.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "tenant-mismatch" });
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId: owner } }),
      ).toBeNull();
      expect(
        await prisma.subscription.findUnique({
          where: { workspaceId: attacker },
        }),
      ).toBeNull();
    });

    it("a checkout session whose reference names another workspace is not applied", async () => {
      const fake = createFakeStripe();
      const owner = newWs();
      const other = newWs();
      const { session } = await checkedOut(fake, owner);
      fake.sessions.set(session.id, { ...session, clientReferenceId: other });

      const outcome = await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "tenant-mismatch" });
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId: owner } }),
      ).toBeNull();
    });

    it("ignores a customer it never created", async () => {
      const fake = createFakeStripe();
      const sub = fake.subscription({
        customerId: "cus_stranger",
        metadata: { workspaceId: "w" },
      });
      const invoice = fake.invoice({
        subscriptionId: sub.id,
        customerId: "cus_stranger",
      });

      const outcome = await processStripeEvent(
        evt("invoice.paid", invoice.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "unknown-customer" });
    });

    it("an invoice whose customer differs from its subscription's customer is not applied", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const customerId = await customerFor(workspaceId);
      const sub = fake.subscription({ customerId, metadata: { workspaceId } });
      const invoice = fake.invoice({
        subscriptionId: sub.id,
        customerId: "cus_someone_else",
      });

      const outcome = await processStripeEvent(
        evt("invoice.paid", invoice.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "tenant-mismatch" });
    });
  });

  describe("extra packs", () => {
    async function packSession(
      fake: FakeStripe,
      workspaceId: string,
      overrides: Partial<ReturnType<FakeStripe["session"]>> = {},
    ) {
      const customerId = await customerFor(workspaceId);
      const intent = fake.intent({
        customerId,
        metadata: { kind: "pack", pack: "images20", workspaceId },
      });
      const session = fake.session({
        mode: "payment",
        customerId,
        paymentIntentId: intent.id,
        clientReferenceId: workspaceId,
        metadata: { kind: "pack", pack: "images20", workspaceId },
        ...overrides,
      });
      return { customerId, intent, session };
    }

    const extraGranted = async (workspaceId: string) =>
      Number(
        (
          await prisma.usageBalance.findUniqueOrThrow({
            where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
          })
        ).extraGranted,
      );

    it("grants the pack on payment, once, even if both completion events arrive", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session } = await packSession(fake, workspaceId);

      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      await processStripeEvent(
        evt("checkout.session.async_payment_succeeded", session.id),
        deps(fake),
      );

      expect(await extraGranted(workspaceId)).toBe(EXTRA_PACKS.images20.amount);
    });

    it("waits for a delayed payment and grants when it clears", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session } = await packSession(fake, workspaceId, {
        paymentStatus: "unpaid",
      });

      const early = await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      expect(early).toEqual({ result: "ignored", note: "awaiting-payment" });
      expect(
        await prisma.usageBalance.findUnique({
          where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        }),
      ).toBeNull();

      fake.sessions.set(session.id, { ...session, paymentStatus: "paid" });
      await processStripeEvent(
        evt("checkout.session.async_payment_succeeded", session.id),
        deps(fake),
      );

      expect(await extraGranted(workspaceId)).toBe(EXTRA_PACKS.images20.amount);
    });

    it("does not guess an unknown purchase", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { session } = await packSession(fake, workspaceId, {
        metadata: { workspaceId },
      });

      const outcome = await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "unknown-purchase" });
    });

    it("a refund takes the pack back, and a refund processed BEFORE the purchase still nets to zero", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { intent, session } = await packSession(fake, workspaceId);
      const charge = fake.charge({
        amount: EXTRA_PACKS.images20.priceCents,
        amountRefunded: EXTRA_PACKS.images20.priceCents,
        refunded: true,
        paymentIntentId: intent.id,
      });
      fake.intents.set(intent.id, { ...intent, latestChargeId: charge.id });

      // The refund event is processed first: nothing to take back yet.
      const early = await processStripeEvent(
        evt("charge.refunded", charge.id),
        deps(fake),
      );
      expect(early.result).toBe("processed");
      expect(
        await prisma.usageBalance.findUnique({
          where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        }),
      ).toBeNull();

      // Then the purchase: granted and immediately reconciled with the refund.
      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      expect(await extraGranted(workspaceId)).toBe(0);
    });

    it("a refund after the grant takes it back", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { intent, session } = await packSession(fake, workspaceId);
      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      const charge = fake.charge({
        amount: EXTRA_PACKS.images20.priceCents,
        amountRefunded: EXTRA_PACKS.images20.priceCents,
        refunded: true,
        paymentIntentId: intent.id,
      });

      await processStripeEvent(evt("charge.refunded", charge.id), deps(fake));

      expect(await extraGranted(workspaceId)).toBe(0);
    });

    it("a charge that is not ours is left alone", async () => {
      const fake = createFakeStripe();
      const charge = fake.charge({
        paymentIntentId: null,
        customerId: "cus_x",
      });

      const outcome = await processStripeEvent(
        evt("charge.refunded", charge.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "unrelated-charge" });
    });
  });

  describe("refund and chargeback of a subscription", () => {
    async function paid(fake: FakeStripe, workspaceId: string) {
      const data = await checkedOut(fake, workspaceId);
      await processStripeEvent(
        evt("checkout.session.completed", data.session.id),
        deps(fake),
      );
      const charge = fake.charge({
        amount: 14_900,
        invoiceId: data.invoice.id,
        customerId: data.customerId,
      });
      return { ...data, charge };
    }

    it("a full refund ends the subscription now and cancels it in Stripe so it will not bill again", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge, sub } = await paid(fake, workspaceId);
      fake.charges.set(charge.id, {
        ...charge,
        amountRefunded: 14_900,
        refunded: true,
      });

      const outcome = await processStripeEvent(
        evt("charge.refunded", charge.id),
        deps(fake),
      );

      expect(outcome.result).toBe("processed");
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "REFUNDED",
      });
      expect(
        fake.callsNamed("cancelSubscriptionNow").map((call) => call.args),
      ).toEqual([sub.id]);
    });

    it("a partial refund changes nothing", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge } = await paid(fake, workspaceId);
      fake.charges.set(charge.id, { ...charge, amountRefunded: 5_000 });

      const outcome = await processStripeEvent(
        evt("charge.refunded", charge.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "partial-refund" });
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
    });

    it("a chargeback ends it as a chargeback", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge } = await paid(fake, workspaceId);
      const dispute = fake.dispute({ chargeId: charge.id });

      await processStripeEvent(
        evt("charge.dispute.created", dispute.id),
        deps(fake),
      );

      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "CHARGEBACK",
      });
      expect(fake.callsNamed("cancelSubscriptionNow")).toHaveLength(1);
    });

    it("if closing the subscription in Stripe fails the event is retried and still ends up correct", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge } = await paid(fake, workspaceId);
      fake.charges.set(charge.id, {
        ...charge,
        amountRefunded: 14_900,
        refunded: true,
      });
      const event = evt("charge.refunded", charge.id);
      fake.failures.cancel = new StripeApiError({
        status: 500,
        message: "down",
      });

      await expect(
        processStripeEvent(event, deps(fake)),
      ).rejects.toBeInstanceOf(StripeApiError);
      expect((await inboxOf(event.id)).status).toBe("FAILED");

      delete fake.failures.cancel;
      await processStripeEvent(event, deps(fake));

      expect((await inboxOf(event.id)).status).toBe("PROCESSED");
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "REFUNDED",
      });
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "REFUND", unit: "IMAGE" },
        }),
      ).toBeLessThanOrEqual(1);
    });
  });
});
