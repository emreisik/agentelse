import { randomUUID } from "node:crypto";

import type { ExecutionJobStatus } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
import { settleDeliveredOrphans } from "./reconcile";

// Çökme uzlaştırması (reconcile.ts) GERÇEK Postgres'e karşı: süreç `finish`'ten önce
// ölünce süresi dolan `exec:<jobId>` rezervasyonu, iş teslim edilmişse (COMPLETED /
// VERIFYING) mahsup edilir, aksi halde süpürücünün iadesine bırakılır.
//
// Zaman: her çağrıya açıkça verilir ve duvar saatinden türetilen, ondan 60 günden
// fazla GERİDE bir ayda yaşar. Bir adım verilen zaman yerine duvar saatine düşerse
// planı bitmiş, rezervasyonları çoktan dolmuş bir dünya görür ve test kırılır.

const B = (value: number) => BigInt(value);
const DAY = 86_400_000;
const runId = randomUUID().slice(0, 8);

const anchor = new Date(Date.now() - 90 * DAY);
const WINDOW_START = new Date(
  Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1),
);
const WINDOW_END = new Date(
  Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1),
);
const HELD_AT = new Date(WINDOW_START.getTime() + 14 * DAY);
const TTL_MS = 60_000;
const AFTER_EXPIRY = new Date(HELD_AT.getTime() + 10 * 60_000);

type Unit = "IMAGE" | "AI_MICROS";
type JobRef = { workspaceId: string; jobId: string; operationId: string };

const fixtures: AgencyFixture[] = [];
const ELSEWHERE = `ws_rec_${runId}_elsewhere`;

// Bir workspace + planı + iki birimde bakiyesi + verilen durumda bir yürütme işi.
async function newJob(jobStatus: ExecutionJobStatus): Promise<JobRef> {
  const fixture = await createAgencyFixture(`${runId}-rec-${fixtures.length}`);
  fixtures.push(fixture);
  const { workspaceId, projectId, brandId } = fixture;
  await prisma.subscription.create({
    data: {
      workspaceId,
      planKey: "growth",
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: WINDOW_START,
      paidThrough: WINDOW_END,
    },
  });
  for (const [unit, granted] of [
    ["IMAGE", 10],
    ["AI_MICROS", 3_000_000],
  ] as const) {
    await prisma.usageBalance.create({
      data: {
        id: randomUUID(),
        workspaceId,
        unit,
        periodStart: WINDOW_START,
        periodEnd: WINDOW_END,
        periodGranted: B(granted),
        updatedAt: HELD_AT,
      },
    });
  }
  const task = await prisma.task.create({
    data: {
      workspaceId,
      projectId,
      brandId,
      title: "A post",
      capability: "CREATE_SOCIAL_CREATIVE",
      status: "QUEUED",
      riskLevel: "LOW",
      createdByType: "USER",
    },
  });
  const job = await prisma.executionJob.create({
    data: {
      workspaceId,
      projectId,
      brandId,
      taskId: task.id,
      capability: "CREATE_SOCIAL_CREATIVE",
      providerType: "SYSTEM",
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestPayload: { request: "x" } as never,
      status: jobStatus,
    },
  });
  return { workspaceId, jobId: job.id, operationId: `exec:${job.id}` };
}

// The process died holding this: a RESERVED hold of the job's operation.
async function hold(
  job: JobRef,
  unit: Unit,
  amount: number,
  options: { ttlMs?: number; attempt?: string } = {},
) {
  const result = await reserveUsage({
    workspaceId: job.workspaceId,
    unit,
    amount,
    reservationKey: `${job.operationId}#${options.attempt ?? "evt.1"}`,
    operationId: job.operationId,
    ttlMs: options.ttlMs ?? TTL_MS,
    now: HELD_AT,
  });
  expect(result).toMatchObject({ ok: true, kind: "RESERVED" });
}

// One recorded paid call (a UsageEntry row, as the recorder writes it).
function metered(workspaceId: string, operationId: string, costMicros: number) {
  return prisma.usageEntry.create({
    data: {
      workspaceId,
      operationId,
      callId: randomUUID(),
      kind: "TEXT",
      purpose: "test",
      provider: "openai",
      model: "test-model",
      costMicros: B(costMicros),
      costEstimated: false,
      success: true,
      durationMs: 1,
      priceTable: "test",
    },
  });
}

const holdOf = (job: JobRef, unit: Unit) =>
  prisma.usageReservation.findFirstOrThrow({
    where: {
      workspaceId: job.workspaceId,
      unit,
      operationId: job.operationId,
    },
  });

async function balanceOf(workspaceId: string, unit: Unit) {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  return { used: Number(row.periodUsed), reserved: Number(row.periodReserved) };
}

// The step scans every workspace's expired holds; a roomy limit keeps rows left
// behind by other suites from crowding these out.
const sweep = (now: Date) => settleDeliveredOrphans({ now, limit: 1000 });

describeIntegration("crash reconciliation of delivered jobs", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      await teardownAgencyFixture(fixture.workspaceId);
    }
    await prisma.usageEntry.deleteMany({ where: { workspaceId: ELSEWHERE } });
  });

  describe("an AI budget hold", () => {
    it.each(["COMPLETED", "VERIFYING"] as const)(
      "of a %s job is charged what its attempts measurably cost, and the rest goes back",
      async (status) => {
        const job = await newJob(status);
        await hold(job, "AI_MICROS", 90_000, { attempt: "evt.2" });
        // Two attempts of the same job, both billed. The operation id is shared by
        // all of a job's attempts, so the step sees the calls of both.
        await metered(job.workspaceId, job.operationId, 30_000); // attempt 1
        await metered(job.workspaceId, job.operationId, 25_000); // attempt 2
        await metered(job.workspaceId, job.operationId, 15_000); // attempt 2
        // Not this job's cost: another operation of the workspace, and the same
        // operation id seen from another workspace.
        await metered(job.workspaceId, `exec:other-${runId}`, 500_000);
        await metered(ELSEWHERE, job.operationId, 500_000);

        const settled = await sweep(AFTER_EXPIRY);

        expect(settled).toBeGreaterThanOrEqual(1);
        expect(await holdOf(job, "AI_MICROS")).toMatchObject({
          status: "SETTLED",
          settledAmount: B(70_000),
        });
        expect(await balanceOf(job.workspaceId, "AI_MICROS")).toEqual({
          used: 70_000,
          reserved: 0,
        });
      },
    );

    it("is never charged more than was held, however much the attempts cost", async () => {
      const job = await newJob("COMPLETED");
      await hold(job, "AI_MICROS", 90_000);
      await metered(job.workspaceId, job.operationId, 60_000); // attempt 1
      await metered(job.workspaceId, job.operationId, 70_000); // attempt 2

      await sweep(AFTER_EXPIRY);

      expect(await holdOf(job, "AI_MICROS")).toMatchObject({
        status: "SETTLED",
        settledAmount: B(90_000),
      });
      expect(await balanceOf(job.workspaceId, "AI_MICROS")).toEqual({
        used: 90_000,
        reserved: 0,
      });
    });

    it("is settled at zero when nothing was recorded for the job", async () => {
      const job = await newJob("COMPLETED");
      await hold(job, "AI_MICROS", 90_000);

      await sweep(AFTER_EXPIRY);

      expect(await holdOf(job, "AI_MICROS")).toMatchObject({
        status: "SETTLED",
        settledAmount: B(0),
      });
      expect(await balanceOf(job.workspaceId, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 0,
      });
    });
  });

  describe("an image hold", () => {
    it("of a delivered job is charged at the reserved count, whatever was recorded", async () => {
      const job = await newJob("COMPLETED");
      await hold(job, "IMAGE", 3);
      // Pictures are rights, not micro-dollars: with no usage rows at all the
      // delivered job still spends the rights it held.

      await sweep(AFTER_EXPIRY);

      expect(await holdOf(job, "IMAGE")).toMatchObject({
        status: "SETTLED",
        settledAmount: B(3),
      });
      expect(await balanceOf(job.workspaceId, "IMAGE")).toEqual({
        used: 3,
        reserved: 0,
      });
    });
  });

  describe("a hold that is left to the sweeper", () => {
    it.each(["FAILED", "RUNNING"] as const)(
      "stays untouched when its job is %s",
      async (status) => {
        const job = await newJob(status);
        await hold(job, "IMAGE", 1);
        await hold(job, "AI_MICROS", 90_000);
        await metered(job.workspaceId, job.operationId, 40_000);

        await sweep(AFTER_EXPIRY);

        for (const unit of ["IMAGE", "AI_MICROS"] as const) {
          expect(await holdOf(job, unit)).toMatchObject({
            status: "RESERVED",
            settledAmount: null,
          });
        }
        expect(await balanceOf(job.workspaceId, "IMAGE")).toEqual({
          used: 0,
          reserved: 1,
        });
        expect(await balanceOf(job.workspaceId, "AI_MICROS")).toEqual({
          used: 0,
          reserved: 90_000,
        });
      },
    );

    it("stays untouched until it has expired, and is settled from that very instant", async () => {
      const job = await newJob("COMPLETED");
      await hold(job, "AI_MICROS", 90_000);
      await metered(job.workspaceId, job.operationId, 40_000);
      const expiresAt = new Date(HELD_AT.getTime() + TTL_MS);

      // The last millisecond the process may still be running.
      await sweep(new Date(expiresAt.getTime() - 1));
      expect(await holdOf(job, "AI_MICROS")).toMatchObject({
        status: "RESERVED",
      });
      expect(await balanceOf(job.workspaceId, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 90_000,
      });

      // The sweeper treats a hold as expired from this instant on, so this step
      // must too: otherwise the sweeper could hand a delivered job's hold back first.
      await sweep(expiresAt);
      expect(await holdOf(job, "AI_MICROS")).toMatchObject({
        status: "SETTLED",
        settledAmount: B(40_000),
      });
    });
  });

  it("does nothing while billing is off", async () => {
    const job = await newJob("COMPLETED");
    await hold(job, "AI_MICROS", 90_000);
    await metered(job.workspaceId, job.operationId, 40_000);

    config.current = { ...config.current, mode: "off" };
    expect(await sweep(AFTER_EXPIRY)).toBe(0);
    expect(await holdOf(job, "AI_MICROS")).toMatchObject({
      status: "RESERVED",
    });

    // Positive control: the hold was there to be settled all along.
    config.current = { ...config.current, mode: "enforce" };
    await sweep(AFTER_EXPIRY);
    expect(await holdOf(job, "AI_MICROS")).toMatchObject({
      status: "SETTLED",
      settledAmount: B(40_000),
    });
  });

  it("reconciles in shadow mode too, where the holds are real ones", async () => {
    config.current = { ...config.current, mode: "shadow" };
    const job = await newJob("COMPLETED");
    await hold(job, "AI_MICROS", 90_000);
    await metered(job.workspaceId, job.operationId, 40_000);

    await sweep(AFTER_EXPIRY);

    expect(await holdOf(job, "AI_MICROS")).toMatchObject({
      status: "SETTLED",
      settledAmount: B(40_000),
    });
    expect(await balanceOf(job.workspaceId, "AI_MICROS")).toEqual({
      used: 40_000,
      reserved: 0,
    });
  });

  it("goes on past a hold it leaves alone and settles the delivered ones behind it", async () => {
    // The failed job's hold expires first, so it is looked at first.
    const failed = await newJob("FAILED");
    await hold(failed, "AI_MICROS", 90_000, { ttlMs: TTL_MS / 2 });
    const delivered = await newJob("COMPLETED");
    await hold(delivered, "AI_MICROS", 90_000, { ttlMs: TTL_MS });
    await metered(delivered.workspaceId, delivered.operationId, 20_000);

    const settled = await sweep(AFTER_EXPIRY);

    expect(settled).toBeGreaterThanOrEqual(1);
    expect(await holdOf(failed, "AI_MICROS")).toMatchObject({
      status: "RESERVED",
    });
    expect(await holdOf(delivered, "AI_MICROS")).toMatchObject({
      status: "SETTLED",
      settledAmount: B(20_000),
    });
  });
});
