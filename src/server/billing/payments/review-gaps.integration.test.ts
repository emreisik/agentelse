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
import { EXTRA_PACKS, quotaFor, type PlanKey } from "@/lib/billing/plans";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { ensurePeriod, revokeUsage } from "../ledger";
import type { StripeEventEnvelope } from "../stripe/facts";
import { processStripeEvent } from "./events";
import { endSubscriptionAfterRefund } from "./refunds";
import {
  changePlan,
  listWorkspaceInvoices,
  openBillingPortal,
  reconcileCheckoutReturn,
  startPackCheckout,
  startSubscriptionCheckout,
  type PaymentDeps,
} from "./service";
import { PENDING_SLACK_MS, syncSubscriptionState } from "./subscription-state";
import {
  createFakeStripe,
  T0,
  T1,
  type FakeStripe,
} from "./test-support/fake-stripe";

// Gaps found by the mutation review of Faz 4 (each test here fails against a
// one-line mutant of the production code that the original suites let through).
// Real Postgres; Stripe is the in-memory fake.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_gap_${runId}_${++counter}`;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const T2 = new Date("2027-01-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const fixtures: AgencyFixture[] = [];

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });

async function period(
  workspaceId: string,
  unit: "IMAGE" | "AI_MICROS" = "IMAGE",
) {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  return {
    granted: Number(row.periodGranted),
    used: Number(row.periodUsed),
    reserved: Number(row.periodReserved),
    start: row.periodStart,
    extra: Number(row.extraGranted),
  };
}

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
const paymentDeps = (fake: FakeStripe): PaymentDeps => ({
  gateway: fake.gateway,
  mode: "test",
  appUrl: "https://app.test",
});

async function customerFor(workspaceId: string) {
  const stripeCustomerId = `cus_${workspaceId}`;
  await prisma.billingCustomer.create({
    data: { workspaceId, livemode: false, stripeCustomerId },
  });
  return stripeCustomerId;
}

async function payFirst(
  fake: FakeStripe,
  workspaceId: string,
  planKey: PlanKey = "growth",
  options: { intro?: boolean; billingReason?: string; periodEnd?: Date } = {},
) {
  const customerId = `cus_${workspaceId}`;
  const sub = fake.subscription({
    customerId,
    planKey,
    metadata: { workspaceId, intro: options.intro ? "1" : "0" },
  });
  const paid = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: options.billingReason ?? "subscription_create",
    periodEnd: options.periodEnd ?? T1,
  });
  await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
  return { sub, paid, customerId };
}

// An upgrade as Stripe reports it: the item changed, the proration invoice is paid.
function upgradedTo(
  fake: FakeStripe,
  sub: ReturnType<FakeStripe["subscription"]>,
  planKey: PlanKey,
) {
  const proration = fake.invoice({
    subscriptionId: sub.id,
    customerId: sub.customerId,
    billingReason: "subscription_update",
    periodStart: null,
    periodEnd: null,
    hasProration: true,
  });
  return {
    ...sub,
    planKey,
    productId: `agentelse_plan_${planKey}`,
    latestInvoice: {
      id: proration.id,
      status: "paid",
      billingReason: "subscription_update",
    },
  };
}

describeIntegration("review gaps: payments", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_gap_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.billingCustomer.deleteMany({ where });
    await prisma.billingEvent.deleteMany({ where });
    for (const fixture of fixtures.splice(0)) {
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  describe("a second upgrade between the same two plans is paid for and granted", () => {
    it("upgrade, scheduled downgrade applied at renewal, upgrade again: two grants, one per proration invoice", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await payFirst(fake, workspaceId, "starter");

      // Month 1: starter -> growth (invoice A).
      const first = upgradedTo(fake, sub, "growth");
      await syncSubscriptionState({ workspaceId, sub: first, now: NOW });
      expect((await rowOf(workspaceId)).planKey).toBe("growth");

      // Back down: scheduled for the renewal, applied by the renewal invoice.
      const lower = {
        ...first,
        planKey: "starter" as const,
        productId: "agentelse_plan_starter",
      };
      await syncSubscriptionState({ workspaceId, sub: lower, now: NOW });
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });
      await syncSubscriptionState({
        workspaceId,
        sub: lower,
        paid: renewal,
        now: new Date("2026-12-01T00:30:00.000Z"),
      });
      expect((await rowOf(workspaceId)).planKey).toBe("starter");

      // Month 2: starter -> growth again (invoice B).
      const second = upgradedTo(fake, lower, "growth");
      await syncSubscriptionState({
        workspaceId,
        sub: second,
        now: new Date("2026-12-10T00:00:00.000Z"),
      });

      expect((await rowOf(workspaceId)).planKey).toBe("growth");
      const grants = await prisma.usageGrant.findMany({
        where: { workspaceId, reason: "PLAN_CHANGE", unit: "IMAGE" },
        orderBy: { createdAt: "asc" },
      });
      expect(grants).toHaveLength(2);
      expect(new Set(grants.map((grant) => grant.idempotencyKey)).size).toBe(2);
      // The second month's window holds the starter quota plus the second grant.
      expect((await period(workspaceId)).granted).toBe(
        quotaFor("starter").IMAGE + Number(grants[1]!.amount),
      );
    });
  });

  describe("a payment that is failing still counts as a paying subscription", () => {
    it("a second paid subscription is refused while the first is PAST_DUE", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const first = await payFirst(fake, workspaceId);
      await syncSubscriptionState({
        workspaceId,
        sub: { ...first.sub, status: "past_due" },
        now: new Date("2026-12-01T09:00:00.000Z"),
      });
      expect((await rowOf(workspaceId)).status).toBe("PAST_DUE");
      const second = fake.subscription({
        customerId: first.customerId,
        planKey: "business",
        metadata: { workspaceId, intro: "0" },
      });
      const paid = fake.invoice({
        subscriptionId: second.id,
        customerId: first.customerId,
        billingReason: "subscription_create",
      });

      const result = await syncSubscriptionState({
        workspaceId,
        sub: second,
        paid,
        now: new Date("2026-12-02T09:00:00.000Z"),
      });

      expect(result).toEqual({
        applied: false,
        note: "duplicate-subscription",
      });
      expect((await rowOf(workspaceId)).stripeSubscriptionId).toBe(
        first.sub.id,
      );
    });

    it("Checkout is not opened for a PAST_DUE subscription (fix the card instead), and a pack can be bought only inside the grace period", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await customerFor(workspaceId);
      const { sub } = await payFirst(fake, workspaceId);
      // Stripe also reports the failing payment (the checkout asks Stripe before refusing).
      fake.subs.set(sub.id, { ...fake.subs.get(sub.id)!, status: "past_due" });
      await prisma.subscription.update({
        where: { workspaceId },
        data: {
          status: "PAST_DUE",
          graceUntil: new Date(NOW.getTime() + 2 * 24 * HOUR),
        },
      });

      expect(
        await startSubscriptionCheckout(
          {
            workspaceId,
            planKey: "business",
            interval: "MONTH",
            applyFirstMonth: false,
          },
          paymentDeps(fake),
        ),
      ).toMatchObject({ ok: false, error: "PAYMENT_PROBLEM" });
      expect(
        (
          await startPackCheckout(
            { workspaceId, packKey: "images20" },
            paymentDeps(fake),
            NOW,
          )
        ).ok,
      ).toBe(true);
      // After the grace period the plan no longer works, so a pack could not be spent.
      expect(
        await startPackCheckout(
          { workspaceId, packKey: "images20" },
          paymentDeps(fake),
          new Date(NOW.getTime() + 3 * 24 * HOUR),
        ),
      ).toMatchObject({ ok: false, error: "PLAN_REQUIRED" });
    });
  });

  describe("the intro month belongs to the FIRST invoice only", () => {
    it("a subscription first seen through a renewal invoice gets the full window even if its metadata says intro", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();

      await payFirst(fake, workspaceId, "business", {
        intro: true,
        billingReason: "subscription_cycle",
      });

      expect(await rowOf(workspaceId)).toMatchObject({
        introOffer: false,
        periodIndex: 2,
      });
      expect((await period(workspaceId)).granted).toBe(
        quotaFor("business").IMAGE,
      );
    });
  });

  describe("a scheduled downgrade is applied at the window boundary even when Stripe's period ends a little later", () => {
    it("paid through 2h after the window start: the downgrade still applies when the next window opens", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const stripeEnd = new Date(T1.getTime() + 2 * HOUR);
      const { sub } = await payFirst(fake, workspaceId, "business", {
        periodEnd: stripeEnd,
      });
      const lower = {
        ...sub,
        planKey: "growth" as const,
        productId: "agentelse_plan_growth",
      };
      await syncSubscriptionState({ workspaceId, sub: lower, now: NOW });
      const scheduled = await rowOf(workspaceId);
      expect(scheduled.pendingEffectiveAt).toEqual(
        new Date(stripeEnd.getTime() - 6 * HOUR),
      );
      // Pinned to a literal: the slack is a documented 6 hours, not "whatever the constant is".
      expect(PENDING_SLACK_MS).toBe(6 * HOUR);

      await ensurePeriod(workspaceId, {
        now: new Date(T1.getTime() + 10 * 60_000),
      });

      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "growth",
        pendingPlanKey: null,
      });
      expect((await period(workspaceId)).granted).toBe(
        quotaFor("growth").IMAGE,
      );
    });
  });

  describe("an invoice that moves no money forward leaves intro/pending state alone", () => {
    it("a canceled subscription loses its scheduled change", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await payFirst(fake, workspaceId, "business");
      const lower = {
        ...sub,
        planKey: "growth" as const,
        productId: "agentelse_plan_growth",
      };
      await syncSubscriptionState({ workspaceId, sub: lower, now: NOW });
      expect((await rowOf(workspaceId)).pendingPlanKey).toBe("growth");

      await syncSubscriptionState({
        workspaceId,
        sub: { ...lower, status: "canceled", endedAt: NOW },
        now: NOW,
      });

      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        pendingPlanKey: null,
        pendingInterval: null,
        pendingEffectiveAt: null,
      });
    });

    it("Stripe's `unpaid` status is a payment problem, like past_due", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = await payFirst(fake, workspaceId);

      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, status: "unpaid" },
        now: new Date("2026-12-01T09:00:00.000Z"),
      });

      expect((await rowOf(workspaceId)).status).toBe("PAST_DUE");
    });
  });

  describe("whose payment is it: every event path checks the customer against the metadata", () => {
    async function linked(fake: FakeStripe, owner: string) {
      const customerId = await customerFor(owner);
      const sub = fake.subscription({
        customerId,
        planKey: "growth",
        metadata: { workspaceId: owner, intro: "0" },
      });
      const invoice = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_create",
        chargeId: undefined,
      });
      await syncSubscriptionState({
        workspaceId: owner,
        sub,
        paid: invoice,
        now: NOW,
      });
      return { customerId, sub, invoice };
    }

    it("customer.subscription.* with metadata naming another workspace changes nothing", async () => {
      const fake = createFakeStripe();
      const owner = newWs();
      const attacker = newWs();
      const { sub } = await linked(fake, owner);
      fake.subs.set(sub.id, {
        ...sub,
        status: "canceled",
        endedAt: NOW,
        metadata: { workspaceId: attacker },
      });

      const outcome = await processStripeEvent(
        evt("customer.subscription.deleted", sub.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "tenant-mismatch" });
      expect((await rowOf(owner)).status).toBe("ACTIVE");
    });

    it("a full refund whose subscription metadata names another workspace does not end the subscription", async () => {
      const fake = createFakeStripe();
      const owner = newWs();
      const { customerId, sub, invoice } = await linked(fake, owner);
      fake.subs.set(sub.id, { ...sub, metadata: { workspaceId: newWs() } });
      const charge = fake.charge({
        amount: 14_900,
        amountRefunded: 14_900,
        refunded: true,
        invoiceId: invoice.id,
        customerId,
      });

      const outcome = await processStripeEvent(
        evt("charge.refunded", charge.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "tenant-mismatch" });
      expect((await rowOf(owner)).status).toBe("ACTIVE");
      expect(fake.callsNamed("cancelSubscriptionNow")).toHaveLength(0);
    });

    it("a pack refund whose payment intent names another workspace takes nothing back", async () => {
      const fake = createFakeStripe();
      const owner = newWs();
      const customerId = await customerFor(owner);
      const intent = fake.intent({
        customerId,
        metadata: { kind: "pack", pack: "images20", workspaceId: owner },
      });
      const session = fake.session({
        mode: "payment",
        customerId,
        paymentIntentId: intent.id,
        clientReferenceId: owner,
        metadata: { kind: "pack", pack: "images20", workspaceId: owner },
      });
      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      fake.intents.set(intent.id, {
        ...intent,
        metadata: { kind: "pack", pack: "images20", workspaceId: newWs() },
      });
      const charge = fake.charge({
        amount: EXTRA_PACKS.images20.priceCents,
        amountRefunded: EXTRA_PACKS.images20.priceCents,
        refunded: true,
        paymentIntentId: intent.id,
      });

      const outcome = await processStripeEvent(
        evt("charge.refunded", charge.id),
        deps(fake),
      );

      expect(outcome).toEqual({ result: "ignored", note: "tenant-mismatch" });
      expect((await period(owner)).extra).toBe(EXTRA_PACKS.images20.amount);
    });
  });

  describe("a refund or chargeback that arrives as a webhook takes the unused allowance back", () => {
    async function paidWorkspace() {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const customerId = await customerFor(workspaceId);
      const { sub, paid } = await payFirst(fake, workspaceId);
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        data: { periodUsed: BigInt(7) },
      });
      const charge = fake.charge({
        amount: 14_900,
        invoiceId: paid.id,
        customerId,
      });
      return { fake, workspaceId, sub, charge };
    }

    it("charge.refunded (full): access ends, exactly one reversal per unit, what was used stays", async () => {
      const { fake, workspaceId, charge } = await paidWorkspace();
      fake.charges.set(charge.id, {
        ...charge,
        amountRefunded: charge.amount,
        refunded: true,
      });

      await processStripeEvent(evt("charge.refunded", charge.id), deps(fake));

      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "REFUNDED",
      });
      expect(await period(workspaceId)).toMatchObject({ granted: 7, used: 7 });
      expect(await period(workspaceId, "AI_MICROS")).toMatchObject({
        granted: 0,
      });
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "REFUND", unit: "IMAGE" },
        }),
      ).toBe(1);
    });

    it("charge.dispute.created: the same, recorded as a chargeback", async () => {
      const { fake, workspaceId, charge } = await paidWorkspace();
      const dispute = fake.dispute({ chargeId: charge.id });

      await processStripeEvent(
        evt("charge.dispute.created", dispute.id),
        deps(fake),
      );

      expect(await rowOf(workspaceId)).toMatchObject({
        status: "CANCELED",
        endedReason: "CHARGEBACK",
      });
      expect(await period(workspaceId)).toMatchObject({ granted: 7, used: 7 });
    });
  });

  describe("events that need a person to look are logged loudly", () => {
    it("a second paid subscription (manual refund needed) and a tenant mismatch reach the error log", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const customerId = await customerFor(workspaceId);
      const first = await payFirst(fake, workspaceId);
      const second = fake.subscription({
        customerId,
        planKey: "business",
        metadata: { workspaceId, intro: "0" },
      });
      const invoice = fake.invoice({
        subscriptionId: second.id,
        customerId,
        billingReason: "subscription_create",
      });
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const outcome = await processStripeEvent(
        evt("invoice.paid", invoice.id),
        deps(fake),
      );

      expect(outcome).toEqual({
        result: "ignored",
        note: "duplicate-subscription",
      });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("duplicate-subscription"),
      );
      expect((await rowOf(workspaceId)).stripeSubscriptionId).toBe(
        first.sub.id,
      );
      log.mockRestore();
    });
  });

  describe("the Stripe customer of a workspace is created once, even when two checkouts race", () => {
    it("both checkouts use the one customer that was stored", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();

      const [a, b] = await Promise.all(
        [0, 1].map(() =>
          startSubscriptionCheckout(
            {
              workspaceId,
              planKey: "growth",
              interval: "MONTH",
              applyFirstMonth: false,
            },
            paymentDeps(fake),
          ),
        ),
      );

      expect(a!.ok).toBe(true);
      expect(b!.ok).toBe(true);
      const rows = await prisma.billingCustomer.findMany({
        where: { workspaceId },
      });
      expect(rows).toHaveLength(1);
      const used = fake
        .callsNamed("createSubscriptionCheckout")
        .map((call) => (call.args as { customerId: string }).customerId);
      expect(new Set(used)).toEqual(new Set([rows[0]!.stripeCustomerId]));
    });
  });

  describe("a yearly subscription: the paid year, the monthly allowance", () => {
    const YEAR_END = new Date("2027-11-01T00:00:00.000Z");
    async function yearly(
      fake: FakeStripe,
      workspaceId: string,
      planKey: PlanKey,
    ) {
      const customerId = `cus_${workspaceId}`;
      const sub = fake.subscription({
        customerId,
        planKey,
        interval: "YEAR",
        currentPeriodEnd: YEAR_END,
        metadata: { workspaceId, intro: "0" },
      });
      const paid = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_create",
        periodEnd: YEAR_END,
      });
      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
      return sub;
    }

    it("pays for twelve months, opens a month of allowance at a time, and schedules a downgrade for the year's end", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await yearly(fake, workspaceId, "business");
      expect(await rowOf(workspaceId)).toMatchObject({
        interval: "YEAR",
        paidThrough: YEAR_END,
      });

      // Two months later no payment was made, and the third month's allowance opens.
      const monthThree = new Date("2027-01-10T00:00:00.000Z");
      await ensurePeriod(workspaceId, { now: monthThree });
      expect(await period(workspaceId)).toMatchObject({
        granted: quotaFor("business").IMAGE,
        start: new Date("2027-01-01T00:00:00.000Z"),
      });

      // A downgrade chosen now starts a year after it was paid for, not next month.
      const lower = {
        ...sub,
        planKey: "growth" as const,
        productId: "agentelse_plan_growth",
      };
      await syncSubscriptionState({ workspaceId, sub: lower, now: monthThree });
      expect((await rowOf(workspaceId)).pendingEffectiveAt).toEqual(
        new Date(YEAR_END.getTime() - 6 * HOUR),
      );
      await ensurePeriod(workspaceId, {
        now: new Date("2027-02-10T00:00:00.000Z"),
      });
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        pendingPlanKey: "growth",
      });
    });

    it("changing plans keeps the yearly interval", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await customerFor(workspaceId);
      await yearly(fake, workspaceId, "business");

      const result = await changePlan(
        { workspaceId, planKey: "agency" },
        paymentDeps(fake),
        NOW,
      );

      expect(result).toEqual({ ok: true, kind: "upgraded" });
      expect(fake.callsNamed("changeSubscriptionPlan")[0]!.args).toMatchObject({
        planKey: "agency",
        interval: "YEAR",
        proration: "always_invoice",
      });
      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "agency",
        interval: "YEAR",
      });
    });
  });

  describe("restoring a yearly plan before an upgrade", () => {
    it("the no-money revert and the upgrade both stay on the yearly interval", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await customerFor(workspaceId);
      const customerId = `cus_${workspaceId}`;
      const yearEnd = new Date("2027-11-01T00:00:00.000Z");
      const sub = fake.subscription({
        customerId,
        planKey: "business",
        interval: "YEAR",
        currentPeriodEnd: yearEnd,
        metadata: { workspaceId, intro: "0" },
      });
      const paid = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_create",
        periodEnd: yearEnd,
      });
      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
      await changePlan(
        { workspaceId, planKey: "growth" },
        paymentDeps(fake),
        NOW,
      );

      const result = await changePlan(
        { workspaceId, planKey: "agency" },
        paymentDeps(fake),
        NOW,
      );

      expect(result).toEqual({ ok: true, kind: "upgraded" });
      expect(
        fake.callsNamed("changeSubscriptionPlan").map((call) => call.args),
      ).toEqual([
        expect.objectContaining({
          planKey: "growth",
          interval: "YEAR",
          proration: "none",
        }),
        expect.objectContaining({
          planKey: "business",
          interval: "YEAR",
          proration: "none",
        }),
        expect.objectContaining({
          planKey: "agency",
          interval: "YEAR",
          proration: "always_invoice",
        }),
      ]);
    });
  });

  describe("test mode and live mode are separate customers of the same workspace", () => {
    const liveDeps = (fake: FakeStripe): PaymentDeps => ({
      ...paymentDeps(fake),
      mode: "live",
    });

    it("a live checkout never reuses the test-mode customer, and the portal only sees its own mode", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      await customerFor(workspaceId); // the test-mode customer

      expect(
        await openBillingPortal({ workspaceId }, liveDeps(fake)),
      ).toMatchObject({
        ok: false,
        error: "NO_CUSTOMER",
      });
      const checkout = await startSubscriptionCheckout(
        {
          workspaceId,
          planKey: "growth",
          interval: "MONTH",
          applyFirstMonth: false,
        },
        liveDeps(fake),
      );

      expect(checkout.ok).toBe(true);
      const rows = await prisma.billingCustomer.findMany({
        where: { workspaceId },
        orderBy: { livemode: "asc" },
      });
      expect(rows.map((row) => row.livemode)).toEqual([false, true]);
      const used = (
        fake.callsNamed("createSubscriptionCheckout")[0]!.args as {
          customerId: string;
        }
      ).customerId;
      expect(used).toBe(rows[1]!.stripeCustomerId);
      expect(used).not.toBe(rows[0]!.stripeCustomerId);
      expect(
        await openBillingPortal({ workspaceId }, liveDeps(fake)),
      ).toMatchObject({
        ok: true,
      });
      expect(fake.callsNamed("createPortalSession")[0]!.args).toMatchObject({
        customerId: rows[1]!.stripeCustomerId,
      });
    });

    it("returning from a live checkout looks the customer up in live mode, and invoices likewise", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const testCustomer = await customerFor(workspaceId);
      const session = fake.session({
        id: "cs_live_livemodesession1",
        mode: "subscription",
        customerId: testCustomer,
        clientReferenceId: workspaceId,
      });

      // The only customer is a test-mode one: a live return must not accept it.
      expect(
        await reconcileCheckoutReturn(
          { workspaceId, sessionId: session.id },
          liveDeps(fake),
          NOW,
        ),
      ).toBe("unknown");
      expect(
        await listWorkspaceInvoices({ workspaceId }, liveDeps(fake)),
      ).toEqual({ rows: [], failed: false });
      expect(fake.callsNamed("listInvoices")).toHaveLength(0);
    });
  });

  describe("a fully discounted pack (no payment intent)", () => {
    it("is granted when Stripe says no payment is required, keyed by its own session, once per session", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const customerId = await customerFor(workspaceId);
      const free = () =>
        fake.session({
          mode: "payment",
          paymentStatus: "no_payment_required",
          customerId,
          paymentIntentId: null,
          clientReferenceId: workspaceId,
          metadata: { kind: "pack", pack: "images20", workspaceId },
        });
      const first = free();
      const second = free();

      await processStripeEvent(
        evt("checkout.session.completed", first.id),
        deps(fake),
      );
      await processStripeEvent(
        evt("checkout.session.completed", first.id),
        deps(fake),
      );
      expect((await period(workspaceId)).extra).toBe(
        EXTRA_PACKS.images20.amount,
      );

      await processStripeEvent(
        evt("checkout.session.completed", second.id),
        deps(fake),
      );
      expect((await period(workspaceId)).extra).toBe(
        2 * EXTRA_PACKS.images20.amount,
      );
      const keys = (
        await prisma.usageGrant.findMany({
          where: { workspaceId, reason: "PURCHASE", unit: "IMAGE" },
        })
      ).map((grant) => grant.idempotencyKey);
      expect(keys.sort()).toEqual(
        [`pack:${first.id}`, `pack:${second.id}`].sort(),
      );
    });
  });

  describe("a chargeback on a pack", () => {
    it("takes the whole pack back even though the charge shows no refund yet", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
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
      });
      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );
      expect((await period(workspaceId)).extra).toBe(
        EXTRA_PACKS.images20.amount,
      );
      const charge = fake.charge({
        amount: EXTRA_PACKS.images20.priceCents,
        amountRefunded: 0,
        paymentIntentId: intent.id,
      });
      const dispute = fake.dispute({ chargeId: charge.id });

      await processStripeEvent(
        evt("charge.dispute.created", dispute.id),
        deps(fake),
      );

      expect((await period(workspaceId)).extra).toBe(0);
    });
  });

  describe("a refund after a re-payment takes back the NEW window's unused allowance", () => {
    it("refund -> new payment -> refund of the new invoice: both windows end up used-only", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = await payFirst(fake, workspaceId);
      await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice: paid,
        reason: "REFUNDED",
        now: NOW,
      });
      expect((await period(workspaceId)).granted).toBe(0);

      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });
      const renewedAt = new Date("2026-12-01T01:00:00.000Z");
      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: renewal,
        now: renewedAt,
      });
      expect((await period(workspaceId)).granted).toBe(
        quotaFor("growth").IMAGE,
      );

      await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice: renewal,
        reason: "REFUNDED",
        now: new Date("2026-12-05T00:00:00.000Z"),
      });

      expect((await period(workspaceId)).granted).toBe(0);
      const keys = (
        await prisma.usageGrant.findMany({
          where: { workspaceId, reason: "REFUND", unit: "IMAGE" },
        })
      ).map((grant) => grant.idempotencyKey);
      expect(new Set(keys).size).toBe(2);
    });
  });

  describe("revoking from a window that has reservations", () => {
    it("never takes back what is reserved, in the PERIOD pool either", async () => {
      const workspaceId = newWs();
      await prisma.usageBalance.create({
        data: {
          id: randomUUID(),
          workspaceId,
          unit: "IMAGE",
          periodStart: T0,
          periodEnd: T1,
          periodGranted: BigInt(50),
          periodUsed: BigInt(10),
          periodReserved: BigInt(5),
          updatedAt: NOW,
        },
      });

      const result = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "PERIOD",
        amount: "ALL_UNUSED",
        idempotencyKey: "refund:reserved",
        periodStart: T0,
        now: NOW,
      });

      expect(result).toEqual({ revoked: BigInt(35) });
      expect(await period(workspaceId)).toMatchObject({
        granted: 15,
        used: 10,
        reserved: 5,
      });
    });

    it("a PERIOD revoke of a stated amount takes that amount, not everything unused", async () => {
      const workspaceId = newWs();
      await prisma.usageBalance.create({
        data: {
          id: randomUUID(),
          workspaceId,
          unit: "IMAGE",
          periodStart: T0,
          periodEnd: T1,
          periodGranted: BigInt(50),
          periodUsed: BigInt(10),
          updatedAt: NOW,
        },
      });

      const result = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "PERIOD",
        amount: 5,
        idempotencyKey: "refund:five",
        periodStart: T0,
        now: NOW,
      });

      expect(result).toEqual({ revoked: BigInt(5) });
      expect((await period(workspaceId)).granted).toBe(45);
    });
  });

  describe("returning from Checkout", () => {
    it("does not process a session that belongs to another workspace's customer, even for a workspace that has a customer of its own", async () => {
      const fake = createFakeStripe();
      const owner = newWs();
      const other = newWs();
      const ownerCustomer = await customerFor(owner);
      await customerFor(other);
      const sub = fake.subscription({
        customerId: ownerCustomer,
        planKey: "growth",
        metadata: { workspaceId: owner },
      });
      const invoice = fake.invoice({
        subscriptionId: sub.id,
        customerId: ownerCustomer,
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
        id: "cs_test_foreignsession1",
        mode: "subscription",
        customerId: ownerCustomer,
        subscriptionId: sub.id,
        clientReferenceId: owner,
      });

      const state = await reconcileCheckoutReturn(
        { workspaceId: other, sessionId: session.id },
        paymentDeps(fake),
        NOW,
      );

      expect(state).toBe("unknown");
      // Nothing was read beyond the session itself, and nothing was written.
      expect(fake.callsNamed("getSubscription")).toHaveLength(0);
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId: owner } }),
      ).toBeNull();
    });
  });

  describe("money in wakes the work that was waiting for it", () => {
    // A workspace that paid, spent its whole allowance and has one job parked for it.
    async function exhaustedWithParkedJob() {
      const fixture = await createAgencyFixture(`${runId}-${counter++}`);
      fixtures.push(fixture);
      const { workspaceId } = fixture;
      const fake = createFakeStripe();
      await customerFor(workspaceId);
      const { sub } = await payFirst(fake, workspaceId);
      await prisma.usageBalance.updateMany({
        where: { workspaceId },
        data: { periodUsed: BigInt(100_000_000) },
      });
      // Parked an hour before the "now" of the payment.
      const parkedAt = new Date(NOW.getTime() - HOUR);
      const task = await prisma.task.create({
        data: {
          workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          title: "Waiting post",
          capability: "CREATE_SOCIAL_CREATIVE",
          status: "QUEUED",
          priority: "MEDIUM",
          riskLevel: "MEDIUM",
          createdByType: "USER",
        },
      });
      const job = await prisma.executionJob.create({
        data: {
          workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          taskId: task.id,
          capability: "CREATE_SOCIAL_CREATIVE",
          providerType: "SYSTEM",
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          requestPayload: { request: "a post" },
          status: "WAITING_BUDGET",
          updatedAt: parkedAt,
        },
      });
      return { fake, sub, workspaceId, job };
    }
    const statusOf = async (jobId: string) =>
      (await prisma.executionJob.findUniqueOrThrow({ where: { id: jobId } }))
        .status;

    it("buying an extra pack resumes a job parked for lack of allowance", async () => {
      const { fake, workspaceId, job } = await exhaustedWithParkedJob();
      const customerId = `cus_${workspaceId}`;
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
      });
      expect(await statusOf(job.id)).toBe("WAITING_BUDGET");

      await processStripeEvent(
        evt("checkout.session.completed", session.id),
        deps(fake),
      );

      expect(await statusOf(job.id)).toBe("QUEUED");
    });

    it("a renewal payment opens the new window and resumes a job parked for lack of allowance", async () => {
      const { fake, sub, workspaceId, job } = await exhaustedWithParkedJob();
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });
      expect(await statusOf(job.id)).toBe("WAITING_BUDGET");

      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: renewal,
        now: new Date("2026-12-01T01:00:00.000Z"),
      });

      expect(await statusOf(job.id)).toBe("QUEUED");
    });
  });

  describe("concurrency: two different subscriptions paid at the same moment", () => {
    it("the workspace lock lets exactly one link; the other is flagged, never silently overwriting", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const customerId = `cus_${workspaceId}`;
      const payments = (["growth", "business"] as const).map((planKey) => {
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
        return { sub, paid };
      });

      const results = await Promise.all(
        payments.map(({ sub, paid }) =>
          syncSubscriptionState({ workspaceId, sub, paid, now: NOW }),
        ),
      );

      const linked = results.filter((result) => result.applied);
      const flagged = results.filter((result) => !result.applied);
      expect(linked).toHaveLength(1);
      expect(flagged).toEqual([
        { applied: false, note: "duplicate-subscription" },
      ]);
      const row = await rowOf(workspaceId);
      const winner = payments[results.findIndex((result) => result.applied)]!;
      expect(row.stripeSubscriptionId).toBe(winner.sub.id);
      expect(row.planKey).toBe(winner.sub.planKey);
    });
  });

  describe("concurrency: two deliveries of the same payment", () => {
    it("run one after the other under the workspace lock: one link, one grant per unit, nothing thrown", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const customerId = `cus_${workspaceId}`;
      const sub = fake.subscription({
        customerId,
        planKey: "growth",
        metadata: { workspaceId, intro: "0" },
      });
      const paid = fake.invoice({
        subscriptionId: sub.id,
        customerId,
        billingReason: "subscription_create",
      });

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          syncSubscriptionState({ workspaceId, sub, paid, now: NOW }),
        ),
      );

      expect(results.map((result) => result.status)).toEqual(
        Array(6).fill("fulfilled"),
      );
      const applied = results.flatMap((result) =>
        result.status === "fulfilled" && result.value.applied
          ? [result.value]
          : [],
      );
      // Exactly one of them linked the subscription; the rest saw it already linked.
      expect(
        applied.filter((value) => value.notes.includes("linked")),
      ).toHaveLength(1);
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "PLAN", unit: "IMAGE" },
        }),
      ).toBe(1);
      expect((await period(workspaceId)).granted).toBe(
        quotaFor("growth").IMAGE,
      );
    });
  });
});
