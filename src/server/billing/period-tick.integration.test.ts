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
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
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
    await prisma.systemHeartbeat.deleteMany({
      where: { key: { in: ["billing.tick", "billing.drain"] } },
    });
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

  it("off: defter işlerine dokunmaz (pencere, bakiye, bakım kilidi), hiçbir şey değişmez", async () => {
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


  describe("park edilmiş iş ve uzlaştırma (Faz 3)", () => {
    const executionFixtures: AgencyFixture[] = [];

    afterAll(async () => {
      for (const fixture of executionFixtures) {
        const where = { workspaceId: fixture.workspaceId };
        await prisma.outboxEvent.deleteMany({ where });
        await prisma.executionJob.deleteMany({ where });
        await prisma.task.deleteMany({ where });
        await prisma.auditLog.deleteMany({ where });
        await teardownAgencyFixture(fixture.workspaceId);
      }
    });

    async function parkedJob(images: number) {
      const fixture = await createAgencyFixture(
        `${runId}-tick-${executionFixtures.length}`,
      );
      executionFixtures.push(fixture);
      await prisma.subscription.create({
        data: {
          workspaceId: fixture.workspaceId,
          planKey: "growth",
          interval: "MONTH",
          status: "ACTIVE",
          quotaAnchor: NOV,
          paidThrough: new Date("2027-01-01T00:00:00.000Z"),
        },
      });
      await prisma.usageBalance.create({
        data: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          unit: "IMAGE",
          periodStart: NOV,
          periodEnd: new Date("2026-12-01T00:00:00.000Z"),
          periodGranted: BigInt(images),
          updatedAt: new Date("2026-11-15T12:00:00.000Z"),
        },
      });
      const task = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          title: "A post",
          capability: "CREATE_SOCIAL_CREATIVE",
          status: "QUEUED",
          riskLevel: "LOW",
          createdByType: "USER",
        },
      });
      const job = await prisma.executionJob.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          taskId: task.id,
          capability: "CREATE_SOCIAL_CREATIVE",
          providerType: "SYSTEM",
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          requestPayload: { request: "x" } as never,
          status: "WAITING_BUDGET",
        },
      });
      // Parked an hour before the simulated clock below.
      await prisma.$executeRaw`UPDATE "ExecutionJob" SET "updatedAt" = ${new Date("2026-11-15T11:00:00.000Z")} WHERE id = ${job.id}`;
      return { fixture, job };
    }

    it("bakım adımı, hakkı yenilenen workspace'in park edilmiş işini kuyruğa döndürür", async () => {
      const { job } = await parkedJob(1);
      const work = await runBillingTick(new Date("2026-11-15T12:00:00.000Z"));
      expect(work).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.executionJob.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe("QUEUED");
    });

    it("teslim edilmiş işin süresi dolan rezervasyonu iade edilmez, mahsup edilir (süreç çökmesi)", async () => {
      const { fixture, job } = await parkedJob(3);
      await prisma.executionJob.update({
        where: { id: job.id },
        data: { status: "COMPLETED" },
      });
      // The process died after the job was delivered and before it settled.
      const t0 = new Date("2026-11-15T12:00:00.000Z");
      const held = await reserveUsage({
        workspaceId: fixture.workspaceId,
        unit: "IMAGE",
        amount: 1,
        reservationKey: `exec:${job.id}#evt.1`,
        operationId: `exec:${job.id}`,
        ttlMs: 60_000,
        now: t0,
      });
      expect(held.ok).toBe(true);

      await runBillingTick(new Date(t0.getTime() + 10 * 60_000));

      const row = await prisma.usageBalance.findUniqueOrThrow({
        where: {
          workspaceId_unit: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        },
      });
      expect(row.periodUsed).toBe(BigInt(1)); // charged, not handed back
      expect(row.periodReserved).toBe(BigInt(0));
      const reservation = await prisma.usageReservation.findFirstOrThrow({
        where: { workspaceId: fixture.workspaceId },
      });
      expect(reservation.status).toBe("SETTLED");
    });

    it("başarısız ya da bitmemiş işin süresi dolan rezervasyonu iade edilir", async () => {
      const { fixture, job } = await parkedJob(3);
      await prisma.executionJob.update({
        where: { id: job.id },
        data: { status: "FAILED" },
      });
      const t0 = new Date("2026-11-15T12:00:00.000Z");
      await reserveUsage({
        workspaceId: fixture.workspaceId,
        unit: "IMAGE",
        amount: 1,
        reservationKey: `exec:${job.id}#evt.1`,
        operationId: `exec:${job.id}`,
        ttlMs: 60_000,
        now: t0,
      });
      await runBillingTick(new Date(t0.getTime() + 10 * 60_000));
      const row = await prisma.usageBalance.findUniqueOrThrow({
        where: {
          workspaceId_unit: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        },
      });
      expect(row.periodUsed).toBe(BigInt(0));
      expect(row.periodReserved).toBe(BigInt(0));
    });

    it("shadow: park edilmiş kalıntıyı hakka bakmadan boşaltır", async () => {
      config.current = { ...config.current, mode: "shadow" };
      const { job } = await parkedJob(0);
      await runBillingTick(new Date("2026-11-15T12:00:00.000Z"));
      expect(
        (await prisma.executionJob.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe("QUEUED");
    });

    it("off: saatte bir park edilmiş işi boşaltır (kill-switch), arada tekrar etmez", async () => {
      config.current = { ...config.current, mode: "off" };
      const { job } = await parkedJob(0);
      const t0 = new Date("2026-11-15T12:00:00.000Z");
      expect(await runBillingTick(t0)).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.executionJob.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe("QUEUED");

      // An hour has not passed: nothing is looked at again.
      const { job: second } = await parkedJob(0);
      expect(await runBillingTick(new Date(t0.getTime() + 60_000))).toBe(0);
      expect(
        (await prisma.executionJob.findUniqueOrThrow({ where: { id: second.id } }))
          .status,
      ).toBe("WAITING_BUDGET");
      // The next hour picks it up.
      resetBillingTickThrottle();
      await prisma.systemHeartbeat.deleteMany({ where: { key: "billing.drain" } });
      await runBillingTick(new Date(t0.getTime() + 61 * 60_000));
      expect(
        (await prisma.executionJob.findUniqueOrThrow({ where: { id: second.id } }))
          .status,
      ).toBe("QUEUED");
    });
  });
});
