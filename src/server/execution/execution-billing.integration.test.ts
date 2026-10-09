import { randomUUID } from "node:crypto";

import type { ExecutionProvider, ProviderUsageEstimate } from "./types";
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
vi.mock("@/server/billing/config", () => ({
  getBillingConfig: () => config.current,
}));

// The one provider every job in this suite is routed to. What it declares and
// what it does are set per test.
const fake = vi.hoisted(() => ({
  provider: null as unknown as ExecutionProvider,
  executed: 0,
  estimate: undefined as ProviderUsageEstimate | undefined,
  onExecute: undefined as (() => Promise<void> | void) | undefined,
  status: {
    status: "COMPLETED",
    rawResult: { text: "ok" },
    isMock: false,
  } as {
    status: "COMPLETED" | "FAILED" | "RUNNING";
    rawResult?: unknown;
    errorMessage?: string;
    isMock: boolean;
  },
  getStatusThrows: false,
}));

vi.mock("@/server/execution/capability-router", () => ({
  CapabilityRouter: {
    route: async () => fake.provider,
    resolveBrowserProfile: async () => undefined,
  },
}));
vi.mock("@/server/execution/provider-registry", () => ({
  ProviderRegistry: {
    getByKey: (key: string) => (key === "test-ai" ? fake.provider : undefined),
    all: () => [fake.provider],
    registered: () => [fake.provider],
  },
}));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { beginOperation } from "@/server/billing/operation";
import { resumeParkedWork } from "@/server/billing/park";
import { settleDeliveredOrphans } from "@/server/billing/reconcile";
import { getUsageScope } from "@/server/billing/usage-context";
import { dispatchAttemptToken } from "@/server/execution/attempt-token";
import { usageNeedOf } from "@/server/execution/usage-need";
import { ExecutionJobRepository } from "@/server/repositories/execution-job.repository";
import { describeIntegration } from "@/test-support/integration-suite";

import { ExecutionService } from "./execution-service";

// The real startExecution against a real Postgres and the real ledger: what the
// plan allowance does to a job from the moment the worker picks it up. Only the
// provider is a double.

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
const fixtures: AgencyFixture[] = [];

// The quota window around the REAL clock (the ledger decides on it): starts a few
// days ago and runs well past any plausible test run, so the file never goes stale.
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_START = new Date(Date.now() - 5 * DAY_MS);
const WINDOW_END = new Date(Date.now() + 400 * DAY_MS);

fake.provider = {
  key: "test-ai",
  type: "AI",
  isConfigured: true,
  canExecute: async () => true,
  usageEstimate: () => fake.estimate as ProviderUsageEstimate,
  async execute(request) {
    fake.executed += 1;
    await fake.onExecute?.();
    return { executionReference: request.correlationId, isMock: false };
  },
  async getStatus() {
    if (fake.getStatusThrows) throw new Error("status lookup exploded");
    return fake.status;
  },
};

type Unit = "IMAGE" | "AI_MICROS";

async function funded(options: { images?: number; micros?: number } | null) {
  const fixture = await createAgencyFixture(`${runId}-${fixtures.length}`);
  fixtures.push(fixture);
  if (options) {
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: "growth",
        interval: "MONTH",
        status: "ACTIVE",
        quotaAnchor: WINDOW_START,
        paidThrough: WINDOW_END,
      },
    });
    for (const [unit, granted] of [
      ["IMAGE", options.images ?? 0],
      ["AI_MICROS", options.micros ?? 0],
    ] as const) {
      await prisma.usageBalance.create({
        data: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          unit,
          periodStart: WINDOW_START,
          periodEnd: WINDOW_END,
          periodGranted: B(granted),
          updatedAt: new Date(),
        },
      });
    }
  }
  return fixture;
}

async function queuedJob(
  fixture: AgencyFixture,
  options: { taskStatus?: "QUEUED" | "CANCELLED" } = {},
) {
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      title: "Write a post",
      capability: "CREATE_COPY",
      status: options.taskStatus ?? "QUEUED",
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
      capability: "CREATE_COPY",
      providerType: "SYSTEM",
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestPayload: { request: "write" } as never,
      status: "QUEUED",
    },
  });
  return { task, job };
}

async function balanceOf(workspaceId: string, unit: Unit) {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  // Both pools: an extra pack is spent after the plan's own allowance.
  return {
    used: Number(row.periodUsed + row.extraUsed),
    reserved: Number(row.periodReserved + row.extraReserved),
  };
}

const taskStatus = async (id: string) =>
  (await prisma.task.findUniqueOrThrow({ where: { id } })).status;

const draws = (images: number) => () => {
  getUsageScope()?.meter?.add({
    callId: randomUUID(),
    kind: "IMAGE",
    costMicros: B(80_000),
    success: true,
    units: images,
  });
};
const spends = (micros: number) => () => {
  getUsageScope()?.meter?.add({
    callId: randomUUID(),
    kind: "TEXT",
    costMicros: B(micros),
    success: true,
  });
};

describeIntegration("a job against the plan allowance (startExecution)", () => {
  beforeEach(() => {
    fake.executed = 0;
    fake.estimate = undefined;
    fake.onExecute = undefined;
    fake.getStatusThrows = false;
    fake.status = {
      status: "COMPLETED",
      rawResult: { text: "ok" },
      isMock: false,
    };
  });

  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      const where = { workspaceId: fixture.workspaceId };
      await prisma.outboxEvent.deleteMany({ where });
      await prisma.executionJob.deleteMany({ where });
      await prisma.task.deleteMany({ where });
      await prisma.auditLog.deleteMany({ where });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  describe("a picture job", () => {
    beforeEach(() => {
      fake.estimate = { class: "content", images: 1 };
    });

    it("reserves before it starts and charges the pictures it delivered", async () => {
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job, task } = await queuedJob(fixture);
      let heldWhileRunning = -1;
      fake.onExecute = async () => {
        heldWhileRunning = (await balanceOf(fixture.workspaceId, "IMAGE"))
          .reserved;
        draws(1)();
      };

      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });

      expect(result.status).toBe("COMPLETED");
      expect(await taskStatus(task.id)).toBe("COMPLETED");
      expect(heldWhileRunning).toBe(1); // paid for BEFORE the provider ran
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 1,
        reserved: 0,
      });
    });

    it("hands the right back when the provider reports a failure", async () => {
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = draws(1);
      fake.status = {
        status: "FAILED",
        errorMessage: "the model said no",
        isMock: false,
      };

      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });

      expect(result.status).toBe("FAILED");
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    // The provider has done the work and the job carries its reference, so the
    // poller can finish it later; a redelivery returns early and never re-runs it.
    // Handing the right back here would give the picture away: the hold stays open
    // and is settled for what was delivered (billing/reconcile.ts).
    it("keeps the hold open when the status lookup fails after the provider ran, and charges the picture once it is delivered", async () => {
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = draws(1);
      fake.getStatusThrows = true;

      await expect(
        ExecutionService.startExecution(job.id, "LOW", {
          attemptToken: "evt.1",
        }),
      ).rejects.toThrow("status lookup exploded");

      // Not refunded, not charged yet.
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 1,
      });

      // The poller finishes the job on its next tick; the provider is not run again.
      fake.getStatusThrows = false;
      const finished = await ExecutionService.pollOnce(job.id);
      expect(finished.status).toMatch(/COMPLETED|VERIFYING/);
      const again = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.2",
      });
      expect(again.id).toBe(job.id);
      expect(fake.executed).toBe(1);

      // The hold runs out; the reconciler sees a delivered job and charges it.
      await prisma.usageReservation.updateMany({
        where: { workspaceId: fixture.workspaceId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      expect(await settleDeliveredOrphans({ limit: 500 })).toBeGreaterThanOrEqual(1);
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 1,
        reserved: 0,
      });
    });

    it("hands the right back when the provider call itself fails: nothing was accepted, the retry re-runs and pays", async () => {
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = () => {
        throw new Error("provider call exploded");
      };

      await expect(
        ExecutionService.startExecution(job.id, "LOW", {
          attemptToken: "evt.1",
        }),
      ).rejects.toThrow("provider call exploded");

      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    it("leaves the reservation open while the provider has not decided", async () => {
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = draws(1);
      fake.status = { status: "RUNNING", isMock: false };

      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });

      expect(result.status).toBe("RUNNING");
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 1,
      });
    });

    it("parks the job when the pictures are used up: waiting, with no side effects", async () => {
      const fixture = await funded({ images: 0, micros: 3_000_000 });
      const { job, task } = await queuedJob(fixture);

      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });

      expect(result.status).toBe("WAITING_BUDGET");
      expect(result.errorCode).toBe("QUOTA_EXCEEDED");
      expect(fake.executed).toBe(0); // the provider was never called
      expect(await taskStatus(task.id)).toBe("QUEUED"); // not RUNNING, no card
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
      });
      expect(
        await prisma.auditLog.count({
          where: { entityId: job.id, action: "billing.job.parked" },
        }),
      ).toBe(1);
    });

    it("parks a job of a workspace without a plan as NO_PLAN", async () => {
      const fixture = await funded(null);
      const { job } = await queuedJob(fixture);
      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });
      expect(result.status).toBe("WAITING_BUDGET");
      expect(result.errorCode).toBe("NO_PLAN");
      expect(fake.executed).toBe(0);
    });

    it("lets exactly the affordable jobs run when many start at once", async () => {
      const fixture = await funded({ images: 5, micros: 3_000_000 });
      const jobs = await Promise.all(
        Array.from({ length: 12 }, () => queuedJob(fixture)),
      );
      fake.onExecute = draws(1);

      const results = await Promise.all(
        jobs.map(({ job }, index) =>
          ExecutionService.startExecution(job.id, "LOW", {
            attemptToken: `evt.${index}`,
          }),
        ),
      );

      expect(results.filter((r) => r.status === "COMPLETED")).toHaveLength(5);
      expect(results.filter((r) => r.status === "WAITING_BUDGET")).toHaveLength(
        7,
      );
      expect(fake.executed).toBe(5);
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 5,
        reserved: 0,
      });
    });

    it("closes a job whose task was cancelled instead of spending on it", async () => {
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job } = await queuedJob(fixture, { taskStatus: "CANCELLED" });
      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });
      expect(result.status).toBe("CANCELLED");
      expect(fake.executed).toBe(0);
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    it("goes on to run, paid once, after the allowance comes back (park -> resume -> start)", async () => {
      // The resume step sizes a parked job from its capability and payload alone,
      // so the capability has to belong to the class the provider declares.
      const need = usageNeedOf("CREATE_COPY", { request: "write" })!;
      expect(need.unit).toBe("AI_MICROS");
      fake.estimate = {
        class: "ai",
        maxCostUsd: Number(need.amount) / 1_000_000,
      };
      const fixture = await funded({ images: 0, micros: 0 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = spends(Number(need.amount) - 5_000);

      const parked = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });
      expect(parked.status).toBe("WAITING_BUDGET");

      // An extra pack arrives.
      await prisma.usageBalance.update({
        where: {
          workspaceId_unit: {
            workspaceId: fixture.workspaceId,
            unit: "AI_MICROS",
          },
        },
        data: { extraGranted: B(250_000) },
      });
      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
      });
      expect(summary.resumed).toBe(1);
      expect(await balanceOf(fixture.workspaceId, "AI_MICROS")).toEqual({
        used: 0,
        reserved: Number(need.amount),
      });

      // The worker takes the new dispatch event and starts with ITS token.
      const [event] = await prisma.outboxEvent.findMany({
        where: { executionJobId: job.id, status: "PENDING" },
      });
      const { attemptToken } = event!.payload as { attemptToken: string };
      const finished = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken,
      });

      expect(finished.status).toBe("COMPLETED");
      expect(finished.errorCode).toBeNull();
      // One reservation for the whole story, settled once, at the metered cost.
      const reservations = await prisma.usageReservation.findMany({
        where: { workspaceId: fixture.workspaceId, unit: "AI_MICROS" },
      });
      expect(reservations).toHaveLength(1);
      expect(reservations[0]!.status).toBe("SETTLED");
      expect(await balanceOf(fixture.workspaceId, "AI_MICROS")).toEqual({
        used: Number(need.amount) - 5_000,
        reserved: 0,
      });
    });

    // A resumed event keeps ONE payload token. Every failed attempt releases its
    // key, so the retries must not reuse it: they would burn through the reroll
    // keys and the job could no longer reserve (and never reach the dead letter).
    it("a resumed job's retries get their own keys and still pay once", async () => {
      const need = usageNeedOf("CREATE_COPY", { request: "write" })!;
      fake.estimate = {
        class: "ai",
        maxCostUsd: Number(need.amount) / 1_000_000,
      };
      const fixture = await funded({ images: 0, micros: 0 });
      const { job } = await queuedJob(fixture);
      await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });
      await prisma.usageBalance.update({
        where: {
          workspaceId_unit: {
            workspaceId: fixture.workspaceId,
            unit: "AI_MICROS",
          },
        },
        data: { extraGranted: B(Number(need.amount) * 10) },
      });
      await resumeParkedWork({ workspaceId: fixture.workspaceId });
      const [event] = await prisma.outboxEvent.findMany({
        where: { executionJobId: job.id, status: "PENDING" },
      });
      const payloadToken = (event!.payload as { attemptToken: string })
        .attemptToken;

      // Four attempts fail after the hold was taken; each one hands it back.
      fake.onExecute = () => {
        throw new Error("provider call exploded");
      };
      for (let attemptCount = 0; attemptCount < 4; attemptCount += 1) {
        await expect(
          ExecutionService.startExecution(job.id, "LOW", {
            attemptToken: dispatchAttemptToken(
              { id: event!.id, attemptCount },
              payloadToken,
            ),
          }),
        ).rejects.toThrow("provider call exploded");
        // The job went back to QUEUED for the next attempt (the worker's recovery).
        await prisma.executionJob.update({
          where: { id: job.id },
          data: {
            status: "QUEUED",
            providerId: null,
            providerExecutionReference: null,
          },
        });
      }

      // The fifth attempt - the last one before the dead letter - reserves and runs.
      fake.onExecute = spends(Number(need.amount) - 1_000);
      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: dispatchAttemptToken(
          { id: event!.id, attemptCount: 4 },
          payloadToken,
        ),
      });

      expect(result.status).toBe("COMPLETED");
      expect(await balanceOf(fixture.workspaceId, "AI_MICROS")).toEqual({
        used: Number(need.amount) - 1_000,
        reserved: 0,
      });
    });

    it("releases the allowance it held for a resumed job whose task was cancelled meanwhile", async () => {
      const need = usageNeedOf("CREATE_COPY", { request: "write" })!;
      fake.estimate = {
        class: "ai",
        maxCostUsd: Number(need.amount) / 1_000_000,
      };
      const fixture = await funded({ images: 0, micros: 0 });
      const { job, task } = await queuedJob(fixture);
      await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });
      await prisma.usageBalance.update({
        where: {
          workspaceId_unit: {
            workspaceId: fixture.workspaceId,
            unit: "AI_MICROS",
          },
        },
        data: { extraGranted: B(250_000) },
      });
      await resumeParkedWork({ workspaceId: fixture.workspaceId });
      expect(await balanceOf(fixture.workspaceId, "AI_MICROS")).toEqual({
        used: 0,
        reserved: Number(need.amount),
      });
      const [event] = await prisma.outboxEvent.findMany({
        where: { executionJobId: job.id, status: "PENDING" },
      });
      const { attemptToken } = event!.payload as { attemptToken: string };

      // The client cancels the task before the worker gets to the job.
      await prisma.task.update({
        where: { id: task.id },
        data: { status: "CANCELLED" },
      });
      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken,
      });

      expect(result.status).toBe("CANCELLED");
      expect(fake.executed).toBe(0);
      expect(await balanceOf(fixture.workspaceId, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 0,
      });
    });
  });

  describe("a text job (other-AI budget)", () => {
    it("settles the metered cost, not the estimate", async () => {
      fake.estimate = { class: "ai", maxCostUsd: 0.09 };
      const fixture = await funded({ images: 0, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = spends(31_000);

      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });

      expect(result.status).toBe("COMPLETED");
      expect(await balanceOf(fixture.workspaceId, "AI_MICROS")).toEqual({
        used: 31_000,
        reserved: 0,
      });
    });

    it("parks when the AI budget cannot cover the estimate", async () => {
      fake.estimate = { class: "ai", maxCostUsd: 0.09 };
      const fixture = await funded({ images: 5, micros: 50_000 });
      const { job } = await queuedJob(fixture);
      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });
      expect(result.status).toBe("WAITING_BUDGET");
      expect(fake.executed).toBe(0);
    });

    it("still charges a billed failure, up to what it reserved", async () => {
      fake.estimate = { class: "ai", maxCostUsd: 0.09 };
      const fixture = await funded({ images: 0, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = spends(400_000);
      fake.status = {
        status: "FAILED",
        errorMessage: "no text",
        isMock: false,
      };

      await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });

      expect(await balanceOf(fixture.workspaceId, "AI_MICROS")).toEqual({
        used: 90_000,
        reserved: 0,
      });
    });
  });

  describe("losing the race for the job", () => {
    // Another delivery took the job between our hold and our claim. What we
    // reserved ourselves goes back; a hold we only ADOPTED (the running attempt's
    // own, found under the same token) is the winner's and must stay.
    it("hands back its own hold when someone else claims the job first", async () => {
      fake.estimate = { class: "content", images: 1 };
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      const claim = vi
        .spyOn(ExecutionJobRepository, "claimQueuedForProvider")
        .mockResolvedValue(false);
      let claimAttempts = 0;
      try {
        await ExecutionService.startExecution(job.id, "LOW", {
          attemptToken: "evt.1",
        });
        claimAttempts = claim.mock.calls.length;
      } finally {
        claim.mockRestore();
      }

      expect(claimAttempts).toBe(1);
      expect(fake.executed).toBe(0);
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    it("leaves a hold it only adopted to the attempt that owns it", async () => {
      fake.estimate = { class: "content", images: 1 };
      const fixture = await funded({ images: 3, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      // The running attempt's hold, under the token a redelivery will carry.
      const winner = await beginOperation({
        workspaceId: fixture.workspaceId,
        operationId: `exec:${job.id}`,
        attemptToken: "evt.1",
        reserve: { IMAGE: 1 },
      });
      expect(winner.holdsReservation).toBe(true);
      const claim = vi
        .spyOn(ExecutionJobRepository, "claimQueuedForProvider")
        .mockResolvedValue(false);
      try {
        await ExecutionService.startExecution(job.id, "LOW", {
          attemptToken: "evt.1",
        });
      } finally {
        claim.mockRestore();
      }

      expect(fake.executed).toBe(0);
      // Still held: the owner will settle it.
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 1,
      });
      await winner.finish("aborted");
    });
  });

  describe("the per-task cost ceiling", () => {
    async function ceilingSeenByProvider(
      estimate: ProviderUsageEstimate | undefined,
    ) {
      fake.estimate = estimate;
      let seen: bigint | undefined;
      fake.onExecute = () => {
        seen = getUsageScope()?.meter?.ceilingMicros;
      };
      const fixture = await funded({ images: 5, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      await ExecutionService.startExecution(job.id, "LOW", { attemptToken: "e.1" });
      return seen;
    }

    it("is set from what the provider declares: per picture, or a multiple of the text hold", async () => {
      expect(await ceilingSeenByProvider({ class: "content", images: 1 })).toBe(
        BigInt(750_000),
      );
      expect(await ceilingSeenByProvider({ class: "content", images: 3 })).toBe(
        BigInt(2_250_000),
      );
      // A job that draws nothing (an adaptation) still has a limit.
      expect(await ceilingSeenByProvider({ class: "content", images: 0 })).toBe(
        BigInt(500_000),
      );
      expect(await ceilingSeenByProvider({ class: "ai", maxCostUsd: 0.09 })).toBe(
        BigInt(270_000),
      );
    });

    it("is not set for free work, and not at all while billing is off", async () => {
      expect(await ceilingSeenByProvider(undefined)).toBeUndefined();
      config.current = { ...config.current, mode: "off" };
      expect(
        await ceilingSeenByProvider({ class: "content", images: 1 }),
      ).toBeUndefined();
    });

    // Shadow exists to measure without changing what customers get: a ceiling
    // would fail a real job (an expensive retry chain) in the observation period.
    it("is not set in shadow either: it is a block, and shadow blocks nothing", async () => {
      config.current = { ...config.current, mode: "shadow" };
      expect(
        await ceilingSeenByProvider({ class: "content", images: 1 }),
      ).toBeUndefined();
      expect(
        await ceilingSeenByProvider({ class: "ai", maxCostUsd: 0.09 }),
      ).toBeUndefined();
    });
  });

  describe("work that is free of charge or when billing is off", () => {
    it("a provider that declares nothing (publishing, ad writes) never touches the ledger, plan or not", async () => {
      fake.estimate = undefined;
      const fixture = await funded(null); // no plan at all
      const { job } = await queuedJob(fixture);
      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });
      expect(result.status).toBe("COMPLETED");
      expect(fake.executed).toBe(1);
      expect(
        await prisma.usageReservation.count({
          where: { workspaceId: fixture.workspaceId },
        }),
      ).toBe(0);
    });

    it("off: the job runs exactly as before and the ledger is not touched", async () => {
      config.current = { ...config.current, mode: "off" };
      fake.estimate = { class: "content", images: 1 };
      const fixture = await funded({ images: 0, micros: 0 }); // would be refused
      const { job } = await queuedJob(fixture);
      fake.onExecute = draws(1);

      const result = await ExecutionService.startExecution(job.id, "LOW");

      expect(result.status).toBe("COMPLETED");
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
      });
      expect(
        await prisma.usageReservation.count({
          where: { workspaceId: fixture.workspaceId },
        }),
      ).toBe(0);
    });

    it("off: a bug in a provider's declaration cannot stop a job from starting", async () => {
      config.current = { ...config.current, mode: "off" };
      const original = fake.provider.usageEstimate;
      fake.provider.usageEstimate = () => {
        throw new Error("estimator bug");
      };
      try {
        const fixture = await funded(null);
        const { job } = await queuedJob(fixture);
        const result = await ExecutionService.startExecution(job.id, "LOW");
        expect(result.status).toBe("COMPLETED");
      } finally {
        fake.provider.usageEstimate = original;
      }
    });

    it("enforce: a bug in a provider's declaration refuses the start as a retryable ledger error, never as free work", async () => {
      const original = fake.provider.usageEstimate;
      fake.provider.usageEstimate = () => {
        throw new Error("estimator bug");
      };
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const fixture = await funded({ images: 5, micros: 3_000_000 });
        const { job } = await queuedJob(fixture);
        await expect(
          ExecutionService.startExecution(job.id, "LOW", {
            attemptToken: "e.1",
          }),
        ).rejects.toMatchObject({
          code: "BILLING_UNAVAILABLE",
          retryable: true,
        });
        expect(fake.executed).toBe(0);
      } finally {
        fake.provider.usageEstimate = original;
        spy.mockRestore();
      }
    });

    it("shadow: a bug in a provider's declaration does not stop the job either (it runs as free work and the bug is logged)", async () => {
      config.current = { ...config.current, mode: "shadow" };
      const original = fake.provider.usageEstimate;
      fake.provider.usageEstimate = () => {
        throw new Error("estimator bug");
      };
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const fixture = await funded({ images: 5, micros: 3_000_000 });
        const { job } = await queuedJob(fixture);
        const result = await ExecutionService.startExecution(job.id, "LOW", {
          attemptToken: "e.1",
        });
        expect(result.status).toBe("COMPLETED");
        expect(fake.executed).toBe(1);
        expect(spy).toHaveBeenCalled();
      } finally {
        fake.provider.usageEstimate = original;
        spy.mockRestore();
      }
    });

    it("shadow: nothing is refused or parked, an overrun is only recorded", async () => {
      config.current = { ...config.current, mode: "shadow" };
      fake.estimate = { class: "content", images: 1 };
      const fixture = await funded({ images: 0, micros: 3_000_000 });
      const { job } = await queuedJob(fixture);
      fake.onExecute = draws(1);

      const result = await ExecutionService.startExecution(job.id, "LOW", {
        attemptToken: "evt.1",
      });

      expect(result.status).toBe("COMPLETED");
      expect(fake.executed).toBe(1);
    });
  });
});
