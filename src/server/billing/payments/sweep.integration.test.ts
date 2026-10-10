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

const periodic = vi.hoisted(() => ({ claim: vi.fn() }));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: periodic.claim,
}));

const paymentDeps = vi.hoisted(() => ({
  current: null as unknown,
  lastOptions: undefined as unknown,
}));
vi.mock("./deps", () => ({
  getPaymentDeps: (options?: unknown) => {
    paymentDeps.lastOptions = options;
    return paymentDeps.current;
  },
}));

import { prisma } from "@/lib/prisma";
import { quotaFor } from "@/lib/billing/plans";
import { describeIntegration } from "@/test-support/integration-suite";

import { StripeApiError } from "../stripe/client";
import {
  SWEEP_BATCH,
  SWEEP_LOOKBACK_MS,
  runPaymentsSweepTick,
  sweepSubscriptions,
} from "./sweep";
import { syncSubscriptionState } from "./subscription-state";
import {
  createFakeStripe,
  T0,
  T1,
  type FakeStripe,
} from "./test-support/fake-stripe";

// The safety net for lost webhooks: subscriptions whose renewal date has come are read
// again from Stripe and run through the same state machine. Real Postgres, fake Stripe.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_swp_${runId}_${++counter}`;
const T2 = new Date("2027-01-01T00:00:00.000Z");
const SIGNED_UP = new Date("2026-11-15T12:00:00.000Z");
const AFTER_RENEWAL_DATE = new Date("2026-12-01T02:00:00.000Z");
const HOUR = 60 * 60 * 1000;

async function subscribed(
  fake: FakeStripe,
  options: { livemode?: boolean } = {},
) {
  const workspaceId = newWs();
  const customerId = `cus_${workspaceId}`;
  const sub = fake.subscription({
    customerId,
    planKey: "growth",
    livemode: options.livemode ?? false,
    metadata: { workspaceId },
  });
  const paid = fake.invoice({
    subscriptionId: sub.id,
    customerId,
    billingReason: "subscription_create",
    livemode: options.livemode ?? false,
  });
  fake.subs.set(sub.id, {
    ...sub,
    latestInvoice: {
      id: paid.id,
      status: "paid",
      billingReason: "subscription_create",
    },
  });
  await syncSubscriptionState({
    workspaceId,
    sub: fake.subs.get(sub.id)!,
    paid,
    now: SIGNED_UP,
  });
  return { workspaceId, customerId, sub: fake.subs.get(sub.id)! };
}

// Stripe renewed it (the webhook never arrived).
function renewed(fake: FakeStripe, customerId: string, subId: string) {
  const invoice = fake.invoice({
    subscriptionId: subId,
    customerId,
    billingReason: "subscription_cycle",
    periodStart: T1,
    periodEnd: T2,
  });
  fake.subs.set(subId, {
    ...fake.subs.get(subId)!,
    latestInvoice: {
      id: invoice.id,
      status: "paid",
      billingReason: "subscription_cycle",
    },
  });
  return invoice;
}

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });

describeIntegration("payments sweep", () => {
  beforeEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    periodic.claim.mockResolvedValue(true);
    paymentDeps.current = null;
  });

  // The sweep looks at the whole database, so each test starts from an empty one: rows
  // left by an earlier test would be read through THIS test's Stripe and look missing.
  const cleanUp = async () => {
    const where = { workspaceId: { startsWith: `ws_swp_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
  };

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanUp();
  });

  afterAll(cleanUp);

  it("applies a renewal the webhook missed: the paid period moves on and the next window opens", async () => {
    const fake = createFakeStripe();
    const { workspaceId, customerId, sub } = await subscribed(fake);
    renewed(fake, customerId, sub.id);

    const summary = await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );

    expect(summary).toMatchObject({ checked: expect.any(Number), failed: 0 });
    const row = await rowOf(workspaceId);
    expect(row.paidThrough).toEqual(T2);
    expect(row.periodIndex).toBe(2);
    const image = await prisma.usageBalance.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
    });
    expect(image.periodStart).toEqual(T1);
    expect(Number(image.periodGranted)).toBe(quotaFor("growth").IMAGE);
  });

  it("is quiet when nothing changed: a second sweep does nothing", async () => {
    const fake = createFakeStripe();
    const { workspaceId, customerId, sub } = await subscribed(fake);
    renewed(fake, customerId, sub.id);
    await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );
    const reads = fake.calls.length;

    const again = await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );

    // Renewed in the meantime: it is no longer due, so it is not even read.
    expect(again.checked).toBe(0);
    expect(fake.calls.length).toBe(reads);
    expect((await rowOf(workspaceId)).paidThrough).toEqual(T2);
  });

  it("a subscription Stripe ended is closed; one whose payment is failing goes to the grace period", async () => {
    const fake = createFakeStripe();
    const ended = await subscribed(fake);
    const failing = await subscribed(fake);
    fake.subs.set(ended.sub.id, {
      ...fake.subs.get(ended.sub.id)!,
      status: "canceled",
      endedAt: T1,
      cancellationReason: "payment_failed",
    });
    fake.subs.set(failing.sub.id, {
      ...fake.subs.get(failing.sub.id)!,
      status: "past_due",
    });

    await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );

    expect(await rowOf(ended.workspaceId)).toMatchObject({
      status: "CANCELED",
      endedReason: "PAYMENT_FAILED",
    });
    const second = await rowOf(failing.workspaceId);
    expect(second.status).toBe("PAST_DUE");
    expect(second.graceUntil).toEqual(
      new Date(AFTER_RENEWAL_DATE.getTime() + 3 * 24 * HOUR),
    );
  });

  it("an open renewal invoice is not a payment: nothing is granted", async () => {
    const fake = createFakeStripe();
    const { workspaceId, customerId, sub } = await subscribed(fake);
    const open = fake.invoice({
      subscriptionId: sub.id,
      customerId,
      status: "open",
      billingReason: "subscription_cycle",
      periodStart: T1,
      periodEnd: T2,
    });
    fake.subs.set(sub.id, {
      ...fake.subs.get(sub.id)!,
      latestInvoice: {
        id: open.id,
        status: "open",
        billingReason: "subscription_cycle",
      },
    });

    await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );

    expect((await rowOf(workspaceId)).paidThrough).toEqual(T1);
  });

  it("does not read what is not due, what is older than the look-back, or the other Stripe mode", async () => {
    const fake = createFakeStripe();
    const notDue = await subscribed(fake);
    const ancient = await subscribed(fake);
    const live = await subscribed(fake, { livemode: true });
    await prisma.subscription.update({
      where: { workspaceId: ancient.workspaceId },
      data: {
        paidThrough: new Date(
          AFTER_RENEWAL_DATE.getTime() - SWEEP_LOOKBACK_MS - HOUR,
        ),
      },
    });
    await prisma.subscription.update({
      where: { workspaceId: notDue.workspaceId },
      data: {
        paidThrough: new Date(AFTER_RENEWAL_DATE.getTime() + 10 * 24 * HOUR),
      },
    });
    fake.calls.length = 0;

    const summary = await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );

    // Only the due test-mode subscriptions of this run; never the three above.
    const read = fake.callsNamed("getSubscription").map((call) => call.args);
    expect(read).not.toContain(notDue.sub.id);
    expect(read).not.toContain(ancient.sub.id);
    expect(read).not.toContain(live.sub.id);
    expect(summary.failed).toBe(0);
  });

  it("one subscription that cannot be read does not stop the others", async () => {
    const fake = createFakeStripe();
    const broken = await subscribed(fake);
    const healthy = await subscribed(fake);
    renewed(fake, healthy.customerId, healthy.sub.id);
    const original = fake.gateway.getSubscription;
    const gateway = {
      ...fake.gateway,
      getSubscription: async (id: string) => {
        if (id === broken.sub.id)
          throw new StripeApiError({ status: 500, message: "boom" });
        return original(id);
      },
    };

    const summary = await sweepSubscriptions(
      { gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );

    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect((await rowOf(healthy.workspaceId)).paidThrough).toEqual(T2);
    expect((await rowOf(broken.workspaceId)).paidThrough).toEqual(T1);
  });

  it("counts a subscription Stripe no longer knows as failed, for a person to look at", async () => {
    const fake = createFakeStripe();
    const { sub } = await subscribed(fake);
    fake.subs.delete(sub.id);

    const summary = await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE },
    );

    expect(summary.failed).toBeGreaterThanOrEqual(1);
  });

  it("reads at most one batch per run", async () => {
    const fake = createFakeStripe();
    for (let i = 0; i < 4; i += 1) await subscribed(fake);

    const summary = await sweepSubscriptions(
      { gateway: fake.gateway, mode: "test" },
      { now: AFTER_RENEWAL_DATE, limit: 2 },
    );

    expect(summary.checked).toBe(2);
    expect(SWEEP_BATCH).toBeGreaterThan(2);
  });

  describe("which rows come first, how long a run may take, and what it says", () => {
    const readOrder = (fake: FakeStripe) =>
      fake.calls
        .filter((call) => call.name === "getSubscription")
        .map((call) => call.args as string);

    it("reads the least recently verified first, so rows that never change cannot starve the missed renewals behind them", async () => {
      const fake = createFakeStripe();
      // Four renewals the webhook missed; the OLDEST paid period belongs to the row verified
      // longest ago, and two newer rows were verified a moment ago (they keep failing to pay
      // but nothing changes, so they stay in the window).
      const rows = [];
      for (let i = 0; i < 4; i += 1) rows.push(await subscribed(fake));
      const verifiedAt = [5, 1, 4, 2].map(
        (hoursAgo) => new Date(AFTER_RENEWAL_DATE.getTime() - hoursAgo * HOUR),
      );
      for (const [i, row] of rows.entries()) {
        await prisma.subscription.update({
          where: { workspaceId: row.workspaceId },
          data: { stripeSyncedAt: verifiedAt[i] },
        });
        renewed(fake, row.customerId, row.sub.id);
      }

      await sweepSubscriptions(
        { gateway: fake.gateway, mode: "test" },
        { now: AFTER_RENEWAL_DATE, limit: 2 },
      );

      // verified 5h ago (rows[0]) and 4h ago (rows[2]) go first
      expect(readOrder(fake)).toEqual([rows[0]!.sub.id, rows[2]!.sub.id]);
      // and they are stamped, so the next run reaches the other two
      fake.calls.length = 0;
      await sweepSubscriptions(
        { gateway: fake.gateway, mode: "test" },
        { now: AFTER_RENEWAL_DATE, limit: 2 },
      );
      expect(readOrder(fake)).toEqual([rows[3]!.sub.id, rows[1]!.sub.id]);
    });

    it("a row that was never verified comes before every verified one", async () => {
      const fake = createFakeStripe();
      const a = await subscribed(fake);
      const b = await subscribed(fake);
      await prisma.subscription.update({
        where: { workspaceId: a.workspaceId },
        data: { stripeSyncedAt: new Date(AFTER_RENEWAL_DATE.getTime() - 40 * HOUR) },
      });
      await prisma.subscription.update({
        where: { workspaceId: b.workspaceId },
        data: { stripeSyncedAt: null },
      });

      await sweepSubscriptions(
        { gateway: fake.gateway, mode: "test" },
        { now: AFTER_RENEWAL_DATE, limit: 1 },
      );

      expect(readOrder(fake)).toEqual([b.sub.id]);
    });

    it("still reaches a renewal that was missed more than two weeks ago (a long webhook outage)", async () => {
      const fake = createFakeStripe();
      const { workspaceId, customerId, sub } = await subscribed(fake);
      renewed(fake, customerId, sub.id);
      const muchLater = new Date(T1.getTime() + 30 * 24 * HOUR);

      const summary = await sweepSubscriptions(
        { gateway: fake.gateway, mode: "test" },
        { now: muchLater },
      );

      expect(summary.checked).toBe(1);
      expect((await rowOf(workspaceId)).paidThrough).toEqual(T2);
      expect(SWEEP_LOOKBACK_MS).toBeGreaterThan(30 * 24 * HOUR);
    });

    it("stops at its time budget and leaves the rest for the next run, saying so", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fake = createFakeStripe();
      for (let i = 0; i < 3; i += 1) await subscribed(fake);
      // The clock moves 100 ms per look; the budget is 150 ms: the first row is read, then the
      // budget is gone.
      let t = 0;
      const clock = () => (t += 100);

      const summary = await sweepSubscriptions(
        { gateway: fake.gateway, mode: "test" },
        { now: AFTER_RENEWAL_DATE, budgetMs: 150, clock },
      );

      expect(summary).toMatchObject({ checked: 1, skipped: 2, failed: 0 });
      expect(
        vi
          .mocked(console.error)
          .mock.calls.some((call) => String(call[0]).includes("skipped=2")),
      ).toBe(true);
    });

    it("names the workspace, the subscription and the Stripe status when a read fails, and says when EVERY read failed", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fake = createFakeStripe();
      const one = await subscribed(fake);
      const two = await subscribed(fake);
      fake.failures.read = new StripeApiError({
        status: 401,
        code: "api_key_expired",
        message: "Stripe 401 api_key_expired: expired",
      });

      const summary = await sweepSubscriptions(
        { gateway: fake.gateway, mode: "test" },
        { now: AFTER_RENEWAL_DATE },
      );

      expect(summary).toMatchObject({ checked: 2, failed: 2 });
      const lines = vi
        .mocked(console.error)
        .mock.calls.map((call) => String(call[0]));
      for (const row of [one, two]) {
        expect(
          lines.some(
            (line) =>
              line.includes(row.workspaceId) &&
              line.includes(row.sub.id) &&
              line.includes("Stripe 401 api_key_expired"),
          ),
        ).toBe(true);
      }
      expect(lines.some((line) => line.includes("EVERY read failed"))).toBe(
        true,
      );
    });
  });

  describe("the tick step", () => {
    it("does nothing while payments are closed, and does not even claim the slot", async () => {
      paymentDeps.current = null;
      expect(await runPaymentsSweepTick(AFTER_RENEWAL_DATE)).toBe(0);
      expect(periodic.claim).not.toHaveBeenCalled();
    });

    it("runs once per slot and reports how many subscriptions it changed", async () => {
      const fake = createFakeStripe();
      const { customerId, sub } = await subscribed(fake);
      renewed(fake, customerId, sub.id);
      paymentDeps.current = {
        gateway: fake.gateway,
        mode: "test",
        appUrl: "https://app.test",
      };

      const first = await runPaymentsSweepTick(AFTER_RENEWAL_DATE);
      periodic.claim.mockResolvedValue(false);
      const second = await runPaymentsSweepTick(AFTER_RENEWAL_DATE);

      expect(first).toBeGreaterThanOrEqual(1);
      expect(second).toBe(0);
      // The sweep needs the API key only: a missing or mistyped webhook secret (the very
      // situation it exists for) must not switch it off.
      expect(paymentDeps.lastOptions).toEqual({ webhookRequired: false });
      expect(periodic.claim).toHaveBeenCalledWith(
        "billing.payments-sweep",
        expect.any(Number),
        AFTER_RENEWAL_DATE,
      );
    });
  });
});

void T0;
