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

import { getEntitlements } from "../entitlements";
import { grantUsage, revokeUsage } from "../ledger";
import { grantExtraPack, reconcilePackRefund } from "./purchases";
import { endSubscriptionAfterRefund } from "./refunds";
import { syncSubscriptionState } from "./subscription-state";
import { createFakeStripe, T0, T1 } from "./test-support/fake-stripe";

// Ödeme sonrası geri alma yolları GERÇEK Postgres'e karşı: ledger.revokeUsage (taban),
// ek paket satın alma + iade, abonelik iadesi/itirazı.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_ref_${runId}_${++counter}`;
const NOW = new Date("2026-11-15T12:00:00.000Z");

async function extra(
  workspaceId: string,
  unit: "IMAGE" | "AI_MICROS" = "IMAGE",
) {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  return {
    granted: Number(row.extraGranted),
    used: Number(row.extraUsed),
    reserved: Number(row.extraReserved),
  };
}

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
  };
}

const refundRows = (workspaceId: string, unit = "IMAGE") =>
  prisma.usageGrant.findMany({
    where: { workspaceId, unit, reason: "REFUND" },
    orderBy: { createdAt: "asc" },
  });

describeIntegration("revoking allowance (refund, chargeback)", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_ref_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.billingReversal.deleteMany({ where });
  });

  describe("ledger.revokeUsage", () => {
    async function purchased(workspaceId: string, amount = 20) {
      await grantUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "EXTRA",
        amount,
        reason: "PURCHASE",
        idempotencyKey: `pack:pi_${workspaceId}`,
        now: NOW,
      });
    }

    it("takes back the unused part as a signed reversal row", async () => {
      const workspaceId = newWs();
      await purchased(workspaceId, 20);

      const result = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "EXTRA",
        amount: 20,
        idempotencyKey: "refund:one",
        now: NOW,
      });

      expect(result).toEqual({ revoked: BigInt(20) });
      expect((await extra(workspaceId)).granted).toBe(0);
      const rows = await refundRows(workspaceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pool: "EXTRA", amount: BigInt(-20) });
    });

    it("never takes back what was already used or is reserved (floor)", async () => {
      const workspaceId = newWs();
      await purchased(workspaceId, 20);
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        data: { extraUsed: BigInt(12), extraReserved: BigInt(3) },
      });

      const result = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "EXTRA",
        amount: 20,
        idempotencyKey: "refund:floor",
        now: NOW,
      });

      expect(result).toEqual({ revoked: BigInt(5) });
      expect(await extra(workspaceId)).toEqual({
        granted: 15,
        used: 12,
        reserved: 3,
      });
    });

    it("is idempotent per key and reports the duplicate", async () => {
      const workspaceId = newWs();
      await purchased(workspaceId, 20);
      await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "EXTRA",
        amount: 8,
        idempotencyKey: "refund:dup",
        now: NOW,
      });

      const again = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "EXTRA",
        amount: 8,
        idempotencyKey: "refund:dup",
        now: NOW,
      });

      expect(again).toEqual({ revoked: BigInt(8), duplicate: true });
      expect((await extra(workspaceId)).granted).toBe(12);
      expect(await refundRows(workspaceId)).toHaveLength(1);
    });

    it("revokes nothing (and writes no row) when everything is used", async () => {
      const workspaceId = newWs();
      await purchased(workspaceId, 5);
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        data: { extraUsed: BigInt(5) },
      });

      const result = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "EXTRA",
        amount: "ALL_UNUSED",
        idempotencyKey: "refund:none",
        now: NOW,
      });

      expect(result).toEqual({ revoked: BigInt(0) });
      expect(await refundRows(workspaceId)).toHaveLength(0);
    });

    it("a PERIOD revoke applies only to the window the caller knows", async () => {
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

      const wrongWindow = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "PERIOD",
        amount: "ALL_UNUSED",
        idempotencyKey: "refund:p1",
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        now: NOW,
      });
      expect(wrongWindow).toEqual({ revoked: BigInt(0) });
      expect((await period(workspaceId)).granted).toBe(50);

      const right = await revokeUsage({
        workspaceId,
        unit: "IMAGE",
        pool: "PERIOD",
        amount: "ALL_UNUSED",
        idempotencyKey: "refund:p2",
        periodStart: T0,
        now: NOW,
      });
      expect(right).toEqual({ revoked: BigInt(40) });
      expect(await period(workspaceId)).toMatchObject({
        granted: 10,
        used: 10,
      });
      await expect(
        revokeUsage({
          workspaceId,
          unit: "IMAGE",
          pool: "PERIOD",
          amount: 1,
          idempotencyKey: "refund:p3",
          now: NOW,
        }),
      ).rejects.toThrow(/periodStart/);
    });
  });

  describe("extra packs", () => {
    const pack = EXTRA_PACKS.images20;
    const charge = (amount: number, refunded: number) => ({
      id: "ch_x",
      amount,
      amountRefunded: refunded,
      refunded: refunded >= amount,
      customerId: null,
      invoiceId: null,
      paymentIntentId: "pi_x",
      livemode: false,
    });

    it("grants the pack once, however many times the payment is reported", async () => {
      const workspaceId = newWs();

      const first = await grantExtraPack({
        workspaceId,
        packKey: "images20",
        reference: "pi_once",
        now: NOW,
      });
      const second = await grantExtraPack({
        workspaceId,
        packKey: "images20",
        reference: "pi_once",
        now: NOW,
      });

      expect(first).toEqual({ granted: true });
      expect(second).toEqual({ granted: false, note: "duplicate" });
      expect((await extra(workspaceId)).granted).toBe(pack.amount);
    });

    it("a full refund takes the whole pack back", async () => {
      const workspaceId = newWs();
      await grantExtraPack({
        workspaceId,
        packKey: "images20",
        reference: "pi_full",
        now: NOW,
      });

      const result = await reconcilePackRefund({
        workspaceId,
        packKey: "images20",
        reference: "pi_full",
        charge: charge(pack.priceCents, pack.priceCents),
        now: NOW,
      });

      expect(result).toEqual({ revoked: BigInt(pack.amount) });
      expect((await extra(workspaceId)).granted).toBe(0);
    });

    it("partial refunds add up without taking anything twice", async () => {
      const workspaceId = newWs();
      await grantExtraPack({
        workspaceId,
        packKey: "images20",
        reference: "pi_part",
        now: NOW,
      });
      const half = pack.priceCents / 2;

      const first = await reconcilePackRefund({
        workspaceId,
        packKey: "images20",
        reference: "pi_part",
        charge: charge(pack.priceCents, half),
        now: NOW,
      });
      expect(first).toEqual({ revoked: BigInt(pack.amount / 2) });

      // The same refund state is delivered again.
      const replay = await reconcilePackRefund({
        workspaceId,
        packKey: "images20",
        reference: "pi_part",
        charge: charge(pack.priceCents, half),
        now: NOW,
      });
      expect(replay).toEqual({ revoked: BigInt(0) });
      expect((await extra(workspaceId)).granted).toBe(pack.amount / 2);

      // The rest is refunded later.
      const rest = await reconcilePackRefund({
        workspaceId,
        packKey: "images20",
        reference: "pi_part",
        charge: charge(pack.priceCents, pack.priceCents),
        now: NOW,
      });
      expect(rest).toEqual({ revoked: BigInt(pack.amount / 2) });
      expect((await extra(workspaceId)).granted).toBe(0);
      expect(await refundRows(workspaceId)).toHaveLength(2);
    });

    it("keeps what the customer already used", async () => {
      const workspaceId = newWs();
      await grantExtraPack({
        workspaceId,
        packKey: "images20",
        reference: "pi_used",
        now: NOW,
      });
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        data: { extraUsed: BigInt(14) },
      });

      const result = await reconcilePackRefund({
        workspaceId,
        packKey: "images20",
        reference: "pi_used",
        charge: charge(pack.priceCents, pack.priceCents),
        now: NOW,
      });

      expect(result).toEqual({ revoked: BigInt(6) });
      expect(await extra(workspaceId)).toMatchObject({ granted: 14, used: 14 });
    });

    it("has nothing to do for a payment it never granted or a charge with no refund", async () => {
      const workspaceId = newWs();
      expect(
        await reconcilePackRefund({
          workspaceId,
          packKey: "images20",
          reference: "pi_unknown",
          charge: charge(pack.priceCents, pack.priceCents),
          now: NOW,
        }),
      ).toMatchObject({ revoked: BigInt(0), note: "no-grant" });
      expect(
        await reconcilePackRefund({
          workspaceId,
          packKey: "images20",
          reference: "pi_unknown",
          charge: charge(pack.priceCents, 0),
          now: NOW,
        }),
      ).toMatchObject({ revoked: BigInt(0), note: "nothing-refunded" });
    });
  });

  describe("subscription refund and chargeback", () => {
    async function paying(workspaceId: string) {
      const fake = createFakeStripe();
      const customerId = `cus_${workspaceId}`;
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
      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: invoice,
        now: NOW,
      });
      return { fake, sub, invoice };
    }

    it("a full refund ends access now and takes back the unused window, keeping what was used", async () => {
      const workspaceId = newWs();
      const { sub, invoice } = await paying(workspaceId);
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
        data: { periodUsed: BigInt(7) },
      });

      const result = await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice,
        reason: "REFUNDED",
        now: NOW,
      });

      expect(result).toEqual({ applied: true, alreadyEnded: false });
      const row = await prisma.subscription.findUniqueOrThrow({
        where: { workspaceId },
      });
      expect(row).toMatchObject({
        status: "CANCELED",
        endedReason: "REFUNDED",
      });
      expect(row.paidThrough).toEqual(NOW);
      expect(await period(workspaceId)).toMatchObject({ granted: 7, used: 7 });
      expect(await period(workspaceId, "AI_MICROS")).toMatchObject({
        granted: 0,
      });
      expect(await getEntitlements(workspaceId, { now: NOW })).toMatchObject({
        access: "READ_ONLY",
        reason: "CANCELED",
      });
    });

    it("is idempotent: the same refund again changes nothing", async () => {
      const workspaceId = newWs();
      const { sub, invoice } = await paying(workspaceId);
      await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice,
        reason: "REFUNDED",
        now: NOW,
      });
      const before = await prisma.usageGrant.count({
        where: { workspaceId, reason: "REFUND" },
      });

      const again = await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice,
        reason: "REFUNDED",
        now: new Date(NOW.getTime() + 60_000),
      });

      expect(again).toEqual({ applied: true, alreadyEnded: true });
      expect(
        await prisma.usageGrant.count({
          where: { workspaceId, reason: "REFUND" },
        }),
      ).toBe(before);
    });

    it("a chargeback is recorded as such", async () => {
      const workspaceId = newWs();
      const { sub, invoice } = await paying(workspaceId);

      await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice,
        reason: "CHARGEBACK",
        now: NOW,
      });

      expect(
        (
          await prisma.subscription.findUniqueOrThrow({
            where: { workspaceId },
          })
        ).endedReason,
      ).toBe("CHARGEBACK");
    });

    it("leaves bought packs alone", async () => {
      const workspaceId = newWs();
      const { sub, invoice } = await paying(workspaceId);
      await grantExtraPack({
        workspaceId,
        packKey: "images20",
        reference: "pi_keep",
        now: NOW,
      });

      await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice,
        reason: "REFUNDED",
        now: NOW,
      });

      expect((await extra(workspaceId)).granted).toBe(
        EXTRA_PACKS.images20.amount,
      );
    });

    it("an older period's invoice or a proration invoice does not end the subscription", async () => {
      const workspaceId = newWs();
      const { fake, sub, invoice } = await paying(workspaceId);
      // Renewal paid: the current period now runs to the end of January.
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: new Date("2027-01-01T00:00:00.000Z"),
      });
      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: renewal,
        now: new Date("2026-12-01T01:00:00.000Z"),
      });

      const old = await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice,
        reason: "REFUNDED",
        now: new Date("2026-12-05T00:00:00.000Z"),
      });
      const proration = await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice: {
          ...renewal,
          periodStart: null,
          periodEnd: null,
          hasProration: true,
        },
        reason: "REFUNDED",
        now: new Date("2026-12-05T00:00:00.000Z"),
      });

      expect(old).toEqual({ applied: false, note: "older-period" });
      expect(proration).toEqual({
        applied: false,
        note: "not-a-period-invoice",
      });
      expect(
        (
          await prisma.subscription.findUniqueOrThrow({
            where: { workspaceId },
          })
        ).status,
      ).toBe("ACTIVE");
    });

    it("does nothing for a subscription that is not the linked one", async () => {
      const workspaceId = newWs();
      const { fake, invoice } = await paying(workspaceId);
      const other = fake.subscription({ customerId: "cus_other" });

      const result = await endSubscriptionAfterRefund({
        workspaceId,
        sub: other,
        invoice,
        reason: "REFUNDED",
        now: NOW,
      });

      expect(result).toEqual({ applied: false, note: "stale-subscription" });
    });

    it("a new payment after a refund brings the subscription back (money in, access back)", async () => {
      const workspaceId = newWs();
      const { fake, sub, invoice } = await paying(workspaceId);
      await endSubscriptionAfterRefund({
        workspaceId,
        sub,
        invoice,
        reason: "REFUNDED",
        now: NOW,
      });
      const renewal = fake.invoice({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        billingReason: "subscription_cycle",
        periodStart: T1,
        periodEnd: new Date("2027-01-01T00:00:00.000Z"),
      });

      await syncSubscriptionState({
        workspaceId,
        sub,
        paid: renewal,
        now: new Date("2026-12-01T01:00:00.000Z"),
      });

      const row = await prisma.subscription.findUniqueOrThrow({
        where: { workspaceId },
      });
      expect(row).toMatchObject({ status: "ACTIVE", endedReason: null });
      expect(quotaFor("growth").IMAGE).toBeGreaterThan(0);
      expect((await period(workspaceId)).granted).toBe(
        quotaFor("growth").IMAGE,
      );
    });
  });
});
