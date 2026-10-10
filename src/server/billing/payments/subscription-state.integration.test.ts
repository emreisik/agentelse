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
import { upgradeDelta, quotaFor, type PlanKey } from "@/lib/billing/plans";
import { quotaWindowAt, remainingFraction } from "@/lib/billing/windows";
import { describeIntegration } from "@/test-support/integration-suite";

import { getEntitlements } from "../entitlements";
import { ensurePeriod } from "../ledger";
import { PENDING_SLACK_MS, syncSubscriptionState } from "./subscription-state";
import { createFakeStripe, T0, T1 } from "./test-support/fake-stripe";

// Abonelik durum makinesi GERÇEK Postgres'e karşı: Stripe'tan okunmuş veriler (sahte
// ağ geçidi) → Subscription satırı + kullanım defteri. Her test kendi workspace'ini
// kullanır.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_pay_${runId}_${++counter}`;

const NOW = new Date("2026-11-15T12:00:00.000Z");
const T2 = new Date("2027-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });

async function balance(workspaceId: string, unit: "IMAGE" | "AI_MICROS") {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  return {
    granted: Number(row.periodGranted),
    used: Number(row.periodUsed),
    start: row.periodStart,
    end: row.periodEnd,
  };
}

const grantsOf = (workspaceId: string, reason: string, unit = "IMAGE") =>
  prisma.usageGrant.findMany({ where: { workspaceId, reason, unit } });

type Fake = ReturnType<typeof createFakeStripe>;

// İlk ödeme: abonelik + ödenmiş ilk fatura.
function firstPayment(
  fake: Fake,
  input: {
    workspaceId: string;
    planKey?: PlanKey;
    intro?: boolean;
    livemode?: boolean;
    customerId?: string;
  },
) {
  const customerId = input.customerId ?? `cus_${input.workspaceId}`;
  const sub = fake.subscription({
    customerId,
    planKey: input.planKey ?? "growth",
    livemode: input.livemode ?? false,
    metadata: {
      workspaceId: input.workspaceId,
      intro: input.intro ? "1" : "0",
    },
  });
  const paid = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: "subscription_create",
    livemode: input.livemode ?? false,
  });
  return { sub, paid };
}

describeIntegration("subscription state from Stripe", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_pay_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
  });

  describe("first payment", () => {
    it("links the subscription, opens the plan window and grants the plan quota", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = firstPayment(fake, { workspaceId });

      const result = await syncSubscriptionState({
        workspaceId,
        sub,
        paid,
        now: NOW,
      });

      expect(result).toMatchObject({ applied: true, reopened: true });
      const row = await rowOf(workspaceId);
      expect(row).toMatchObject({
        status: "ACTIVE",
        planKey: "growth",
        interval: "MONTH",
        stripeSubscriptionId: sub.id,
        stripeLivemode: false,
        periodIndex: 1,
        introOffer: false,
        graceUntil: null,
        endedAt: null,
        cancelAtPeriodEnd: false,
      });
      expect(row.quotaAnchor).toEqual(T0);
      expect(row.paidThrough).toEqual(T1);

      const quota = quotaFor("growth");
      expect(await balance(workspaceId, "IMAGE")).toMatchObject({
        granted: quota.IMAGE,
        used: 0,
        start: T0,
        end: T1,
      });
      expect((await balance(workspaceId, "AI_MICROS")).granted).toBe(
        quota.AI_MICROS,
      );
      const entitlements = await getEntitlements(workspaceId, { now: NOW });
      expect(entitlements).toMatchObject({
        access: "FULL",
        reason: "ACTIVE",
        planKey: "growth",
        enforced: true,
      });
    });

    it("the intro month gives Business the reduced first-window quota and remembers the intro", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = firstPayment(fake, {
        workspaceId,
        planKey: "business",
        intro: true,
      });

      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });

      const row = await rowOf(workspaceId);
      expect(row).toMatchObject({ introOffer: true, periodIndex: 1 });
      expect((await balance(workspaceId, "IMAGE")).granted).toBe(
        quotaFor("business", { firstMonth: true }).IMAGE,
      );
      expect(quotaFor("business", { firstMonth: true }).IMAGE).toBeLessThan(
        quotaFor("business").IMAGE,
      );
    });

    it("paying the full price in the first month keeps the full quota (no intro, no reduction)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = firstPayment(fake, {
        workspaceId,
        planKey: "business",
        intro: false,
      });

      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });

      expect((await balance(workspaceId, "IMAGE")).granted).toBe(
        quotaFor("business").IMAGE,
      );
    });

    it("applying the same payment twice changes nothing (one grant per unit)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = firstPayment(fake, { workspaceId });

      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
      const again = await syncSubscriptionState({
        workspaceId,
        sub,
        paid,
        now: NOW,
      });

      expect(again).toMatchObject({ applied: true, changed: false });
      expect(await grantsOf(workspaceId, "PLAN")).toHaveLength(1);
      expect((await balance(workspaceId, "IMAGE")).granted).toBe(
        quotaFor("growth").IMAGE,
      );
    });

    it("converts a legacy row without touching the trial or legacy markers", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const trialEndsAt = new Date("2026-10-01T00:00:00.000Z");
      const legacyUntil = new Date("2026-12-31T00:00:00.000Z");
      await prisma.subscription.create({
        data: { workspaceId, status: "LEGACY", trialEndsAt, legacyUntil },
      });
      const { sub, paid } = firstPayment(fake, { workspaceId });

      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });

      const row = await rowOf(workspaceId);
      expect(row.status).toBe("ACTIVE");
      expect(row.trialEndsAt).toEqual(trialEndsAt);
      expect(row.legacyUntil).toEqual(legacyUntil);
    });

    it("a trial that converts to a paid plan starts a fresh window (trial usage does not carry)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const trialStart = new Date(NOW.getTime() - 4 * DAY);
      await prisma.subscription.create({
        data: {
          workspaceId,
          status: "TRIALING",
          quotaAnchor: trialStart,
          trialEndsAt: new Date(NOW.getTime() + 3 * DAY),
        },
      });
      await ensurePeriod(workspaceId, { now: NOW });
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        data: { periodUsed: BigInt(4) },
      });
      const { sub, paid } = firstPayment(fake, { workspaceId });
      const started = new Date(NOW.getTime() - 60_000);
      fake.subs.set(sub.id, { ...sub, startDate: started });

      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, startDate: started },
        paid,
        now: NOW,
      });

      const image = await balance(workspaceId, "IMAGE");
      expect(image).toMatchObject({
        granted: quotaFor("growth").IMAGE,
        used: 0,
      });
      expect(image.start).toEqual(started);
    });

    it("an unpaid subscription event never creates a row", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub } = firstPayment(fake, { workspaceId });

      const result = await syncSubscriptionState({
        workspaceId,
        sub,
        now: NOW,
      });

      expect(result).toEqual({ applied: false, note: "awaiting-payment" });
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId } }),
      ).toBeNull();
    });

    it("does not guess a plan for a product it does not own", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = firstPayment(fake, { workspaceId });
      const unknown = { ...sub, planKey: null, productId: "prod_other" };

      const result = await syncSubscriptionState({
        workspaceId,
        sub: unknown,
        paid,
        now: NOW,
      });

      expect(result).toEqual({ applied: false, note: "unknown-plan" });
      expect(
        await prisma.subscription.findUnique({ where: { workspaceId } }),
      ).toBeNull();
    });
  });

  describe("renewal and payment trouble", () => {
    async function paying(
      fake: Fake,
      workspaceId: string,
      planKey: PlanKey = "growth",
    ) {
      const { sub, paid } = firstPayment(fake, { workspaceId, planKey });
      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
      return sub;
    }

    it("a renewal moves the paid period forward, opens the next window and is never moved back by an old invoice", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId);
      const renewalAt = new Date("2026-12-02T08:00:00.000Z");
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });

      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: renewal,
        now: renewalAt,
      });

      const row = await rowOf(workspaceId);
      expect(row.paidThrough).toEqual(T2);
      expect(row.periodIndex).toBe(2);
      expect((await balance(workspaceId, "IMAGE")).start).toEqual(T1);

      // The first invoice is delivered again, late: nothing goes backwards.
      const old = fake.invoices.get(
        [...fake.invoices.keys()].find(
          (key) =>
            fake.invoices.get(key)!.billingReason === "subscription_create",
        )!,
      )!;
      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: old,
        now: renewalAt,
      });
      expect((await rowOf(workspaceId)).paidThrough).toEqual(T2);
    });

    it("a failed renewal gives a 3-day grace that retries do not stretch, and the next payment clears it", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId);
      const failedAt = new Date("2026-12-01T09:00:00.000Z");
      const pastDue = { ...sub, status: "past_due" };

      await syncSubscriptionState({ workspaceId, sub: pastDue, now: failedAt });
      const first = await rowOf(workspaceId);
      expect(first.status).toBe("PAST_DUE");
      expect(first.graceUntil).toEqual(new Date(failedAt.getTime() + 3 * DAY));

      // Stripe retries and fails again a day later.
      await syncSubscriptionState({
        workspaceId,
        sub: pastDue,
        now: new Date(failedAt.getTime() + DAY),
      });
      expect((await rowOf(workspaceId)).graceUntil).toEqual(first.graceUntil);

      const duringGrace = await getEntitlements(workspaceId, {
        now: new Date(failedAt.getTime() + 2 * DAY),
      });
      expect(duringGrace).toMatchObject({
        access: "FULL",
        reason: "PAST_DUE_GRACE",
        canOpenNewWindows: false,
      });
      const afterGrace = await getEntitlements(workspaceId, {
        now: new Date(failedAt.getTime() + 4 * DAY),
      });
      expect(afterGrace).toMatchObject({
        access: "READ_ONLY",
        reason: "PAST_DUE_ENDED",
      });

      // The card is fixed and the retry succeeds.
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });
      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: renewal,
        now: new Date(failedAt.getTime() + 2 * DAY),
      });
      const recovered = await rowOf(workspaceId);
      expect(recovered).toMatchObject({
        status: "ACTIVE",
        graceUntil: null,
        endedReason: null,
      });
      expect(recovered.paidThrough).toEqual(T2);
    });

    it("a payment failure never turns into PAST_DUE when a payment was applied in the same call", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId);
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });

      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, status: "past_due" },
        paid: renewal,
        now: new Date("2026-12-01T10:00:00.000Z"),
      });

      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
    });

    it.each([
      ["payment_failed", "PAYMENT_FAILED"],
      ["payment_disputed", "CHARGEBACK"],
      ["cancellation_requested", "CANCELED"],
      [null, "CANCELED"],
    ])(
      "Stripe ending the subscription (%s) records %s and keeps access to the paid date",
      async (cancellationReason, endedReason) => {
        const fake = createFakeStripe();
        const workspaceId = newWs();
        const sub = await paying(fake, workspaceId);

        await syncSubscriptionState({
          workspaceId,
          sub: {
            ...sub,
            status: "canceled",
            endedAt: NOW,
            cancellationReason,
          },
          now: NOW,
        });

        const row = await rowOf(workspaceId);
        expect(row).toMatchObject({ status: "CANCELED", endedReason });
        expect(row.endedAt).toEqual(NOW);
        expect(await getEntitlements(workspaceId, { now: NOW })).toMatchObject({
          access: "FULL",
          reason: "CANCELED_GRACE",
        });
        expect(
          await getEntitlements(workspaceId, {
            now: new Date(T1.getTime() + 1000),
          }),
        ).toMatchObject({ access: "READ_ONLY", reason: "CANCELED" });
      },
    );

    it("a payment that arrives after the end event still extends the paid period but does not revive the subscription", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId);
      const ended = { ...sub, status: "canceled", endedAt: NOW };
      await syncSubscriptionState({ workspaceId, sub: ended, now: NOW });
      const late = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: T2,
      });

      await syncSubscriptionState({
        workspaceId,
        sub: ended,
        paid: late,
        now: NOW,
      });

      const row = await rowOf(workspaceId);
      expect(row.status).toBe("CANCELED");
      expect(row.paidThrough).toEqual(T2);
    });

    it("mirrors cancel-at-period-end in both directions", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId);

      await syncSubscriptionState({
        workspaceId,
        sub: { ...sub, cancelAtPeriodEnd: true },
        now: NOW,
      });
      expect((await rowOf(workspaceId)).cancelAtPeriodEnd).toBe(true);
      // A subscription set to end gets no renewal grace.
      expect(
        (await getEntitlements(workspaceId, { now: NOW })).spendThrough,
      ).toEqual(T1);

      await syncSubscriptionState({ workspaceId, sub, now: NOW });
      expect((await rowOf(workspaceId)).cancelAtPeriodEnd).toBe(false);
    });
  });

  describe("plan changes", () => {
    async function paying(
      fake: Fake,
      workspaceId: string,
      planKey: PlanKey,
      intro = false,
    ) {
      const { sub, paid } = firstPayment(fake, { workspaceId, planKey, intro });
      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
      return sub;
    }

    const upgraded = (
      fake: Fake,
      sub: ReturnType<Fake["subscription"]>,
      planKey: PlanKey,
      invoiceStatus = "paid",
    ) => {
      const proration = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_update",
        status: invoiceStatus,
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
          status: invoiceStatus,
          billingReason: "subscription_update",
        },
      };
    };

    it("an upgrade takes effect at once and grants the proportional difference exactly once", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId, "starter");
      const next = upgraded(fake, sub, "growth");
      const window = quotaWindowAt(T0, NOW)!;
      const expected = upgradeDelta(
        quotaFor("starter"),
        quotaFor("growth"),
        remainingFraction(window, NOW),
      );

      const result = await syncSubscriptionState({
        workspaceId,
        sub: next,
        now: NOW,
      });
      expect(result).toMatchObject({ applied: true, reopened: true });
      expect(result.applied && result.notes).toContain("upgraded");

      expect((await rowOf(workspaceId)).planKey).toBe("growth");
      const image = await balance(workspaceId, "IMAGE");
      expect(image.granted).toBe(quotaFor("starter").IMAGE + expected.IMAGE);
      expect(expected.IMAGE).toBeGreaterThan(0);
      expect((await balance(workspaceId, "AI_MICROS")).granted).toBe(
        quotaFor("starter").AI_MICROS + expected.AI_MICROS,
      );
      expect(await grantsOf(workspaceId, "PLAN_CHANGE")).toHaveLength(1);

      // Delivered again (second event for the same change): no second grant.
      await syncSubscriptionState({ workspaceId, sub: next, now: NOW });
      expect(await grantsOf(workspaceId, "PLAN_CHANGE")).toHaveLength(1);
      expect((await balance(workspaceId, "IMAGE")).granted).toBe(
        quotaFor("starter").IMAGE + expected.IMAGE,
      );
    });

    it("an upgrade whose invoice is not paid yet changes nothing, and the payment completes it", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId, "starter");
      const open = upgraded(fake, sub, "growth", "open");

      const early = await syncSubscriptionState({
        workspaceId,
        sub: open,
        now: NOW,
      });
      expect(early).toMatchObject({ applied: true, changed: false });
      expect(early.applied && early.notes).toContain(
        "upgrade-awaiting-payment",
      );
      expect((await rowOf(workspaceId)).planKey).toBe("starter");

      fake.invoices.set(open.latestInvoice.id, {
        ...fake.invoices.get(open.latestInvoice.id)!,
        status: "paid",
      });
      const paidNow = {
        ...open,
        latestInvoice: { ...open.latestInvoice, status: "paid" },
      };
      await syncSubscriptionState({
        workspaceId,
        sub: paidNow,
        paid: fake.invoices.get(open.latestInvoice.id)!,
        now: NOW,
      });
      expect((await rowOf(workspaceId)).planKey).toBe("growth");
    });

    it("inside the intro window both plans are measured with the intro factor", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId, "business", true);
      const next = upgraded(fake, sub, "agency");
      const window = quotaWindowAt(T0, NOW)!;
      const expected = upgradeDelta(
        quotaFor("business", { firstMonth: true }),
        quotaFor("agency", { firstMonth: true }),
        remainingFraction(window, NOW),
      );

      await syncSubscriptionState({ workspaceId, sub: next, now: NOW });

      expect((await balance(workspaceId, "IMAGE")).granted).toBe(
        quotaFor("business", { firstMonth: true }).IMAGE + expected.IMAGE,
      );
    });

    it("a downgrade waits for the end of the paid period; the entitlement does not shrink now", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId, "business");
      const lower = {
        ...sub,
        planKey: "growth" as const,
        productId: "agentelse_plan_growth",
      };

      const result = await syncSubscriptionState({
        workspaceId,
        sub: lower,
        now: NOW,
      });

      expect(result.applied && result.notes).toContain("downgrade-scheduled");
      expect(result).toMatchObject({ reopened: false });
      const row = await rowOf(workspaceId);
      expect(row.planKey).toBe("business");
      expect(row.pendingPlanKey).toBe("growth");
      expect(row.pendingEffectiveAt).toEqual(
        new Date(T1.getTime() - PENDING_SLACK_MS),
      );
      expect((await balance(workspaceId, "IMAGE")).granted).toBe(
        quotaFor("business").IMAGE,
      );
      expect((await getEntitlements(workspaceId, { now: NOW })).planKey).toBe(
        "business",
      );

      // The same state again writes nothing.
      const again = await syncSubscriptionState({
        workspaceId,
        sub: lower,
        now: NOW,
      });
      expect(again).toMatchObject({ applied: true, changed: false });
    });

    it("the renewal after a scheduled downgrade applies it and opens the smaller window", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId, "business");
      const lower = {
        ...sub,
        planKey: "growth" as const,
        productId: "agentelse_plan_growth",
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

      const row = await rowOf(workspaceId);
      expect(row).toMatchObject({
        planKey: "growth",
        pendingPlanKey: null,
        pendingEffectiveAt: null,
      });
      expect(row.paidThrough).toEqual(T2);
      const image = await balance(workspaceId, "IMAGE");
      expect(image.start).toEqual(T1);
      expect(image.granted).toBe(quotaFor("growth").IMAGE);
    });

    it("going back to the paid plan before the renewal cancels the scheduled downgrade", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const sub = await paying(fake, workspaceId, "business");
      const lower = {
        ...sub,
        planKey: "growth" as const,
        productId: "agentelse_plan_growth",
      };
      await syncSubscriptionState({ workspaceId, sub: lower, now: NOW });

      await syncSubscriptionState({ workspaceId, sub, now: NOW });

      expect(await rowOf(workspaceId)).toMatchObject({
        planKey: "business",
        pendingPlanKey: null,
        pendingInterval: null,
        pendingEffectiveAt: null,
      });
    });
  });

  describe("which subscription counts", () => {
    it("ignores events of a subscription that is not the linked one", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = firstPayment(fake, { workspaceId });
      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });
      const other = fake.subscription({ customerId: sub.customerId });

      const result = await syncSubscriptionState({
        workspaceId,
        sub: { ...other, status: "canceled" },
        now: NOW,
      });

      expect(result).toEqual({ applied: false, note: "stale-subscription" });
      expect((await rowOf(workspaceId)).status).toBe("ACTIVE");
    });

    it("refuses a second paying subscription while one is active (flagged, not applied)", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const first = firstPayment(fake, { workspaceId });
      await syncSubscriptionState({
        workspaceId,
        sub: first.sub,
        paid: first.paid,
        now: NOW,
      });
      const second = firstPayment(fake, { workspaceId, planKey: "business" });

      const result = await syncSubscriptionState({
        workspaceId,
        sub: second.sub,
        paid: second.paid,
        now: NOW,
      });

      expect(result).toEqual({
        applied: false,
        note: "duplicate-subscription",
      });
      const row = await rowOf(workspaceId);
      expect(row.stripeSubscriptionId).toBe(first.sub.id);
      expect(row.planKey).toBe("growth");
    });

    it("a new subscription replaces a canceled one and never gets a second intro month", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const first = firstPayment(fake, {
        workspaceId,
        planKey: "business",
        intro: true,
      });
      await syncSubscriptionState({
        workspaceId,
        sub: first.sub,
        paid: first.paid,
        now: NOW,
      });
      await syncSubscriptionState({
        workspaceId,
        sub: { ...first.sub, status: "canceled", endedAt: NOW },
        now: NOW,
      });
      const laterStart = new Date("2027-02-01T00:00:00.000Z");
      const second = firstPayment(fake, {
        workspaceId,
        planKey: "business",
        intro: true,
      });
      const secondSub = { ...second.sub, startDate: laterStart };
      const secondPaid = {
        ...second.paid,
        periodStart: laterStart,
        periodEnd: new Date("2027-03-01T00:00:00.000Z"),
      };

      const result = await syncSubscriptionState({
        workspaceId,
        sub: secondSub,
        paid: secondPaid,
        now: new Date("2027-02-01T01:00:00.000Z"),
      });

      expect(result).toMatchObject({ applied: true });
      const row = await rowOf(workspaceId);
      expect(row).toMatchObject({
        status: "ACTIVE",
        stripeSubscriptionId: second.sub.id,
        introOffer: true,
        periodIndex: 2,
        endedAt: null,
        endedReason: null,
      });
      // Full quota, not the reduced intro window.
      expect((await balance(workspaceId, "IMAGE")).granted).toBe(
        quotaFor("business").IMAGE,
      );
    });

    it("a leftover test-mode link does not block the real (live) payment", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const test = firstPayment(fake, { workspaceId, livemode: false });
      await syncSubscriptionState({
        workspaceId,
        sub: test.sub,
        paid: test.paid,
        now: NOW,
      });
      const live = firstPayment(fake, {
        workspaceId,
        livemode: true,
        customerId: "cus_live_1",
      });

      const result = await syncSubscriptionState({
        workspaceId,
        sub: live.sub,
        paid: live.paid,
        now: NOW,
      });

      expect(result).toMatchObject({ applied: true });
      expect(await rowOf(workspaceId)).toMatchObject({
        stripeSubscriptionId: live.sub.id,
        stripeLivemode: true,
      });
    });
  });

  describe("a leftover TEST-mode row never shapes the LIVE subscription", () => {
    it("a canceled test row that still holds paid time does not lend it to the live subscription", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const test = firstPayment(fake, { workspaceId, livemode: false });
      await syncSubscriptionState({
        workspaceId,
        sub: test.sub,
        paid: test.paid,
        now: NOW,
      });
      // The test subscription is canceled with a long paid period still running.
      const farAway = new Date("2027-09-01T00:00:00.000Z");
      await prisma.subscription.update({
        where: { workspaceId },
        data: { status: "CANCELED", paidThrough: farAway },
      });
      const live = firstPayment(fake, {
        workspaceId,
        livemode: true,
        customerId: "cus_live_2",
      });

      await syncSubscriptionState({
        workspaceId,
        sub: live.sub,
        paid: live.paid,
        now: NOW,
      });

      const row = await rowOf(workspaceId);
      expect(row).toMatchObject({
        stripeSubscriptionId: live.sub.id,
        stripeLivemode: true,
        status: "ACTIVE",
      });
      // The live period end, not the test card's far-away date.
      expect(row.paidThrough?.getTime()).toBeLessThan(farAway.getTime());
    });

    it("the first-month discount used with a test card is not 'used' for the live purchase", async () => {
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const test = firstPayment(fake, {
        workspaceId,
        planKey: "business",
        intro: true,
        livemode: false,
      });
      await syncSubscriptionState({
        workspaceId,
        sub: test.sub,
        paid: test.paid,
        now: NOW,
      });
      await syncSubscriptionState({
        workspaceId,
        sub: { ...test.sub, status: "canceled", endedAt: NOW },
        now: NOW,
      });
      expect(await rowOf(workspaceId)).toMatchObject({ introOffer: true });
      const live = firstPayment(fake, {
        workspaceId,
        planKey: "business",
        intro: true,
        livemode: true,
        customerId: "cus_live_3",
      });

      await syncSubscriptionState({
        workspaceId,
        sub: live.sub,
        paid: live.paid,
        now: NOW,
      });

      // The live first month IS a first month: first billing period, intro remembered, and
      // the reduced first-window quota that goes with the discount that was charged.
      expect(await rowOf(workspaceId)).toMatchObject({
        stripeLivemode: true,
        introOffer: true,
        periodIndex: 1,
      });
      expect((await balance(workspaceId, "IMAGE")).granted).toBeLessThan(
        quotaFor("business").IMAGE,
      );
    });
  });

  describe("billing mode off", () => {
    it("still records the subscription (so switching the mode on later is correct) but opens no window", async () => {
      config.current = { mode: "off", legacyBefore: null, legacyUntil: null };
      const fake = createFakeStripe();
      const workspaceId = newWs();
      const { sub, paid } = firstPayment(fake, { workspaceId });

      await syncSubscriptionState({ workspaceId, sub, paid, now: NOW });

      expect(await rowOf(workspaceId)).toMatchObject({
        status: "ACTIVE",
        planKey: "growth",
      });
      expect(
        await prisma.usageBalance.findMany({ where: { workspaceId } }),
      ).toHaveLength(0);
    });
  });
});
