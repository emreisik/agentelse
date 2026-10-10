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
import { EXTRA_PACKS, type PlanKey } from "@/lib/billing/plans";
import { describeIntegration } from "@/test-support/integration-suite";

import { getEntitlements } from "../entitlements";
import { ensurePeriod } from "../ledger";
import { productIdForPlan, type BillingInterval } from "../stripe/catalog";
import { StripeApiError, StripeNetworkError } from "../stripe/client";
import type {
  StripeEventEnvelope,
  StripeSubscriptionFacts,
} from "../stripe/facts";
import type { ChangePlanInput } from "../stripe/gateway";
import { processStripeEvent } from "./events";
import { grantExtraPack, reconcilePackRefund } from "./purchases";
import {
  cancelAtPeriodEnd,
  changePlan,
  openBillingPortal,
  reconcileCheckoutReturn,
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

// Faz 4 inceleme düzeltmelerinin kanıtı: gerçek Postgres, sahte Stripe. Her bölüm bir
// incelemede bulunan bir hatayı yeniden üretir ve düzeltmenin tuttuğunu gösterir.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_rfx_${runId}_${++counter}`;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const T2 = new Date("2027-01-01T00:00:00.000Z");
const YEAR_END = new Date("2027-11-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const APP = "https://app.test";

// Gerçek saatten bağımsız, artan "okunma" anları (bayat görüntü testleri için).
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 9, 12, 0, seconds));

const evt = (
  type: string,
  objectId: string | null,
  overrides: Partial<StripeEventEnvelope> = {},
): StripeEventEnvelope => ({
  id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
  type,
  livemode: false,
  objectId,
  objectType: null,
  ...overrides,
});

const events = (fake: FakeStripe) => ({
  gateway: fake.gateway,
  mode: "test" as const,
  now: NOW,
});
const pay = (
  fake: FakeStripe,
  mode: "test" | "live" = "test",
): PaymentDeps => ({ gateway: fake.gateway, mode, appUrl: APP });

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });

async function customerFor(workspaceId: string, livemode = false) {
  const stripeCustomerId = `cus_${livemode ? "live" : "test"}_${workspaceId}`;
  await prisma.billingCustomer.create({
    data: { workspaceId, livemode, stripeCustomerId },
  });
  return stripeCustomerId;
}

// Checkout'u tamamlamış, ilk faturası ödenmiş abonelik (olay henüz işlenmedi).
async function checkedOut(
  fake: FakeStripe,
  workspaceId: string,
  options: {
    planKey?: PlanKey;
    interval?: BillingInterval;
    periodEnd?: Date;
  } = {},
) {
  const customerId = await customerFor(workspaceId);
  const periodEnd = options.periodEnd ?? T1;
  const sub = fake.subscription({
    customerId,
    planKey: options.planKey ?? "growth",
    interval: options.interval ?? "MONTH",
    currentPeriodEnd: periodEnd,
    metadata: { workspaceId, intro: "0" },
  });
  const invoice = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: "subscription_create",
    periodEnd,
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

async function paidAndProcessed(
  fake: FakeStripe,
  workspaceId: string,
  options: Parameters<typeof checkedOut>[2] = {},
) {
  const data = await checkedOut(fake, workspaceId, options);
  await processStripeEvent(
    evt("checkout.session.completed", data.session.id),
    events(fake),
  );
  const charge = fake.charge({
    amount: 14_900,
    invoiceId: data.invoice.id,
    customerId: data.customerId,
  });
  return { ...data, charge };
}

const refund = (fake: FakeStripe, chargeId: string) => {
  const charge = fake.charges.get(chargeId)!;
  fake.charges.set(chargeId, {
    ...charge,
    amountRefunded: charge.amount,
    refunded: true,
  });
  return processStripeEvent(evt("charge.refunded", chargeId), events(fake));
};

// Doğrudan durum makinesi testleri için: bağlanmış, ödenmiş abonelik.
async function linked(
  fake: FakeStripe,
  workspaceId: string,
  options: {
    planKey?: PlanKey;
    interval?: BillingInterval;
    periodEnd?: Date;
    livemode?: boolean;
    fetchedAt?: Date;
    now?: Date;
  } = {},
) {
  const customerId = `cus_${workspaceId}`;
  const periodEnd = options.periodEnd ?? T1;
  const sub = fake.subscription({
    customerId,
    planKey: options.planKey ?? "growth",
    interval: options.interval ?? "MONTH",
    currentPeriodEnd: periodEnd,
    livemode: options.livemode ?? false,
    fetchedAt: options.fetchedAt ?? at(0),
    metadata: { workspaceId, intro: "0" },
  });
  const paid = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: "subscription_create",
    periodEnd,
    livemode: options.livemode ?? false,
  });
  await syncSubscriptionState({
    workspaceId,
    sub,
    paid,
    now: options.now ?? NOW,
  });
  return { sub, paid, customerId };
}

// changePlan testleri: BillingCustomer + bağlı abonelik.
async function subscribed(
  fake: FakeStripe,
  workspaceId: string,
  planKey: PlanKey = "growth",
) {
  const customerId = await customerFor(workspaceId);
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
  await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
  return { sub, customerId };
}

const planCalls = (fake: FakeStripe) =>
  fake
    .callsNamed("changeSubscriptionPlan")
    .map((call) => call.args as ChangePlanInput)
    .map((args) => `${args.proration}:${args.planKey}`);

const cardDeclined = () =>
  new StripeApiError({
    status: 402,
    type: "card_error",
    code: "card_declined",
    message: "Your card was declined.",
  });

describeIntegration("Faz 4 review fixes", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_rfx_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.billingCustomer.deleteMany({ where });
    await prisma.billingReversal.deleteMany({ where });
    await prisma.billingEvent.deleteMany({ where });
  });

  describe("money that was returned never buys access again", () => {
    it("replaying the refunded yearly invoice through every road keeps the access ended and opens no new months", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge, invoice, session } = await paidAndProcessed(
        fake,
        workspaceId,
        { interval: "YEAR", periodEnd: YEAR_END },
      );
      expect((await rowOf(workspaceId)).paidThrough).toEqual(YEAR_END);

      const refunded = await refund(fake, charge.id);
      expect(refunded.result).toBe("processed");
      const ended = await rowOf(workspaceId);
      expect(ended).toMatchObject({
        status: "CANCELED",
        endedReason: "REFUNDED",
      });
      expect(ended.paidThrough?.getTime()).toBeLessThanOrEqual(NOW.getTime());

      // Stripe keeps the refunded invoice "paid" and the canceled subscription still
      // points at it. A re-sent invoice event (new event id)...
      expect(
        await processStripeEvent(evt("invoice.paid", invoice.id), events(fake)),
      ).toEqual({ result: "ignored", note: "invoice-reversed" });
      // ...the checkout event again...
      expect(
        await processStripeEvent(
          evt("checkout.session.completed", session.id),
          events(fake),
        ),
      ).toEqual({ result: "ignored", note: "invoice-reversed" });
      // ...and the customer opening the old success address again.
      expect(
        await reconcileCheckoutReturn(
          { workspaceId, sessionId: session.id },
          pay(fake),
          NOW,
        ),
      ).toBe("reversed");

      const after = await rowOf(workspaceId);
      expect(after.paidThrough).toEqual(ended.paidThrough);
      expect(after).toMatchObject({
        status: "CANCELED",
        endedReason: "REFUNDED",
      });
      // Months later no monthly window opens on a refunded year.
      const later = new Date("2027-02-10T00:00:00.000Z");
      expect(await getEntitlements(workspaceId, { now: later })).toMatchObject({
        access: "READ_ONLY",
      });
      await ensurePeriod(workspaceId, { now: later });
      const balance = await prisma.usageBalance.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
      });
      expect(balance.periodStart).toEqual(T0);
    });

    it("a chargeback is final the same way, for a monthly plan too", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge, invoice } = await paidAndProcessed(fake, workspaceId);
      const dispute = fake.dispute({ chargeId: charge.id });
      await processStripeEvent(
        evt("charge.dispute.created", dispute.id),
        events(fake),
      );
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "CHARGEBACK",
      });

      expect(
        await processStripeEvent(evt("invoice.paid", invoice.id), events(fake)),
      ).toEqual({ result: "ignored", note: "invoice-reversed" });
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "CHARGEBACK",
      });
      expect((await getEntitlements(workspaceId, { now: NOW })).access).toBe(
        "READ_ONLY",
      );
    });

    it("a NEW invoice after a refund still brings the subscription back (control)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge, sub, customerId } = await paidAndProcessed(
        fake,
        workspaceId,
      );
      await refund(fake, charge.id);
      expect((await rowOf(workspaceId)).status).toBe("CANCELED");

      // The customer pays again on the same subscription (renewal invoice): different invoice.
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        status: "active",
        endedAt: null,
        cancellationReason: null,
        latestInvoice: {
          id: renewal.id,
          status: "paid",
          billingReason: "subscription_cycle",
        },
      });
      await processStripeEvent(evt("invoice.paid", renewal.id), events(fake));

      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        paidThrough: T2,
      });
    });

    it("a refund processed BEFORE the payment is remembered: the payment is not applied and the subscription stops renewing", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { invoice, session, sub, customerId } = await checkedOut(
        fake,
        workspaceId,
      );
      const charge = fake.charge({
        amount: 14_900,
        amountRefunded: 14_900,
        refunded: true,
        invoiceId: invoice.id,
        customerId,
      });

      const early = await processStripeEvent(
        evt("charge.refunded", charge.id),
        events(fake),
      );
      expect(early).toEqual({ result: "processed", note: "reversal-recorded" });
      expect(
        fake.callsNamed("cancelSubscriptionNow").map((call) => call.args),
      ).toEqual([sub.id]);
      expect(
        await prisma.billingReversal.findUnique({
          where: { stripeInvoiceId: invoice.id },
        }),
      ).toMatchObject({ reason: "REFUNDED", workspaceId });

      for (const late of [
        evt("checkout.session.completed", session.id),
        evt("invoice.paid", invoice.id),
        evt("invoice.payment_succeeded", invoice.id),
      ]) {
        expect(await processStripeEvent(late, events(fake))).toEqual({
          result: "ignored",
          note: "invoice-reversed",
        });
      }
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId } }),
      ).toBeNull();
    });

    it("a dispute on an EARLIER month's charge still ends the subscription, while a refund of it is left to the owner", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { charge, sub, customerId } = await paidAndProcessed(
        fake,
        workspaceId,
      );
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        latestInvoice: {
          id: renewal.id,
          status: "paid",
          billingReason: "subscription_cycle",
        },
      });
      await processStripeEvent(evt("invoice.paid", renewal.id), events(fake));
      expect((await rowOf(workspaceId)).paidThrough).toEqual(T2);

      // Refund of month one: access is not touched (the owner decides).
      fake.charges.set(charge.id, {
        ...charge,
        amountRefunded: charge.amount,
        refunded: true,
      });
      expect(
        await processStripeEvent(
          evt("charge.refunded", charge.id),
          events(fake),
        ),
      ).toEqual({ result: "ignored", note: "older-period" });
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
      // ...and the running subscription is not closed in Stripe either (a refunded old month
      // must not stop a customer who is still paying).
      expect(fake.callsNamed("cancelSubscriptionNow")).toHaveLength(0);
      expect(fake.subs.get(sub.id)!.status).toBe("active");

      // Dispute of the same earlier charge: the bank takes the money, so it ends.
      const dispute = fake.dispute({ chargeId: charge.id });
      await processStripeEvent(
        evt("charge.dispute.created", dispute.id),
        events(fake),
      );
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "CHARGEBACK",
      });
      expect(fake.callsNamed("cancelSubscriptionNow")).toHaveLength(1);
    });
  });

  describe("a second paid subscription", () => {
    async function secondSubscription(
      fake: FakeStripe,
      workspaceId: string,
      customerId: string,
      periodEnd = T2,
    ) {
      const sub = fake.subscription({
        customerId,
        planKey: "growth",
        currentPeriodEnd: periodEnd,
        metadata: { workspaceId, intro: "0" },
      });
      const invoice = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_create",
        periodEnd,
      });
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        latestInvoice: {
          id: invoice.id,
          status: "paid",
          billingReason: "subscription_create",
        },
      });
      return { sub: fake.subs.get(sub.id)!, invoice };
    }

    it("is canceled in Stripe (so it stops billing) while the first one keeps the workspace, and refunding it needs no second cancel", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const first = await paidAndProcessed(fake, workspaceId);
      const second = await secondSubscription(
        fake,
        workspaceId,
        first.customerId,
      );

      const outcome = await processStripeEvent(
        evt("invoice.paid", second.invoice.id),
        events(fake),
      );

      expect(outcome).toEqual({
        result: "ignored",
        note: "duplicate-subscription",
      });
      expect(
        fake.callsNamed("cancelSubscriptionNow").map((call) => call.args),
      ).toEqual([second.sub.id]);
      expect((await rowOf(workspaceId)).stripeSubscriptionId).toBe(
        first.sub.id,
      );

      // The owner refunds the duplicate's payment by hand.
      const charge = fake.charge({
        amount: 14_900,
        amountRefunded: 14_900,
        refunded: true,
        invoiceId: second.invoice.id,
        customerId: first.customerId,
      });
      expect(
        await processStripeEvent(
          evt("charge.refunded", charge.id),
          events(fake),
        ),
      ).toEqual({ result: "processed", note: "reversal-recorded" });
      expect(fake.callsNamed("cancelSubscriptionNow")).toHaveLength(1);
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
    });

    it("the customer who comes back from the second checkout is told it was not applied", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const first = await paidAndProcessed(fake, workspaceId);
      const second = await secondSubscription(
        fake,
        workspaceId,
        first.customerId,
      );
      const session = fake.session({
        mode: "subscription",
        customerId: first.customerId,
        subscriptionId: second.sub.id,
        clientReferenceId: workspaceId,
        metadata: { kind: "subscription", workspaceId },
      });

      expect(
        await reconcileCheckoutReturn(
          { workspaceId, sessionId: session.id },
          pay(fake),
          NOW,
        ),
      ).toBe("duplicate");
      expect((await rowOf(workspaceId)).stripeSubscriptionId).toBe(
        first.sub.id,
      );
    });

    it("takes over when the linked subscription already ended in Stripe (a missed cancellation event)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const first = await paidAndProcessed(fake, workspaceId);
      fake.subs.set(first.sub.id, {
        ...fake.subs.get(first.sub.id)!,
        status: "canceled",
        endedAt: NOW,
        cancellationReason: "cancellation_requested",
      });
      const second = await secondSubscription(
        fake,
        workspaceId,
        first.customerId,
      );

      const outcome = await processStripeEvent(
        evt("invoice.paid", second.invoice.id),
        events(fake),
      );

      expect(outcome.result).toBe("processed");
      expect(fake.callsNamed("cancelSubscriptionNow")).toHaveLength(0);
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        stripeSubscriptionId: second.sub.id,
        paidThrough: T2,
      });
    });

    it("a row whose paid time ran out does not block a new payment", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const first = await paidAndProcessed(fake, workspaceId);
      await prisma.subscription.update({
        where: { workspaceId },
        data: { paidThrough: new Date("2026-10-01T00:00:00.000Z") },
      });
      const second = await secondSubscription(
        fake,
        workspaceId,
        first.customerId,
      );

      const outcome = await processStripeEvent(
        evt("invoice.paid", second.invoice.id),
        events(fake),
      );

      expect(outcome.result).toBe("processed");
      expect(fake.callsNamed("cancelSubscriptionNow")).toHaveLength(0);
      expect((await rowOf(workspaceId)).stripeSubscriptionId).toBe(
        second.sub.id,
      );
    });

    it("relinking never shortens paid time that is still running", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await linked(fake, workspaceId, {
        interval: "YEAR",
        periodEnd: YEAR_END,
      });
      // The yearly subscription is canceled at once, with no refund: access runs to YEAR_END.
      await syncSubscriptionState({
        workspaceId,
        sub: {
          ...sub,
          status: "canceled",
          endedAt: NOW,
          cancellationReason: "cancellation_requested",
          fetchedAt: at(10),
        },
        now: NOW,
      });
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        paidThrough: YEAR_END,
      });

      const monthly = fake.subscription({
        customerId: `cus_${workspaceId}`,
        planKey: "starter",
        currentPeriodEnd: new Date("2026-12-17T12:00:00.000Z"),
        startDate: new Date("2026-11-17T12:00:00.000Z"),
        metadata: { workspaceId, intro: "0" },
      });
      const invoice = fake.invoice({
        subscriptionId: monthly.id,
        customerId: `cus_${workspaceId}`,
        billingReason: "subscription_create",
        periodStart: new Date("2026-11-17T12:00:00.000Z"),
        periodEnd: new Date("2026-12-17T12:00:00.000Z"),
      });
      const result = await syncSubscriptionState({
        workspaceId,
        sub: monthly,
        paid: invoice,
        now: new Date("2026-11-17T12:00:00.000Z"),
      });

      expect(result).toMatchObject({ applied: true });
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        planKey: "starter",
        stripeSubscriptionId: monthly.id,
        paidThrough: YEAR_END,
      });
    });
  });

  describe("stale Stripe snapshots", () => {
    it("an older snapshot read before the lock cannot overwrite a newer one", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await linked(fake, workspaceId, { fetchedAt: at(0) });

      // The newer snapshot (cancellation requested) is applied first...
      const newer: StripeSubscriptionFacts = {
        ...sub,
        cancelAtPeriodEnd: true,
        fetchedAt: at(20),
      };
      await syncSubscriptionState({ workspaceId, sub: newer, now: NOW });
      // ...then a handler that read Stripe earlier (payment failing) gets the lock.
      const older: StripeSubscriptionFacts = {
        ...sub,
        status: "past_due",
        cancelAtPeriodEnd: false,
        fetchedAt: at(10),
      };
      const result = await syncSubscriptionState({
        workspaceId,
        sub: older,
        now: NOW,
      });

      expect(result).toMatchObject({ applied: true, changed: false });
      expect(result.applied && result.notes).toContain("stale-snapshot");
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        graceUntil: null,
        cancelAtPeriodEnd: true,
        pendingPlanKey: null,
      });
    });

    it("the same two snapshots in their real order both apply (control)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = await linked(fake, workspaceId, {
        fetchedAt: at(0),
      });

      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, status: "past_due", fetchedAt: at(10) },
        now: NOW,
      });
      expect(await rowOf(workspaceId)).toMatchObject({ status: "PAST_DUE" });

      // Stripe reports the subscription healthy again with a paid latest invoice: no
      // separate payment event is needed to recover.
      await syncSubscriptionState({
        workspaceId,
        sub: {
          ...sub,
          cancelAtPeriodEnd: true,
          latestInvoice: {
            id: paid.id,
            status: "paid",
            billingReason: "subscription_create",
          },
          fetchedAt: at(20),
        },
        now: NOW,
      });
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        graceUntil: null,
        cancelAtPeriodEnd: true,
      });
    });

    it("Stripe past due with an old paid invoice as the latest one does not recover the row", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = await linked(fake, workspaceId, {
        fetchedAt: at(0),
      });
      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, status: "past_due", fetchedAt: at(10) },
        now: NOW,
      });
      expect((await rowOf(workspaceId)).status).toBe("PAST_DUE");

      // Stripe still says past_due; the latest invoice it reports is last month's paid one.
      await syncSubscriptionState({
        workspaceId,
        sub: {
          ...sub,
          status: "past_due",
          latestInvoice: {
            id: paid.id,
            status: "paid",
            billingReason: "subscription_create",
          },
          fetchedAt: at(20),
        },
        now: NOW,
      });

      expect((await rowOf(workspaceId)).status).toBe("PAST_DUE");
    });

    it("recovering without the payment event does not trade the grace period for an already expired paid period", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid, customerId } = await linked(fake, workspaceId, {
        fetchedAt: at(0),
      });
      // The renewal failed on Dec 1; two days later the customer fixed the card.
      const failedAt = new Date(T1.getTime() + 60 * 60 * 1000);
      const twoDaysLater = new Date(T1.getTime() + 2 * DAY);
      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, status: "past_due", fetchedAt: at(10) },
        now: failedAt,
      });
      const pastDue = await rowOf(workspaceId);
      expect(pastDue.status).toBe("PAST_DUE");
      expect(pastDue.graceUntil!.getTime()).toBeGreaterThan(
        twoDaysLater.getTime(),
      );

      // customer.subscription.updated arrives BEFORE invoice.paid: Stripe says active, the
      // latest invoice is paid, but this snapshot cannot say which period it paid for.
      await syncSubscriptionState({
        workspaceId,
        sub: {
          ...sub,
          latestInvoice: {
            id: paid.id,
            status: "paid",
            billingReason: "subscription_cycle",
          },
          fetchedAt: at(20),
        },
        now: twoDaysLater,
      });

      // Still inside the grace period (full access), not an ACTIVE row whose paid period
      // ended two days ago (read-only).
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "PAST_DUE",
        graceUntil: pastDue.graceUntil,
      });
      expect(
        (await getEntitlements(workspaceId, { now: twoDaysLater })).access,
      ).toBe("FULL");

      // The payment event (with the invoice and its period) completes the recovery.
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });
      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, fetchedAt: at(30) },
        paid: renewal,
        now: twoDaysLater,
      });
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        graceUntil: null,
        paidThrough: T2,
      });
    });

    it("a paid invoice still advances paid time even when its snapshot is stale", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, customerId } = await linked(fake, workspaceId, {
        fetchedAt: at(30),
      });
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });

      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, fetchedAt: at(5) },
        paid: renewal,
        now: NOW,
      });

      expect((await rowOf(workspaceId)).paidThrough).toEqual(T2);
    });

    it("a replayed paid invoice does not clear PAST_DUE while Stripe still says past_due", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = await linked(fake, workspaceId, {
        fetchedAt: at(0),
      });
      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, status: "past_due", fetchedAt: at(10) },
        now: NOW,
      });
      const before = await rowOf(workspaceId);
      expect(before.status).toBe("PAST_DUE");

      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, status: "past_due", fetchedAt: at(20) },
        paid,
        now: NOW,
      });

      expect(await rowOf(workspaceId)).toMatchObject({
        status: "PAST_DUE",
        graceUntil: before.graceUntil,
      });
    });
  });

  describe("upgrades are paid for before they count", () => {
    const upgraded = (
      sub: StripeSubscriptionFacts,
      latestInvoice: StripeSubscriptionFacts["latestInvoice"],
    ): StripeSubscriptionFacts => ({
      ...sub,
      planKey: "business",
      productId: productIdForPlan("business"),
      latestInvoice,
      fetchedAt: at(30),
    });

    it("a plan raised outside the app with the proration left for the next invoice grants nothing", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = await linked(fake, workspaceId);

      const result = await syncSubscriptionState({
        workspaceId,
        sub: upgraded(sub, {
          id: paid.id,
          status: "paid",
          billingReason: "subscription_create",
        }),
        now: NOW,
      });

      expect(result.applied && result.notes).toContain(
        "upgrade-awaiting-payment",
      );
      expect((await rowOf(workspaceId)).planKey).toBe("growth");
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "PLAN_CHANGE" },
        }),
      ).toBe(0);
    });

    it("the paid proration invoice of the change grants the difference once", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, customerId } = await linked(fake, workspaceId);
      const proration = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_update",
        periodStart: null,
        periodEnd: null,
        hasProration: true,
      });
      const next = upgraded(sub, {
        id: proration.id,
        status: "paid",
        billingReason: "subscription_update",
      });

      const first = await syncSubscriptionState({
        workspaceId,
        sub: next,
        now: NOW,
      });
      const grants = await prisma.usageGrant.count({
        where: { workspaceId, reason: "PLAN_CHANGE" },
      });
      await syncSubscriptionState({
        workspaceId,
        sub: { ...next, fetchedAt: at(40) },
        now: NOW,
      });

      expect(first.applied && first.notes).toContain("upgraded");
      expect((await rowOf(workspaceId)).planKey).toBe("business");
      expect(grants).toBeGreaterThan(0);
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "PLAN_CHANGE" },
        }),
      ).toBe(grants);
    });

    it("an upgrade billed on the renewal invoice starts with that renewal, with no extra difference granted", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, customerId } = await linked(fake, workspaceId);
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });

      const result = await syncSubscriptionState({
        workspaceId,
        sub: upgraded(sub, {
          id: renewal.id,
          status: "paid",
          billingReason: "subscription_cycle",
        }),
        paid: renewal,
        now: new Date("2026-12-01T01:00:00.000Z"),
      });

      expect(result.applied && result.notes).toContain("upgraded-at-renewal");
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        paidThrough: T2,
      });
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "PLAN_CHANGE" },
        }),
      ).toBe(0);
    });
  });

  describe("changing the plan", () => {
    it("a declined upgrade keeps the scheduled downgrade the customer had chosen", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "business");
      expect(
        await changePlan({ workspaceId, planKey: "growth" }, pay(fake), NOW),
      ).toEqual({ ok: true, kind: "downgrade-scheduled" });
      expect((await rowOf(workspaceId)).pendingPlanKey).toBe("growth");

      fake.failures.changePlanWhen = (input) =>
        input.proration === "always_invoice" ? cardDeclined() : null;
      const result = await changePlan(
        { workspaceId, planKey: "agency" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "CARD_DECLINED" });
      expect(result.ok === false && result.message).not.toContain(
        "Nothing was changed",
      );
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        pendingPlanKey: "growth",
      });
      expect(fake.subs.get(sub.id)!.planKey).toBe("growth");
      expect(planCalls(fake)).toEqual([
        "none:growth",
        "none:business",
        "always_invoice:agency",
        "none:growth",
      ]);
    });

    it("a declined upgrade with nothing scheduled changes nothing and restores nothing", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await subscribed(fake, workspaceId, "growth");
      fake.failures.changePlanWhen = () => cardDeclined();

      const result = await changePlan(
        { workspaceId, planKey: "business" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "CARD_DECLINED" });
      expect(planCalls(fake)).toEqual(["always_invoice:business"]);
      expect((await rowOf(workspaceId)).planKey).toBe("growth");
    });

    it("an upgrade Stripe already took payment for is adopted, never reverted and charged a second time", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, customerId } = await subscribed(fake, workspaceId, "growth");
      // Stripe is ahead: the paid upgrade to Business has not reached the local row.
      const proration = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_update",
        periodStart: null,
        periodEnd: null,
        hasProration: true,
      });
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        planKey: "business",
        productId: productIdForPlan("business"),
        latestInvoice: {
          id: proration.id,
          status: "paid",
          billingReason: "subscription_update",
        },
      });

      expect(
        await changePlan({ workspaceId, planKey: "business" }, pay(fake), NOW),
      ).toEqual({ ok: true, kind: "unchanged" });
      expect(planCalls(fake)).toEqual([]);
      expect((await rowOf(workspaceId)).planKey).toBe("business");

      // Going on to Agency charges once, from Business: no "none" revert first.
      expect(
        await changePlan({ workspaceId, planKey: "agency" }, pay(fake), NOW),
      ).toMatchObject({ ok: true, kind: "upgraded" });
      expect(planCalls(fake)).toEqual(["always_invoice:agency"]);
      expect(
        [...fake.invoices.values()].filter(
          (invoice) => invoice.billingReason === "subscription_update",
        ),
      ).toHaveLength(2);
    });

    it("an upgrade Stripe has not been paid for yet is left alone", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        planKey: "business",
        productId: productIdForPlan("business"),
        latestInvoice: {
          id: "in_unpaid",
          status: "open",
          billingReason: "subscription_update",
        },
      });

      expect(
        await changePlan({ workspaceId, planKey: "agency" }, pay(fake), NOW),
      ).toMatchObject({ ok: false, error: "CHANGE_IN_PROGRESS" });
      expect(planCalls(fake)).toEqual([]);
      expect((await rowOf(workspaceId)).planKey).toBe("growth");
    });

    it("a billing interval changed outside the app is never pushed back (that would charge and reset the cycle)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, interval: "YEAR" });

      for (const planKey of ["business", "starter", "growth"] as const) {
        expect(
          await changePlan({ workspaceId, planKey }, pay(fake), NOW),
        ).toMatchObject({ ok: false, error: "BILLING_CHANGED_OUTSIDE" });
      }
      expect(planCalls(fake)).toEqual([]);
    });

    it("a subscription set to end cannot change plan, whichever side knows it first", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");

      // Stripe knows (the local row does not yet).
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        cancelAtPeriodEnd: true,
      });
      expect(
        await changePlan({ workspaceId, planKey: "business" }, pay(fake), NOW),
      ).toMatchObject({ ok: false, error: "SUBSCRIPTION_ENDING" });
      // Now the row knows too.
      expect((await rowOf(workspaceId)).cancelAtPeriodEnd).toBe(true);
      expect(
        await changePlan({ workspaceId, planKey: "starter" }, pay(fake), NOW),
      ).toMatchObject({ ok: false, error: "SUBSCRIPTION_ENDING" });
      expect(planCalls(fake)).toEqual([]);
    });

    it("an unknown outcome is never reported as 'nothing was changed': the state is re-read", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await subscribed(fake, workspaceId, "growth");

      // The network drops AFTER Stripe applied the downgrade.
      fake.failures.changePlanWhen = (input) => {
        const current = fake.subs.get(input.subscriptionId)!;
        fake.subs.set(current.id, {
          ...current,
          planKey: input.planKey,
          productId: productIdForPlan(input.planKey),
        });
        return new StripeNetworkError("response lost");
      };
      const result = await changePlan(
        { workspaceId, planKey: "starter" },
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "OUTCOME_UNKNOWN" });
      expect(result.ok === false && result.message).toMatch(
        /could not confirm/,
      );
      // The re-read already recorded the scheduled downgrade.
      expect((await rowOf(workspaceId)).pendingPlanKey).toBe("starter");

      // A provider 5xx is just as uncertain; a 4xx (not a card problem) is a clean refusal.
      fake.failures.changePlanWhen = () =>
        new StripeApiError({ status: 503, message: "unavailable" });
      expect(
        await changePlan({ workspaceId, planKey: "business" }, pay(fake), NOW),
      ).toMatchObject({ ok: false, error: "OUTCOME_UNKNOWN" });
      fake.failures.changePlanWhen = () =>
        new StripeApiError({
          status: 400,
          code: "parameter_invalid",
          message: "bad",
        });
      expect(
        await changePlan({ workspaceId, planKey: "business" }, pay(fake), NOW),
      ).toMatchObject({ ok: false, error: "PROVIDER_ERROR" });
    });

    it("cancelling with an unknown outcome says so too", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await subscribed(fake, workspaceId, "growth");
      fake.failures.cancel = undefined;
      const gateway = {
        ...fake.gateway,
        setCancelAtPeriodEnd: async () => {
          throw new StripeNetworkError("timeout");
        },
      };

      expect(
        await cancelAtPeriodEnd(workspaceId, { ...pay(fake), gateway }, NOW),
      ).toMatchObject({ ok: false, error: "OUTCOME_UNKNOWN" });
    });
  });

  describe("test and live data in one database", () => {
    async function testLinked(workspaceId: string) {
      const fake = createFakeStripe();
      await subscribed(fake, workspaceId, "growth");
      return fake;
    }

    it("a test-mode subscription does not block the real (live) payment or pretend to be changeable", async () => {
      const workspaceId = newWs();
      await testLinked(workspaceId);
      const live = createFakeStripe();

      // No live customer exists yet: the portal has nothing to open.
      expect(
        await openBillingPortal({ workspaceId }, pay(live, "live")),
      ).toMatchObject({ ok: false, error: "NO_CUSTOMER" });
      expect(
        await startSubscriptionCheckout(
          {
            workspaceId,
            planKey: "growth",
            interval: "MONTH",
            applyFirstMonth: false,
          },
          pay(live, "live"),
          NOW,
        ),
      ).toMatchObject({ ok: true });
      for (const result of [
        await changePlan(
          { workspaceId, planKey: "business" },
          pay(live, "live"),
          NOW,
        ),
        await cancelAtPeriodEnd(workspaceId, pay(live, "live"), NOW),
        await startPackCheckout(
          { workspaceId, packKey: "images20" },
          pay(live, "live"),
          NOW,
        ),
      ]) {
        expect(result.ok).toBe(false);
      }
      expect(live.callsNamed("changeSubscriptionPlan")).toHaveLength(0);
    });

    it("a live subscription is not replaced by a test payment, and test checkout is refused while it runs", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const live = await linked(fake, workspaceId, { livemode: true });
      expect(await rowOf(workspaceId)).toMatchObject({ stripeLivemode: true });

      const testSub = fake.subscription({
        customerId: `cus_t_${workspaceId}`,
        planKey: "starter",
        livemode: false,
        metadata: { workspaceId, intro: "0" },
      });
      const testPaid = fake.invoice({
        subscriptionId: testSub.id,
        customerId: `cus_t_${workspaceId}`,
        billingReason: "subscription_create",
      });
      const result = await syncSubscriptionState({
        workspaceId,
        sub: testSub,
        paid: testPaid,
        now: NOW,
      });
      expect(result).toEqual({
        applied: false,
        note: "live-subscription-exists",
      });
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "growth",
        stripeSubscriptionId: live.sub.id,
        stripeLivemode: true,
      });

      expect(
        await startSubscriptionCheckout(
          {
            workspaceId,
            planKey: "starter",
            interval: "MONTH",
            applyFirstMonth: false,
          },
          pay(fake, "test"),
          NOW,
        ),
      ).toMatchObject({ ok: false, error: "ALREADY_SUBSCRIBED" });
    });

    it("a live payment replaces a leftover test link", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await linked(fake, workspaceId, { livemode: false });
      const liveSub = fake.subscription({
        customerId: `cus_l_${workspaceId}`,
        planKey: "business",
        livemode: true,
        metadata: { workspaceId, intro: "0" },
      });
      const livePaid = fake.invoice({
        subscriptionId: liveSub.id,
        customerId: `cus_l_${workspaceId}`,
        billingReason: "subscription_create",
        livemode: true,
      });

      const result = await syncSubscriptionState({
        workspaceId,
        sub: liveSub,
        paid: livePaid,
        now: NOW,
      });

      expect(result).toMatchObject({ applied: true });
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        stripeLivemode: true,
        stripeSubscriptionId: liveSub.id,
      });
    });
  });

  describe("buying while a subscription looks active", () => {
    const subscribeInput = (workspaceId: string) => ({
      workspaceId,
      planKey: "growth" as const,
      interval: "MONTH" as const,
      applyFirstMonth: false,
    });

    it("asks Stripe first: a subscription that already ended there no longer blocks re-subscribing", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");

      // Alive in Stripe: refused.
      expect(
        await startSubscriptionCheckout(
          subscribeInput(workspaceId),
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: false, error: "ALREADY_SUBSCRIBED" });

      // The cancellation event was lost; Stripe says it ended.
      fake.subs.set(sub.id, {
        ...fake.subs.get(sub.id)!,
        status: "canceled",
        endedAt: NOW,
        cancellationReason: "cancellation_requested",
      });
      expect(
        await startSubscriptionCheckout(
          subscribeInput(workspaceId),
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: true });
      expect((await rowOf(workspaceId)).status).toBe("CANCELED");
    });

    it("a failing payment tells the customer to fix the payment method, not that they are subscribed", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, status: "past_due" });
      await syncSubscriptionState({
        workspaceId,
        sub: fake.subs.get(sub.id)!,
        now: NOW,
      });

      expect(
        await startSubscriptionCheckout(
          subscribeInput(workspaceId),
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: false, error: "PAYMENT_PROBLEM" });
    });

    it("extra packs are not sold to an exempt workspace, or to one whose access has already ended", async () => {
      const fake = createFakeStripe();
      const exempt = newWs();
      await prisma.subscription.create({
        data: { workspaceId: exempt, status: "LEGACY", exempt: true },
      });
      expect(
        await startPackCheckout(
          { workspaceId: exempt, packKey: "images20" },
          pay(fake),
          NOW,
        ),
      ).toMatchObject({ ok: false, error: "FULL_ACCESS" });
      expect(
        await startSubscriptionCheckout(subscribeInput(exempt), pay(fake), NOW),
      ).toMatchObject({ ok: false, error: "FULL_ACCESS" });

      const workspaceId = newWs();
      const { sub } = await subscribed(fake, workspaceId, "growth");
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, status: "past_due" });
      await syncSubscriptionState({
        workspaceId,
        sub: fake.subs.get(sub.id)!,
        now: NOW,
      });
      // Inside the 3-day grace the plan still works...
      expect(
        await startPackCheckout(
          { workspaceId, packKey: "images20" },
          pay(fake),
          new Date(NOW.getTime() + DAY),
        ),
      ).toMatchObject({ ok: true });
      // ...after it the pack could not be spent.
      expect(
        await startPackCheckout(
          { workspaceId, packKey: "images20" },
          pay(fake),
          new Date(NOW.getTime() + 4 * DAY),
        ),
      ).toMatchObject({ ok: false, error: "PLAN_REQUIRED" });
    });
  });

  describe("Stripe already holds the subscription", () => {
    const subscribeInput = (workspaceId: string) => ({
      workspaceId,
      planKey: "growth" as const,
      interval: "MONTH" as const,
      applyFirstMonth: false,
    });

    it("a paid subscription the webhook never delivered is linked instead of opening a second checkout", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await checkedOut(fake, workspaceId);
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId } }),
      ).toBeNull();

      const result = await startSubscriptionCheckout(
        subscribeInput(workspaceId),
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: false, error: "ALREADY_SUBSCRIBED" });
      expect(fake.callsNamed("createSubscriptionCheckout")).toHaveLength(0);
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        stripeSubscriptionId: sub.id,
      });
    });

    it("a failing subscription says to fix the payment method; an ended one does not block; an unreadable Stripe does", async () => {
      const failing = createFakeStripe();
      const failingWs = newWs();
      const first = await checkedOut(failing, failingWs);
      failing.subs.set(first.sub.id, { ...first.sub, status: "past_due" });
      expect(
        await startSubscriptionCheckout(
          subscribeInput(failingWs),
          pay(failing),
          NOW,
        ),
      ).toMatchObject({ ok: false, error: "PAYMENT_PROBLEM" });

      const ended = createFakeStripe();
      const endedWs = newWs();
      const old = await checkedOut(ended, endedWs);
      ended.subs.set(old.sub.id, { ...old.sub, status: "canceled" });
      expect(
        await startSubscriptionCheckout(
          subscribeInput(endedWs),
          pay(ended),
          NOW,
        ),
      ).toMatchObject({ ok: true });

      const down = createFakeStripe();
      const downWs = newWs();
      await checkedOut(down, downWs);
      down.failures.read = new StripeNetworkError("unreachable");
      expect(
        await startSubscriptionCheckout(subscribeInput(downWs), pay(down), NOW),
      ).toMatchObject({ ok: false, error: "PROVIDER_ERROR" });
      expect(down.callsNamed("createSubscriptionCheckout")).toHaveLength(0);
    });

    it("a workspace with no Stripe customer yet costs no extra Stripe read", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();

      const result = await startSubscriptionCheckout(
        subscribeInput(workspaceId),
        pay(fake),
        NOW,
      );

      expect(result).toMatchObject({ ok: true });
      expect(fake.callsNamed("listSubscriptions")).toHaveLength(0);
    });
  });

  describe("what the customer is told when Stripe refuses", () => {
    const failWith = async (error: StripeApiError) => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await subscribed(fake, workspaceId, "growth");
      fake.failures.changePlanWhen = () => error;
      return changePlan({ workspaceId, planKey: "business" }, pay(fake), NOW);
    };

    it("a bank that wants extra verification is a card problem even when Stripe does not type it as one", async () => {
      for (const error of [
        new StripeApiError({
          status: 402,
          code: "invoice_payment_intent_requires_action",
          message: "needs action",
        }),
        new StripeApiError({
          status: 400,
          code: "authentication_required",
          message: "needs authentication",
        }),
      ]) {
        expect(await failWith(error)).toMatchObject({
          ok: false,
          error: "CARD_DECLINED",
        });
      }
    });

    it("a problem only the owner can fix says 'unavailable' and leaves a tagged line in the log", async () => {
      for (const error of [
        new StripeApiError({ status: 401, message: "Invalid API Key" }),
        new StripeApiError({
          status: 400,
          code: "testmode_charges_only",
          message: "live account not activated",
        }),
        new StripeApiError({
          status: 400,
          message:
            "No configuration provided and your test mode default configuration has not been created.",
        }),
      ]) {
        vi.mocked(console.error).mockClear();
        const result = await failWith(error);
        expect(result).toMatchObject({
          ok: false,
          error: "BILLING_UNAVAILABLE",
        });
        // Only a log line exists (no alerting): the customer is not promised that anyone was told.
        expect(result.ok === false && result.message).toMatch(
          /temporarily unavailable/,
        );
        expect(result.ok === false && result.message).not.toMatch(/notified/);
        expect(
          vi
            .mocked(console.error)
            .mock.calls.some((call) =>
              String(call[0]).includes("[billing][operator-action]"),
            ),
        ).toBe(true);
      }
    });

    it("anything else stays a plain 'try again' and never leaks Stripe's own words", async () => {
      const result = await failWith(
        new StripeApiError({
          status: 400,
          code: "parameter_invalid",
          message: "secret detail",
        }),
      );
      expect(result).toMatchObject({ ok: false, error: "PROVIDER_ERROR" });
      expect(result.ok === false && result.message).not.toContain(
        "secret detail",
      );
    });
  });

  describe("packs refunded at the same time", () => {
    it("a partial and a full refund of one pack arriving together take back exactly that pack", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const pack = EXTRA_PACKS.images20;
      for (const reference of ["pi_a", "pi_b"]) {
        await grantExtraPack({
          workspaceId,
          packKey: "images20",
          reference: `${reference}_${workspaceId}`,
          now: NOW,
        });
      }
      const reference = `pi_a_${workspaceId}`;
      const half = fake.charge({
        amount: pack.priceCents,
        amountRefunded: pack.priceCents / 2,
      });
      const full = fake.charge({
        amount: pack.priceCents,
        amountRefunded: pack.priceCents,
        refunded: true,
      });

      await Promise.all(
        [half, full].map((charge) =>
          reconcilePackRefund({
            workspaceId,
            packKey: "images20",
            reference,
            charge,
            now: NOW,
          }),
        ),
      );

      const balance = await prisma.usageBalance.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
      });
      expect(Number(balance.extraGranted)).toBe(
        2 * Number(pack.amount) - Number(pack.amount),
      );
      const revoked = await prisma.usageGrant.findMany({
        where: { workspaceId, reason: "REFUND", unit: "IMAGE" },
      });
      expect(revoked.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(
        -Number(pack.amount),
      );
    });
  });

  describe("the Checkout return address", () => {
    it("never reaches Stripe for a workspace that has no Stripe customer", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(
          await reconcileCheckoutReturn(
            { workspaceId, sessionId: `cs_test_guess${attempt}abcdef` },
            pay(fake),
            NOW,
          ),
        ).toBe("unknown");
      }
      expect(fake.calls).toHaveLength(0);
    });

    it("a session of another customer is not applied", async () => {
      const fake = createFakeStripe();
      const mine = newWs();
      const theirs = newWs();
      await customerFor(mine);
      const other = await checkedOut(fake, theirs);

      expect(
        await reconcileCheckoutReturn(
          { workspaceId: mine, sessionId: other.session.id },
          pay(fake),
          NOW,
        ),
      ).toBe("unknown");
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId: mine } }),
      ).toBeNull();
      expect(
        await prisma.subscription.findUnique({
          where: { workspaceId: theirs },
        }),
      ).toBeNull();
    });
  });
});
