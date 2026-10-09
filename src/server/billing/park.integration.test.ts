import { randomUUID } from "node:crypto";

import type {
  ActorType,
  CapabilityKey,
  ExecutionJobStatus,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";
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

import { beginOperation } from "./operation";
import {
  MAX_PARK_AGE_MS,
  RESUME_TOKEN_PREFIX,
  drainParkedWork,
  parkJob,
  resumeParkedWork,
} from "./park";
import { NoPlanError, QuotaExceededError } from "./quota-errors";

// Park / devam mekanizması GERÇEK Postgres'e karşı (tek kullanımlık yerel/CI DB).

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
const fixtures: AgencyFixture[] = [];

const NOW = new Date("2026-11-15T12:00:00.000Z");
const WINDOW_START = new Date("2026-11-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-12-01T00:00:00.000Z");
const DAY = 86_400_000;

async function newWorkspace(
  options: { images?: number; micros?: number } = {},
) {
  const fixture = await createAgencyFixture(`${runId}-${fixtures.length}`);
  fixtures.push(fixture);
  if (options.images !== undefined || options.micros !== undefined) {
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
          updatedAt: NOW,
        },
      });
    }
  }
  return fixture;
}

type JobSeed = {
  capability?: CapabilityKey;
  payload?: Record<string, unknown>;
  taskPayload?: Record<string, unknown>;
  priority?: TaskPriority;
  dueAt?: Date | null;
  taskStatus?: TaskStatus;
  jobStatus?: ExecutionJobStatus;
  createdBy?: ActorType;
  createdAt?: Date;
  parkedAt?: Date;
};

// Bir görev + (varsayılan) WAITING_BUDGET işi.
async function seedJob(fixture: AgencyFixture, seed: JobSeed = {}) {
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      title: `Task ${randomUUID().slice(0, 6)}`,
      capability: seed.capability ?? "CREATE_SOCIAL_CREATIVE",
      status: seed.taskStatus ?? "QUEUED",
      priority: seed.priority ?? "MEDIUM",
      riskLevel: "MEDIUM",
      createdByType: seed.createdBy ?? "USER",
      dueAt: seed.dueAt ?? null,
      payload: (seed.taskPayload ?? undefined) as never,
    },
  });
  const job = await prisma.executionJob.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      taskId: task.id,
      capability: seed.capability ?? "CREATE_SOCIAL_CREATIVE",
      providerType: "SYSTEM",
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestPayload: (seed.payload ?? { request: "a post" }) as never,
      status: seed.jobStatus ?? "WAITING_BUDGET",
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  });
  // The tests run on a simulated clock (NOW). updatedAt is @updatedAt, so set when
  // the job was parked with raw SQL: an hour ago by default, so the age rule
  // (MAX_PARK_AGE_MS) only fires for the tests that ask for it.
  const parkedAt = seed.parkedAt ?? new Date(NOW.getTime() - 3_600_000);
  await prisma.$executeRaw`UPDATE "ExecutionJob" SET "updatedAt" = ${parkedAt} WHERE id = ${job.id}`;
  return { task, job };
}

const statusOf = async (jobId: string) =>
  (await prisma.executionJob.findUniqueOrThrow({ where: { id: jobId } }))
    .status;

const dispatchEventsOf = (jobId: string) =>
  prisma.outboxEvent.findMany({
    where: { executionJobId: jobId, eventType: "execution.dispatch" },
  });

const reservationsOf = (workspaceId: string, unit?: "IMAGE" | "AI_MICROS") =>
  prisma.usageReservation.findMany({
    where: { workspaceId, ...(unit ? { unit } : {}) },
  });

const balanceOf = async (workspaceId: string, unit: "IMAGE" | "AI_MICROS") => {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  return { used: Number(row.periodUsed), reserved: Number(row.periodReserved) };
};

const imageError = () =>
  new QuotaExceededError({
    unit: "IMAGE",
    needed: 1,
    available: 0,
    resetsAt: WINDOW_END,
  });

describeIntegration("parked work (WAITING_BUDGET)", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      const where = { workspaceId: fixture.workspaceId };
      await prisma.outboxEvent.deleteMany({ where });
      await prisma.executionJob.deleteMany({ where });
      await prisma.creative.deleteMany({ where });
      await prisma.task.deleteMany({ where });
      await prisma.auditLog.deleteMany({ where });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  describe("parking", () => {
    it("parks a queued job, records why, nudges the task and frees leftover holds", async () => {
      const fixture = await newWorkspace({ images: 3, micros: 0 });
      const { job, task } = await seedJob(fixture, { jobStatus: "QUEUED" });
      // A crashed earlier attempt left a hold behind.
      await beginOperation({
        workspaceId: fixture.workspaceId,
        operationId: `exec:${job.id}`,
        attemptToken: "old.1",
        reserve: { IMAGE: 1 },
        now: NOW,
      });
      expect((await balanceOf(fixture.workspaceId, "IMAGE")).reserved).toBe(1);
      const before = (
        await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
      ).updatedAt;

      expect(await parkJob(job.id, imageError())).toBe(true);

      const parked = await prisma.executionJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(parked).toMatchObject({
        status: "WAITING_BUDGET",
        errorCode: "QUOTA_EXCEEDED",
        retryable: true,
      });
      // Never worded like a provider billing failure.
      expect(parked.errorMessage).not.toMatch(/quota|billing/i);
      expect((await balanceOf(fixture.workspaceId, "IMAGE")).reserved).toBe(0);
      const after = await prisma.task.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(after.status).toBe("QUEUED"); // the task itself is untouched
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.getTime());
      const audit = await prisma.auditLog.findFirst({
        where: { entityId: job.id, action: "billing.job.parked" },
      });
      expect(audit?.metadata).toMatchObject({
        code: "QUOTA_EXCEEDED",
        unit: "IMAGE",
      });
    });

    it("does not park a job that is no longer queued", async () => {
      const fixture = await newWorkspace({ images: 0, micros: 0 });
      const { job } = await seedJob(fixture, { jobStatus: "RUNNING" });
      expect(await parkJob(job.id, new NoPlanError("NO_SUBSCRIPTION"))).toBe(
        false,
      );
      expect(await statusOf(job.id)).toBe("RUNNING");
    });
  });

  describe("resuming", () => {
    it("reserves the allowance for the jobs it wakes, in priority then own-request then deadline order", async () => {
      const fixture = await newWorkspace({ images: 3, micros: 3_000_000 });
      const day = (n: number) => new Date(NOW.getTime() + n * DAY);
      const low = await seedJob(fixture, { priority: "LOW", dueAt: day(1) });
      const highLate = await seedJob(fixture, {
        priority: "HIGH",
        dueAt: day(9),
      });
      const highSoon = await seedJob(fixture, {
        priority: "HIGH",
        dueAt: day(2),
      });
      const urgent = await seedJob(fixture, {
        priority: "URGENT",
        dueAt: null,
      });
      const medium = await seedJob(fixture, {
        priority: "MEDIUM",
        dueAt: day(1),
      });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      // Room for 3 pictures: URGENT, HIGH (due soonest), HIGH (due later).
      expect(summary).toMatchObject({
        resumed: 3,
        cancelled: 0,
        stillParked: 2,
      });
      expect(await statusOf(urgent.job.id)).toBe("QUEUED");
      expect(await statusOf(highSoon.job.id)).toBe("QUEUED");
      expect(await statusOf(highLate.job.id)).toBe("QUEUED");
      expect(await statusOf(medium.job.id)).toBe("WAITING_BUDGET");
      expect(await statusOf(low.job.id)).toBe("WAITING_BUDGET");
      // The pictures are already paid for: held in the ledger before any worker
      // picks the jobs up, so nothing else can spend them in between.
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 3,
      });
    });

    it("puts the client's own request ahead of background work, and the sooner slot first", async () => {
      const fixture = await newWorkspace({ images: 2, micros: 3_000_000 });
      const slot = async (daysAhead: number) =>
        prisma.creative.create({
          data: {
            workspaceId: fixture.workspaceId,
            projectId: fixture.projectId,
            brandId: fixture.brandId,
            type: "SOCIAL_POST",
            scheduledFor: new Date(NOW.getTime() + daysAhead * DAY),
          },
        });
      const lateSlot = await slot(10);
      const soonSlot = await slot(2);
      const system = await seedJob(fixture, { createdBy: "SYSTEM" });
      const ownLate = await seedJob(fixture, {
        createdBy: "USER",
        taskPayload: { planCreativeId: lateSlot.id },
      });
      const ownSoon = await seedJob(fixture, {
        createdBy: "USER",
        taskPayload: { planCreativeId: soonSlot.id },
      });

      await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW });

      // Task.priority and Task.dueAt are never written today, so the order comes
      // from who asked and from the calendar slot of the post.
      expect(await statusOf(ownSoon.job.id)).toBe("QUEUED");
      expect(await statusOf(ownLate.job.id)).toBe("QUEUED");
      expect(await statusOf(system.job.id)).toBe("WAITING_BUDGET");
    });

    it("hands each woken job its own token inside a fresh dispatch event", async () => {
      const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
      const { job } = await seedJob(fixture);
      await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW });
      const events = await dispatchEventsOf(job.id);
      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as {
        executionJobId: string;
        riskLevel: string;
        attemptToken: string;
      };
      expect(events[0]!.status).toBe("PENDING");
      expect(payload).toMatchObject({
        executionJobId: job.id,
        riskLevel: "MEDIUM",
      });
      expect(payload.attemptToken.startsWith(RESUME_TOKEN_PREFIX)).toBe(true);
      // The reservation exists under exactly that token.
      const [reservation] = await reservationsOf(fixture.workspaceId, "IMAGE");
      expect(reservation).toMatchObject({
        status: "RESERVED",
        reservationKey: `exec:${job.id}#${payload.attemptToken}`,
      });
      const woken = await prisma.executionJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(woken.errorCode).toBeNull();
      expect(woken.errorMessage).toBeNull();
    });

    it("keeps strict priority inside one unit but lets the other unit through", async () => {
      const fixture = await newWorkspace({ images: 2, micros: 3_000_000 });
      // The head of the picture queue needs 3 pictures (variants), only 2 exist.
      const head = await seedJob(fixture, {
        priority: "URGENT",
        payload: { request: "a", variantCount: 3 },
      });
      const smallBehind = await seedJob(fixture, { priority: "LOW" });
      const text = await seedJob(fixture, {
        priority: "LOW",
        capability: "CREATE_COPY",
      });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(await statusOf(head.job.id)).toBe("WAITING_BUDGET");
      // A small, low-priority picture does not starve the big urgent one ...
      expect(await statusOf(smallBehind.job.id)).toBe("WAITING_BUDGET");
      // ... but the AI budget is a separate pool.
      expect(await statusOf(text.job.id)).toBe("QUEUED");
      expect(summary.resumed).toBe(1);
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    it("wakes a job that spends no allowance (adaptation, photo) as soon as the plan is valid", async () => {
      const fixture = await newWorkspace({ images: 0, micros: 0 });
      const adapt = await seedJob(fixture, {
        payload: { request: "a", adaptFromAssetId: "asset-1" },
      });
      await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW });
      expect(await statusOf(adapt.job.id)).toBe("QUEUED");
      expect(await reservationsOf(fixture.workspaceId)).toHaveLength(0);
      const [event] = await dispatchEventsOf(adapt.job.id);
      // Nothing was reserved, so there is no token to adopt.
      expect(event!.payload).not.toHaveProperty("attemptToken");
    });

    it("keeps everything parked while the workspace has no plan, then wakes it", async () => {
      const fixture = await newWorkspace(); // no subscription
      const { job } = await seedJob(fixture);
      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      expect(summary).toMatchObject({ resumed: 0, stillParked: 1 });
      expect(await statusOf(job.id)).toBe("WAITING_BUDGET");

      await prisma.subscription.create({
        data: {
          workspaceId: fixture.workspaceId,
          planKey: "starter",
          interval: "MONTH",
          status: "ACTIVE",
          quotaAnchor: WINDOW_START,
          paidThrough: WINDOW_END,
        },
      });
      const after = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      // The first window is opened on the way and pays for the job.
      expect(after.resumed).toBe(1);
      expect(await statusOf(job.id)).toBe("QUEUED");
    });

    it("a renewal alone wakes parked work (the new window is opened on demand)", async () => {
      const fixture = await newWorkspace({ images: 1, micros: 3_000_000 });
      await prisma.usageBalance.update({
        where: {
          workspaceId_unit: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        },
        data: { periodUsed: B(1) },
      });
      const { job } = await seedJob(fixture);
      const exhausted = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      expect(exhausted.resumed).toBe(0);

      // The renewal payment arrives: the plan is paid one more month.
      await prisma.subscription.update({
        where: { workspaceId: fixture.workspaceId },
        data: { paidThrough: new Date("2027-01-01T00:00:00.000Z") },
      });
      const renewed = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: new Date("2026-12-01T01:00:00.000Z"),
      });
      expect(renewed.resumed).toBe(1);
      expect(await statusOf(job.id)).toBe("QUEUED");
    });

    it("an extra pack alone wakes parked work", async () => {
      const fixture = await newWorkspace({ images: 0, micros: 0 });
      const { job } = await seedJob(fixture);
      expect(
        (await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }))
          .resumed,
      ).toBe(0);
      await prisma.usageBalance.update({
        where: {
          workspaceId_unit: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        },
        data: { extraGranted: B(20) },
      });
      expect(
        (await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }))
          .resumed,
      ).toBe(1);
      expect(await statusOf(job.id)).toBe("QUEUED");
    });

    it("closes parked jobs whose task is gone instead of reviving them, and never reserves for them", async () => {
      const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
      const cancelled = await seedJob(fixture, { taskStatus: "CANCELLED" });
      const failed = await seedJob(fixture, { taskStatus: "FAILED" });
      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      expect(summary.cancelled).toBe(2);
      expect(await statusOf(cancelled.job.id)).toBe("CANCELLED");
      expect(await statusOf(failed.job.id)).toBe("CANCELLED");
      expect(await dispatchEventsOf(cancelled.job.id)).toHaveLength(0);
      expect(await reservationsOf(fixture.workspaceId)).toHaveLength(0);
    });

    it("gives up on work that has waited longer than the limit and cancels its task", async () => {
      const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
      const stale = await seedJob(fixture, {
        parkedAt: new Date(NOW.getTime() - MAX_PARK_AGE_MS - DAY),
      });
      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      expect(summary.cancelled).toBe(1);
      expect(await statusOf(stale.job.id)).toBe("CANCELLED");
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: stale.task.id } }))
          .status,
      ).toBe("CANCELLED");
      expect(
        await prisma.auditLog.count({
          where: { entityId: stale.job.id, action: "billing.job.park_expired" },
        }),
      ).toBe(1);
    });

    it("leaves the work of a paused or closed project parked", async () => {
      const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
      const { job } = await seedJob(fixture);
      for (const status of ["PAUSED", "CLOSED"] as ProjectStatus[]) {
        await prisma.project.update({
          where: { id: fixture.projectId },
          data: { status },
        });
        const summary = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });
        expect(summary.resumed).toBe(0);
        expect(await statusOf(job.id)).toBe("WAITING_BUDGET");
      }
      await prisma.project.update({
        where: { id: fixture.projectId },
        data: { status: "ACTIVE" },
      });
      expect(
        (await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }))
          .resumed,
      ).toBe(1);
    });

    it("never wakes a job twice and never over-reserves when resumers run at once", async () => {
      const fixture = await newWorkspace({ images: 4, micros: 3_000_000 });
      const jobs = await Promise.all(
        Array.from({ length: 8 }, () => seedJob(fixture)),
      );
      await Promise.all([
        resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }),
        resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }),
        resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }),
      ]);
      let woken = 0;
      for (const { job } of jobs) {
        const queued = (await statusOf(job.id)) === "QUEUED";
        expect(await dispatchEventsOf(job.id)).toHaveLength(queued ? 1 : 0);
        if (queued) woken += 1;
      }
      // Exactly the four pictures that exist, each held once.
      expect(woken).toBe(4);
      const open = (await reservationsOf(fixture.workspaceId, "IMAGE")).filter(
        (row) => row.status === "RESERVED",
      );
      expect(open).toHaveLength(4);
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 4,
      });
    });

    it("only touches the workspace it was asked about", async () => {
      const a = await newWorkspace({ images: 5, micros: 3_000_000 });
      const b = await newWorkspace({ images: 5, micros: 3_000_000 });
      const jobA = await seedJob(a);
      const jobB = await seedJob(b);
      await resumeParkedWork({ workspaceId: a.workspaceId, now: NOW });
      expect(await statusOf(jobA.job.id)).toBe("QUEUED");
      expect(await statusOf(jobB.job.id)).toBe("WAITING_BUDGET");
    });

    it("a sweep of every workspace serves the one that topped up, not just the one with the biggest backlog", async () => {
      const broke = await newWorkspace({ images: 0, micros: 0 });
      const funded = await newWorkspace({ images: 3, micros: 3_000_000 });
      // The broke workspace has the older and far larger backlog.
      for (let i = 0; i < 6; i += 1) {
        await seedJob(broke, { parkedAt: new Date(NOW.getTime() - 3 * DAY) });
      }
      const mine = await seedJob(funded, {
        parkedAt: new Date(NOW.getTime() - DAY),
      });
      await resumeParkedWork({ now: NOW });
      expect(await statusOf(mine.job.id)).toBe("QUEUED");
    });

    it("a sweep skips a workspace whose allowance has not changed since the job parked, and looks again when it does", async () => {
      const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
      const { job } = await seedJob(fixture, {
        parkedAt: new Date(NOW.getTime() - 3_600_000),
      });
      // Nothing about the plan or the balance has moved since the job parked.
      const before = new Date(NOW.getTime() - 2 * 3_600_000);
      await prisma.$executeRaw`UPDATE "UsageBalance" SET "updatedAt" = ${before} WHERE "workspaceId" = ${fixture.workspaceId}`;
      await prisma.$executeRaw`UPDATE "Subscription" SET "updatedAt" = ${before} WHERE "workspaceId" = ${fixture.workspaceId}`;

      await resumeParkedWork({ now: NOW });
      expect(await statusOf(job.id)).toBe("WAITING_BUDGET");

      // A top-up (any balance write) after the job parked brings it back in view.
      await prisma.$executeRaw`UPDATE "UsageBalance" SET "updatedAt" = ${NOW} WHERE "workspaceId" = ${fixture.workspaceId} AND "unit" = 'IMAGE'`;
      await resumeParkedWork({ now: NOW });
      expect(await statusOf(job.id)).toBe("QUEUED");
    });

    it("a sweep still closes work that has waited too long in a workspace nothing happened in", async () => {
      const fixture = await newWorkspace({ images: 0, micros: 0 });
      const stale = await seedJob(fixture, {
        parkedAt: new Date(NOW.getTime() - MAX_PARK_AGE_MS - DAY),
      });
      const before = new Date(NOW.getTime() - MAX_PARK_AGE_MS - 2 * DAY);
      await prisma.$executeRaw`UPDATE "UsageBalance" SET "updatedAt" = ${before} WHERE "workspaceId" = ${fixture.workspaceId}`;
      await prisma.$executeRaw`UPDATE "Subscription" SET "updatedAt" = ${before} WHERE "workspaceId" = ${fixture.workspaceId}`;
      await resumeParkedWork({ now: NOW });
      expect(await statusOf(stale.job.id)).toBe("CANCELLED");
    });

    it("honours the limit", async () => {
      const fixture = await newWorkspace({ images: 10, micros: 3_000_000 });
      const jobs = await Promise.all(
        Array.from({ length: 4 }, () => seedJob(fixture)),
      );
      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
        limit: 2,
      });
      expect(summary.resumed).toBe(2);
      const states = await Promise.all(jobs.map(({ job }) => statusOf(job.id)));
      expect(states.filter((state) => state === "QUEUED")).toHaveLength(2);
    });

    it("does nothing in off mode", async () => {
      config.current = { ...config.current, mode: "off" };
      const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
      const { job } = await seedJob(fixture);
      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      expect(summary).toEqual({ resumed: 0, cancelled: 0, stillParked: 0 });
      expect(await statusOf(job.id)).toBe("WAITING_BUDGET");
    });
  });

  describe("kill-switch: leaving enforce mode", () => {
    it("shadow wakes parked work at once, without looking at the allowance", async () => {
      config.current = { ...config.current, mode: "shadow" };
      const fixture = await newWorkspace({ images: 0, micros: 0 });
      const { job } = await seedJob(fixture);
      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      // Shadow sweeps every workspace: other tests' leftovers are drained too.
      expect(summary.resumed).toBeGreaterThanOrEqual(1);
      expect(await statusOf(job.id)).toBe("QUEUED");
      const [event] = await dispatchEventsOf(job.id);
      expect(event!.payload).not.toHaveProperty("attemptToken");
    });

    it("drainParkedWork wakes everything, closes what has no task any more", async () => {
      config.current = { ...config.current, mode: "off" };
      const fixture = await newWorkspace();
      const alive = await seedJob(fixture);
      const gone = await seedJob(fixture, { taskStatus: "CANCELLED" });
      const summary = await drainParkedWork({ now: NOW });
      expect(summary.resumed).toBeGreaterThanOrEqual(1);
      expect(await statusOf(alive.job.id)).toBe("QUEUED");
      expect(await statusOf(gone.job.id)).toBe("CANCELLED");
    });
  });
});
