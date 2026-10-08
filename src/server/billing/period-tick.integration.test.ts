import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

import { prisma } from "@/lib/prisma";
import { describeIntegration } from "@/test-support/integration-suite";

import { reserveUsage } from "./ledger";
import { resetBillingTickThrottle, runBillingTick } from "./period-tick";

// Bakım adımı gerçek Postgres'e karşı: vadesi gelen pencere yenilenir, ödenmiş ama
// bakiyesiz abonelik pencere kazanır, çökmüş rezervasyon iade edilir; off iken sorgusuz.
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_tick_${runId}_${++counter}`;
const NOV = new Date("2026-11-01T00:00:00.000Z");

describeIntegration("billing maintenance tick", () => {
  beforeEach(async () => {
    resetBillingTickThrottle();
    // claimPeriodic 5 dk'lık kilidi: önceki testin izini temizle.
    await prisma.systemHeartbeat.deleteMany({ where: { key: "billing.tick" } });
  });

  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_tick_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.systemHeartbeat.deleteMany({ where: { key: "billing.tick" } });
  });

  async function subscription(workspaceId: string, paidThrough: Date) {
    await prisma.subscription.create({
      data: {
        workspaceId,
        planKey: "growth",
        interval: "MONTH",
        status: "ACTIVE",
        quotaAnchor: NOV,
        paidThrough,
      },
    });
  }

  it("off: sorgusuz 0 (kilit satırı bile yazılmaz), hiçbir şey değişmez", async () => {
    config.current = { ...config.current, mode: "off" };
    const ws = newWs();
    await subscription(ws, new Date("2027-01-01T00:00:00.000Z"));
    expect(await runBillingTick(new Date("2026-12-02T00:00:00.000Z"))).toBe(0);
    expect(await prisma.usageBalance.count({ where: { workspaceId: ws } })).toBe(0);
    // Koruma kalkarsa claimPeriodic en az bu kilit satırını yazardı.
    expect(
      await prisma.systemHeartbeat.count({ where: { key: "billing.tick" } }),
    ).toBe(0);
  });

  it("ödenmiş ama bakiyesiz abonelik ilk pencereyi kazanır", async () => {
    const ws = newWs();
    await subscription(ws, new Date("2026-12-01T00:00:00.000Z"));
    const work = await runBillingTick(new Date("2026-11-15T12:00:00.000Z"));
    expect(work).toBeGreaterThanOrEqual(1);
    const rows = await prisma.usageBalance.findMany({
      where: { workspaceId: ws },
    });
    expect(rows.map((row) => row.unit).sort()).toEqual(["AI_MICROS", "IMAGE"]);
  });

  it("vadesi gelen pencere ÖDEME geldiyse yenilenir, ödeme gelmediyse yenilenmez", async () => {
    const paid = newWs();
    const unpaid = newWs();
    await subscription(paid, new Date("2027-01-01T00:00:00.000Z"));
    await subscription(unpaid, new Date("2026-12-01T00:00:00.000Z"));
    // Kasım penceresini kur ve kullandır.
    const nov = new Date("2026-11-15T12:00:00.000Z");
    for (const ws of [paid, unpaid]) {
      await reserveUsage({
        workspaceId: ws,
        unit: "IMAGE",
        amount: 10,
        reservationKey: "k#1",
        now: nov,
      });
      await prisma.usageBalance.update({
        where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
        data: { periodUsed: BigInt(10), periodReserved: BigInt(0) },
      });
      await prisma.usageReservation.deleteMany({ where: { workspaceId: ws } });
    }

    await runBillingTick(new Date("2026-12-01T02:00:00.000Z"));

    const paidRow = await prisma.usageBalance.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId: paid, unit: "IMAGE" } },
    });
    expect(paidRow.periodStart).toEqual(new Date("2026-12-01T00:00:00.000Z"));
    expect(paidRow.periodUsed).toBe(BigInt(0));
    const unpaidRow = await prisma.usageBalance.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId: unpaid, unit: "IMAGE" } },
    });
    // Ödenmemiş yenileme bedava pencere açmaz.
    expect(unpaidRow.periodStart).toEqual(NOV);
    expect(unpaidRow.periodUsed).toBe(BigInt(10));
  });

  it("çökmüş rezervasyonu iade eder", async () => {
    const ws = newWs();
    await subscription(ws, new Date("2026-12-01T00:00:00.000Z"));
    const now = new Date("2026-11-15T12:00:00.000Z");
    await runBillingTick(now);
    resetBillingTickThrottle();
    await prisma.systemHeartbeat.deleteMany({ where: { key: "billing.tick" } });
    await reserveUsage({
      workspaceId: ws,
      unit: "IMAGE",
      amount: 5,
      reservationKey: "zombie#1",
      now,
      ttlMs: 60_000,
    });
    expect(
      (
        await prisma.usageBalance.findUniqueOrThrow({
          where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
        })
      ).periodReserved,
    ).toBe(BigInt(5));

    await runBillingTick(new Date(now.getTime() + 10 * 60_000));
    const after = await prisma.usageBalance.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId: ws, unit: "IMAGE" } },
    });
    expect(after.periodReserved).toBe(BigInt(0));
    expect(
      (
        await prisma.usageReservation.findFirstOrThrow({
          where: { workspaceId: ws },
        })
      ).status,
    ).toBe("RELEASED");
  });

  it("5 dakikalık kısma: ilk çağrıdan sonra çıkan iş, aynı pencerede işlenmez; sonraki pencerede işlenir", async () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    await runBillingTick(now);

    // İlk çağrıdan SONRA bir iş çıkıyor: ödenmiş ama bakiyesiz abonelik.
    const ws = newWs();
    await subscription(ws, new Date("2026-12-01T00:00:00.000Z"));
    expect(await runBillingTick(new Date(now.getTime() + 60_000))).toBe(0);
    expect(await prisma.usageBalance.count({ where: { workspaceId: ws } })).toBe(0);

    // Bellek içi kısma bu süreçte sıfırlansa bile paylaşılan kilit (SystemHeartbeat)
    // aynı 5 dakikayı tutar: süreçler arası tek çalıştırıcı.
    resetBillingTickThrottle();
    expect(await runBillingTick(new Date(now.getTime() + 2 * 60_000))).toBe(0);
    expect(await prisma.usageBalance.count({ where: { workspaceId: ws } })).toBe(0);

    // 5 dakika geçince iş işlenir.
    resetBillingTickThrottle();
    expect(
      await runBillingTick(new Date(now.getTime() + 6 * 60_000)),
    ).toBeGreaterThanOrEqual(1);
    expect(await prisma.usageBalance.count({ where: { workspaceId: ws } })).toBe(2);
  });
});
