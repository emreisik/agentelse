import { randomUUID } from "node:crypto";

import type {
  ActorType,
  CapabilityKey,
  ExecutionJobStatus,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";
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

// Every reservation attempt of a resume and of a job start goes through
// beginOperation. The real function always runs; a test can hook in right AFTER
// an attempt (before its result reaches the caller) to hold resumers at a barrier
// or to let time and writes pass in the middle of a park.
const gate = vi.hoisted(() => ({
  afterAttempt: null as null | (() => Promise<void>),
}));
vi.mock("./operation", async (importActual) => {
  const actual = await importActual<typeof import("./operation")>();
  return {
    ...actual,
    beginOperation: async (spec: OperationSpec) => {
      try {
        return await actual.beginOperation(spec);
      } finally {
        await gate.afterAttempt?.();
      }
    },
  };
});

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import type {
  ExecutionPolicyContext,
  ExecutionProvider,
} from "@/server/execution/types";
import { usageNeedOf } from "@/server/execution/usage-need";
import { describeIntegration } from "@/test-support/integration-suite";

import { beginJobBilling } from "./job-billing";
import { beginOperation, type OperationSpec } from "./operation";
import {
  MAX_PARK_AGE_MS,
  RESUME_TOKEN_PREFIX,
  drainParkedWork,
  parkJob,
  resumeParkedWork,
  type ResumeSummary,
} from "./park";
import { NoPlanError, QuotaExceededError } from "./quota-errors";

// Park / devam mekanizması GERÇEK Postgres'e karşı (tek kullanımlık yerel/CI DB).

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
const fixtures: AgencyFixture[] = [];
let workspaceCount = 0;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The code under test is handed a simulated clock (`now`). It is derived from
// the real clock, the 15th of the PREVIOUS month at noon UTC, so it is always in
// the past of the real one: whatever the database stamps on its own (Prisma's
// @updatedAt, default now()) is later than anything stamped relative to NOW, on
// every day of the calendar. Where the order of two stamps decides the outcome
// (the sweep compares them) the test writes both itself.
const REAL = new Date();
const monthStart = (offset: number) =>
  new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth() + offset, 1));
const WINDOW_START = monthStart(-1);
const WINDOW_END = monthStart(0);
const NEXT_WINDOW_END = monthStart(1);
const NOW = new Date(WINDOW_START.getTime() + 14 * DAY + 12 * HOUR);
// Older than any job in these tests could have been parked (the limit is 45 days).
const LONG_AGO = new Date(NOW.getTime() - 90 * DAY);

const earlier = (when: Date, by: number) => new Date(when.getTime() - by);
const later = (when: Date, by: number) => new Date(when.getTime() + by);

async function newWorkspace(
  options: { images?: number; micros?: number } = {},
) {
  const fixture = await createAgencyFixture(`${runId}-${workspaceCount++}`);
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
        // Otherwise stamped by the database's own clock, which the sweep would
        // compare with the simulated times of the jobs.
        updatedAt: LONG_AGO,
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

// When the plan and the balances of a workspace were last written. The sweep
// looks at a workspace again only if one of them is newer than its oldest parked
// job, so the tests that probe that filter set both explicitly (EVERY balance row
// counts, whatever its unit).
async function stampLedger(
  workspaceId: string,
  stamps: { balance?: Date; subscription?: Date },
) {
  if (stamps.balance) {
    await prisma.usageBalance.updateMany({
      where: { workspaceId },
      data: { updatedAt: stamps.balance },
    });
  }
  if (stamps.subscription) {
    await prisma.subscription.updateMany({
      where: { workspaceId },
      data: { updatedAt: stamps.subscription },
    });
  }
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

// The tests run on a simulated clock (NOW). updatedAt is when the job was parked:
// an hour ago by default, so the age rule (MAX_PARK_AGE_MS) only fires for the
// tests that ask for it.
const parkedAtOf = (seed: JobSeed) => seed.parkedAt ?? earlier(NOW, HOUR);

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
      updatedAt: parkedAtOf(seed),
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  });
  return { task, job };
}

// The same for a long queue: two statements instead of two per job.
async function seedJobs(fixture: AgencyFixture, seeds: JobSeed[]) {
  const rows = seeds.map((seed) => ({
    seed,
    taskId: randomUUID(),
    jobId: randomUUID(),
  }));
  await prisma.task.createMany({
    data: rows.map(({ seed, taskId }) => ({
      id: taskId,
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      title: `Task ${taskId.slice(0, 6)}`,
      capability: seed.capability ?? "CREATE_SOCIAL_CREATIVE",
      status: seed.taskStatus ?? "QUEUED",
      priority: seed.priority ?? "MEDIUM",
      riskLevel: "MEDIUM" as const,
      createdByType: seed.createdBy ?? "USER",
    })),
  });
  await prisma.executionJob.createMany({
    data: rows.map(({ seed, taskId, jobId }) => ({
      id: jobId,
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      taskId,
      capability: seed.capability ?? "CREATE_SOCIAL_CREATIVE",
      providerType: "SYSTEM" as const,
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestPayload: (seed.payload ?? { request: "a post" }) as never,
      status: seed.jobStatus ?? "WAITING_BUDGET",
      updatedAt: parkedAtOf(seed),
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    })),
  });
  return rows.map(({ taskId, jobId }) => ({ taskId, jobId }));
}

// A calendar slot: the empty Creative a saved content plan leaves for a post. A
// job reaches it through Task.payload.planCreativeId.
const newSlot = (fixture: AgencyFixture, scheduledFor: Date) =>
  prisma.creative.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      type: "SOCIAL_POST",
      scheduledFor,
    },
  });

// A person's decision on a task (the record a task's approval leaves behind).
const approve = (
  fixture: AgencyFixture,
  taskId: string,
  overrides: Partial<{
    entityType: string;
    status: "PENDING" | "APPROVED" | "REJECTED";
    reviewedByUserId: string | null;
  }> = {},
) =>
  prisma.approval.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      taskId,
      entityType: overrides.entityType ?? "Task",
      entityId: overrides.entityType === "Creative" ? randomUUID() : taskId,
      type:
        overrides.entityType === "Creative" ? "CREATIVE_APPROVAL" : "GENERIC",
      status: overrides.status ?? "APPROVED",
      requestedByType: "SYSTEM",
      reviewedByUserId:
        overrides.reviewedByUserId === undefined
          ? "user-1"
          : overrides.reviewedByUserId,
    },
  });

const statusOf = async (jobId: string) =>
  (await prisma.executionJob.findUniqueOrThrow({ where: { id: jobId } }))
    .status;

const updatedAtOf = async (jobId: string) =>
  (await prisma.executionJob.findUniqueOrThrow({ where: { id: jobId } }))
    .updatedAt;

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

// A barrier for `parties` callers. Installed as the hook after a reservation
// attempt, it holds every resumer there until all of them have reserved, so they
// reach the wake-up together instead of one finishing before the next one starts.
// The watchdog turns a barrier that is never reached into a failure, not a hang.
function rendezvous(parties: number) {
  let arrived = 0;
  let open!: () => void;
  const met = new Promise<void>((resolve) => {
    open = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("the resumers never met at the barrier")),
      3_000,
    );
  });
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived === parties) open();
      await Promise.race([met, watchdog]);
    },
    arrived: () => arrived,
    done: () => clearTimeout(timer),
  };
}

const sum = (summaries: ResumeSummary[], key: keyof ResumeSummary) =>
  summaries.reduce((total, summary) => total + summary[key], 0);

async function tearDownFixtures() {
  for (const fixture of fixtures.splice(0)) {
    const where = { workspaceId: fixture.workspaceId };
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.executionJob.deleteMany({ where });
    await prisma.creative.deleteMany({ where });
    await prisma.task.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    await teardownAgencyFixture(fixture.workspaceId);
  }
}

describeIntegration("parked work (WAITING_BUDGET)", () => {
  // A sweep without a workspaceId looks at EVERY workspace of the database (at
  // most 50, oldest first) and the shadow and off drains take every parked job. A
  // job some other test file left parked would crowd the sweeps below out or
  // change their counts, so strays are retired before each test (nothing of this
  // file's is parked at this point: each test removes its own fixtures).
  beforeEach(async () => {
    await prisma.executionJob.updateMany({
      where: { status: "WAITING_BUDGET" },
      data: { status: "CANCELLED" },
    });
  });

  afterEach(async () => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    gate.afterAttempt = null;
    vi.useRealTimers();
    await tearDownFixtures();
  });

  afterAll(tearDownFixtures);

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
      // The task last changed long ago (by the simulated clock): the nudge below
      // is the only thing that can move it past this.
      const lastChanged = earlier(NOW, HOUR);
      await prisma.task.update({
        where: { id: task.id },
        data: { updatedAt: lastChanged },
      });

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
      const afterPark = await prisma.task.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(afterPark.status).toBe("QUEUED"); // the task itself is untouched
      expect(afterPark.updatedAt.getTime()).toBeGreaterThan(
        lastChanged.getTime(),
      );
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

    describe("a refill that lands while the job is being parked", () => {
      // No pictures when the attempt began; an extra pack of 3 lands afterwards.
      const attemptBegan = earlier(NOW, 30 * MINUTE);
      const refilled = earlier(NOW, 20 * MINUTE);

      async function workspaceRefilledAt(when: Date) {
        const fixture = await newWorkspace({ images: 0, micros: 0 });
        await stampLedger(fixture.workspaceId, { balance: when });
        await prisma.usageBalance.update({
          where: {
            workspaceId_unit: {
              workspaceId: fixture.workspaceId,
              unit: "IMAGE",
            },
          },
          data: { extraGranted: B(3) },
        });
        return fixture;
      }

      it("stamps the job with when the attempt began, so a sweep sees the refill as newer", async () => {
        // The same refill in two identical workspaces. Only the stamp of the job
        // differs: in one the attempt began before the refill, in the other after.
        const earlyWorkspace = await workspaceRefilledAt(refilled);
        const lateWorkspace = await workspaceRefilledAt(refilled);
        const early = await seedJob(earlyWorkspace, { jobStatus: "QUEUED" });
        const late = await seedJob(lateWorkspace, { jobStatus: "QUEUED" });
        const lateAttempt = later(refilled, 10 * MINUTE);

        expect(await parkJob(early.job.id, imageError(), attemptBegan)).toBe(
          true,
        );
        expect(await parkJob(late.job.id, imageError(), lateAttempt)).toBe(
          true,
        );

        // The stored stamp is what the sweep compares with the ledger writes.
        expect(await updatedAtOf(early.job.id)).toEqual(attemptBegan);
        expect(await updatedAtOf(late.job.id)).toEqual(lateAttempt);

        await resumeParkedWork({ now: NOW });

        // The refill is newer than the early job, older than the late one.
        expect(await statusOf(early.job.id)).toBe("QUEUED");
        expect(await statusOf(late.job.id)).toBe("WAITING_BUDGET");
      });

      it("beginJobBilling parks with the moment its reservation attempt began", async () => {
        const fixture = await newWorkspace({ images: 0, micros: 0 });
        await stampLedger(fixture.workspaceId, {
          balance: earlier(attemptBegan, HOUR),
        });
        const { job, task } = await seedJob(fixture, { jobStatus: "QUEUED" });
        const queued = await prisma.executionJob.findUniqueOrThrow({
          where: { id: job.id },
        });
        const provider: ExecutionProvider = {
          key: "test-paid",
          type: "AI",
          isConfigured: true,
          canExecute: async () => true,
          usageEstimate: () => ({ class: "content", images: 1 }),
          execute: async (request) => ({
            executionReference: request.correlationId,
            isMock: false,
          }),
          getStatus: async () => ({ status: "COMPLETED", isMock: false }),
        };
        const context: ExecutionPolicyContext = {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          taskId: task.id,
          capability: "CREATE_SOCIAL_CREATIVE",
          riskLevel: "MEDIUM",
        };

        // The clock stands still at the moment the attempt begins. The attempt is
        // refused (no pictures); then, before the job is parked, the extra pack
        // lands and the clock moves on.
        let attempts = 0;
        let attemptEnded: Date | undefined;
        gate.afterAttempt = async () => {
          attempts += 1;
          vi.setSystemTime(refilled);
          attemptEnded = new Date();
          await prisma.usageBalance.update({
            where: {
              workspaceId_unit: {
                workspaceId: fixture.workspaceId,
                unit: "IMAGE",
              },
            },
            data: { extraGranted: B(3), updatedAt: refilled },
          });
          vi.setSystemTime(later(refilled, MINUTE));
        };
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(attemptBegan);
        const billing = await beginJobBilling({
          job: queued,
          provider,
          context,
        }).finally(() => {
          vi.useRealTimers();
          gate.afterAttempt = null;
        });

        expect(attempts).toBe(1);
        if (billing.kind !== "stop") throw new Error("expected a parked job");
        expect(billing.job).toMatchObject({
          status: "WAITING_BUDGET",
          errorCode: "QUOTA_EXCEEDED",
        });
        // Stamped with the start of the attempt, not with the moment the park
        // landed: a time not after the moment the attempt finished.
        expect(billing.job.updatedAt).toEqual(attemptBegan);
        expect(billing.job.updatedAt.getTime()).toBeLessThanOrEqual(
          attemptEnded!.getTime(),
        );

        // So the refill, newer than the job, brings the workspace back in view.
        const summary = await resumeParkedWork({ now: NOW });
        expect(summary.resumed).toBe(1);
        expect(await statusOf(job.id)).toBe("QUEUED");
      });
    });
  });

  describe("resuming", () => {
    it("reserves the allowance for the jobs it wakes, in priority then own-request then deadline order", async () => {
      const fixture = await newWorkspace({ images: 3, micros: 3_000_000 });
      const day = (n: number) => later(NOW, n * DAY);
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

    // Room for ONE picture and exactly two candidates: whichever the order puts
    // first is woken, so only the rule under test can pick the winner. Task.priority
    // and Task.dueAt are never written today; the order comes from who asked and
    // from the calendar slot of the post, but all of them rank the same way once
    // they are written.
    describe("order", () => {
      const oneRoom = () => newWorkspace({ images: 1, micros: 3_000_000 });

      // Room that exactly one of a client's own 3-picture request and a background
      // job of 1 picture can have: 4 granted, 1 used, 3 left. Growth keeps 2 of the 4
      // (30%, rounded up) for the client, so the background job still fits above that
      // (1 + 2 = 3); but once it has taken its picture only 2 are left, and the
      // client's 3 no longer fit. Whichever the order puts first decides who goes.
      const contested = async () => {
        const fixture = await newWorkspace({ images: 4, micros: 3_000_000 });
        await prisma.usageBalance.updateMany({
          where: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
          data: { periodUsed: B(1) },
        });
        return fixture;
      };
      const THREE_PICTURES = { request: "a post", variantCount: 3 };

      async function expectWoken(
        fixture: AgencyFixture,
        winner: { job: { id: string } },
        loser: { job: { id: string } },
      ) {
        const summary = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });
        expect(await statusOf(winner.job.id)).toBe("QUEUED");
        expect(await statusOf(loser.job.id)).toBe("WAITING_BUDGET");
        expect(summary).toEqual({ resumed: 1, cancelled: 0, stillParked: 1 });
      }

      it("the client's own request goes before background work, even when the background post is due sooner", async () => {
        const fixture = await contested();
        const soonSlot = await newSlot(fixture, later(NOW, DAY));
        const lateSlot = await newSlot(fixture, later(NOW, 5 * DAY));
        // The background job is due sooner AND was created first: nothing but the
        // own-request rule can put the other job ahead of it.
        const background = await seedJob(fixture, {
          createdBy: "SYSTEM",
          taskPayload: { planCreativeId: soonSlot.id },
          createdAt: earlier(NOW, 3 * HOUR),
        });
        const own = await seedJob(fixture, {
          createdBy: "USER",
          payload: THREE_PICTURES,
          taskPayload: { planCreativeId: lateSlot.id },
          createdAt: earlier(NOW, 2 * HOUR),
        });
        await expectWoken(fixture, own, background);
      });

      it("of two requests of the client, the post whose slot comes first goes first", async () => {
        const fixture = await oneRoom();
        const soonSlot = await newSlot(fixture, later(NOW, DAY));
        const lateSlot = await newSlot(fixture, later(NOW, 5 * DAY));
        // The post with the later slot was asked for first, so the age of the
        // jobs cannot pick the right one by accident.
        const forLateSlot = await seedJob(fixture, {
          taskPayload: { planCreativeId: lateSlot.id },
          createdAt: earlier(NOW, 3 * HOUR),
        });
        const forSoonSlot = await seedJob(fixture, {
          taskPayload: { planCreativeId: soonSlot.id },
          createdAt: earlier(NOW, 2 * HOUR),
        });
        await expectWoken(fixture, forSoonSlot, forLateSlot);
      });

      it("Task.dueAt is the deadline when there is one, and the slot only when there is none", async () => {
        const fixture = await oneRoom();
        const near = await newSlot(fixture, later(NOW, DAY));
        const middle = await newSlot(fixture, later(NOW, 3 * DAY));
        // A's slot is the nearest of all, but its own dueAt (5 days) says
        // otherwise; B has no dueAt and falls back to its slot (3 days).
        const dueLater = await seedJob(fixture, {
          taskPayload: { planCreativeId: near.id },
          dueAt: later(NOW, 5 * DAY),
          createdAt: earlier(NOW, 3 * HOUR),
        });
        const slotOnly = await seedJob(fixture, {
          taskPayload: { planCreativeId: middle.id },
          createdAt: earlier(NOW, 2 * HOUR),
        });
        await expectWoken(fixture, slotOnly, dueLater);
      });

      it("priority goes before everything else: a high-priority background job beats the client's own earlier, sooner request", async () => {
        const fixture = await contested();
        const soonSlot = await newSlot(fixture, later(NOW, DAY));
        const lateSlot = await newSlot(fixture, later(NOW, 5 * DAY));
        // The own job wins on every other rule (own request, slot, age).
        const own = await seedJob(fixture, {
          priority: "MEDIUM",
          createdBy: "USER",
          payload: THREE_PICTURES,
          taskPayload: { planCreativeId: soonSlot.id },
          createdAt: earlier(NOW, 3 * HOUR),
        });
        const high = await seedJob(fixture, {
          priority: "HIGH",
          createdBy: "SYSTEM",
          taskPayload: { planCreativeId: lateSlot.id },
          createdAt: earlier(NOW, 2 * HOUR),
        });
        await expectWoken(fixture, high, own);
      });

      it("with everything else equal, the job created first goes first", async () => {
        const fixture = await oneRoom();
        // The newer job was parked first, so leaving the order to the database
        // would hand it the room.
        const older = await seedJob(fixture, {
          createdAt: earlier(NOW, 5 * HOUR),
          parkedAt: earlier(NOW, HOUR),
        });
        const newer = await seedJob(fixture, {
          createdAt: earlier(NOW, 4 * HOUR),
          parkedAt: earlier(NOW, 2 * HOUR),
        });
        await expectWoken(fixture, older, newer);
      });
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

    // A job that draws nothing (a photo of the brand, another format of a post
    // that has its picture) reserves no picture, so the only thing that can keep
    // it waiting is the plan itself: the resume step asks for a valid plan even
    // when there is nothing to reserve.
    describe("a job that spends no allowance still needs a valid plan", () => {
      const photo = { request: "a", photoAssetIds: ["asset-1"] };
      const adaptation = { request: "a", adaptFromAssetId: "asset-1" };

      it("stays parked while the workspace has no plan, and wakes once it has one", async () => {
        // Both really are free of pictures: nothing but the plan can stop them.
        expect(usageNeedOf("CREATE_SOCIAL_CREATIVE", photo)).toBeNull();
        expect(usageNeedOf("CREATE_SOCIAL_CREATIVE", adaptation)).toBeNull();

        const fixture = await newWorkspace(); // no subscription
        const photoJob = await seedJob(fixture, { payload: photo });
        const adaptJob = await seedJob(fixture, { payload: adaptation });

        const waiting = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });
        expect(waiting).toEqual({ resumed: 0, cancelled: 0, stillParked: 2 });
        expect(await statusOf(photoJob.job.id)).toBe("WAITING_BUDGET");
        expect(await statusOf(adaptJob.job.id)).toBe("WAITING_BUDGET");
        expect(await dispatchEventsOf(photoJob.job.id)).toHaveLength(0);
        expect(await dispatchEventsOf(adaptJob.job.id)).toHaveLength(0);

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
        const woken = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });
        expect(woken).toEqual({ resumed: 2, cancelled: 0, stillParked: 0 });
        expect(await statusOf(photoJob.job.id)).toBe("QUEUED");
        expect(await statusOf(adaptJob.job.id)).toBe("QUEUED");
        expect(await reservationsOf(fixture.workspaceId)).toHaveLength(0);
      });

      it("stays parked while the plan has lapsed (read-only), and wakes on renewal", async () => {
        const fixture = await newWorkspace();
        // Paid until 10 days ago: past the renewal grace, so the workspace is
        // read-only and may not start new paid work.
        await prisma.subscription.create({
          data: {
            workspaceId: fixture.workspaceId,
            planKey: "growth",
            interval: "MONTH",
            status: "ACTIVE",
            quotaAnchor: WINDOW_START,
            paidThrough: earlier(NOW, 10 * DAY),
          },
        });
        const { job } = await seedJob(fixture, { payload: adaptation });

        const lapsed = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });
        expect(lapsed).toEqual({ resumed: 0, cancelled: 0, stillParked: 1 });
        expect(await statusOf(job.id)).toBe("WAITING_BUDGET");

        await prisma.subscription.update({
          where: { workspaceId: fixture.workspaceId },
          data: { paidThrough: WINDOW_END },
        });
        const renewed = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });
        expect(renewed.resumed).toBe(1);
        expect(await statusOf(job.id)).toBe("QUEUED");
      });
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
      const afterPlan = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });
      // The first window is opened on the way and pays for the job.
      expect(afterPlan.resumed).toBe(1);
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
        data: { paidThrough: NEXT_WINDOW_END },
      });
      const renewed = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: later(WINDOW_END, HOUR),
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
        parkedAt: earlier(NOW, MAX_PARK_AGE_MS + DAY),
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

    // Every resumer reserves a picture of its own (its own token) before it tries
    // to wake the job, and only the wake-up decides: the job leaves WAITING_BUDGET
    // for exactly one of them. The barrier holds all three at the reservation, so
    // they always reach the wake-up together (a free-running race would often
    // finish one resumer before the next one started and prove nothing).
    describe("resumers running at once", () => {
      it("wakes a job once when three resumers reach it at the same moment", async () => {
        const fixture = await newWorkspace({ images: 3, micros: 3_000_000 });
        const { job } = await seedJob(fixture);
        const meeting = rendezvous(3);
        gate.afterAttempt = meeting.arrive;

        const summaries = await Promise.all(
          [1, 2, 3].map(() =>
            resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }),
          ),
        ).finally(() => {
          gate.afterAttempt = null;
          meeting.done();
        });

        // The control: all three really did reserve a picture for the same job
        // before any of them tried to wake it.
        const reservations = await reservationsOf(fixture.workspaceId, "IMAGE");
        expect(meeting.arrived()).toBe(3);
        expect(reservations).toHaveLength(3);

        // Exactly one wake-up won.
        expect(sum(summaries, "resumed")).toBe(1);
        expect(sum(summaries, "stillParked")).toBe(2);
        expect(await statusOf(job.id)).toBe("QUEUED");
        const events = await dispatchEventsOf(job.id);
        expect(events).toHaveLength(1);

        // The winner kept its picture, under the token the event carries; the
        // other two handed theirs back.
        const { attemptToken } = events[0]!.payload as { attemptToken: string };
        expect(
          reservations
            .filter((row) => row.status === "RESERVED")
            .map((row) => row.reservationKey),
        ).toEqual([`exec:${job.id}#${attemptToken}`]);
        expect(
          reservations.filter((row) => row.status === "RELEASED"),
        ).toHaveLength(2);
        expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
          used: 0,
          reserved: 1,
        });
      });

      it("never wakes a job twice and never over-reserves, with a queue longer than the room", async () => {
        const fixture = await newWorkspace({ images: 4, micros: 3_000_000 });
        const jobs = await Promise.all(
          Array.from({ length: 8 }, () => seedJob(fixture)),
        );
        // The three collide on the head of the queue; from there on they race
        // freely for the rest.
        const meeting = rendezvous(3);
        gate.afterAttempt = meeting.arrive;
        const summaries = await Promise.all(
          [1, 2, 3].map(() =>
            resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW }),
          ),
        ).finally(() => {
          gate.afterAttempt = null;
          meeting.done();
        });

        let woken = 0;
        for (const { job } of jobs) {
          const queued = (await statusOf(job.id)) === "QUEUED";
          expect(await dispatchEventsOf(job.id)).toHaveLength(queued ? 1 : 0);
          if (queued) woken += 1;
        }
        // Exactly the four pictures that exist, each held once.
        expect(woken).toBe(4);
        expect(sum(summaries, "resumed")).toBe(4);
        const open = (
          await reservationsOf(fixture.workspaceId, "IMAGE")
        ).filter((row) => row.status === "RESERVED");
        expect(open).toHaveLength(4);
        expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
          used: 0,
          reserved: 4,
        });
      });
    });

    // The wake-up also asks that the task is still wanted. A client who cancels the
    // post after its picture was reserved but before the job is woken must not get
    // the job revived (nor keep a picture held for it).
    it("does not wake a job whose task was cancelled while its allowance was being reserved", async () => {
      const fixture = await newWorkspace({ images: 3, micros: 3_000_000 });
      const { job, task } = await seedJob(fixture);
      gate.afterAttempt = async () => {
        gate.afterAttempt = null;
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "CANCELLED" },
        });
      };

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(summary).toEqual({ resumed: 0, cancelled: 0, stillParked: 1 });
      expect(await statusOf(job.id)).toBe("WAITING_BUDGET");
      expect(await dispatchEventsOf(job.id)).toHaveLength(0);
      // The picture was reserved and handed back: nothing stays held.
      const reservations = await reservationsOf(fixture.workspaceId, "IMAGE");
      expect(reservations.map((row) => row.status)).toEqual(["RELEASED"]);
      expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
        used: 0,
        reserved: 0,
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
        await seedJob(broke, { parkedAt: earlier(NOW, 3 * DAY) });
      }
      const mine = await seedJob(funded, {
        parkedAt: earlier(NOW, DAY),
      });
      await resumeParkedWork({ now: NOW });
      expect(await statusOf(mine.job.id)).toBe("QUEUED");
    });

    describe("which workspaces a sweep looks at again", () => {
      // The job parked at PARKED; the plan and the balances, when they were
      // last written, either side of it. The allowance (5 pictures) is there
      // all the time: what a sweep reacts to is a WRITE after the job parked.
      const PARKED = earlier(NOW, 3 * HOUR);

      it("a sweep skips a workspace whose allowance has not changed since the job parked, and looks again when it does", async () => {
        const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
        const { job } = await seedJob(fixture, { parkedAt: PARKED });
        // Nothing about the plan or the balance has moved since the job parked.
        const quiet = earlier(PARKED, HOUR);
        await stampLedger(fixture.workspaceId, {
          balance: quiet,
          subscription: quiet,
        });

        await resumeParkedWork({ now: NOW });
        expect(await statusOf(job.id)).toBe("WAITING_BUDGET");

        // A top-up (any balance write) after the job parked brings it back in view.
        await stampLedger(fixture.workspaceId, { balance: NOW });
        await resumeParkedWork({ now: NOW });
        expect(await statusOf(job.id)).toBe("QUEUED");
      });

      it("a sweep looks again when only the plan changed after the job parked (renewal, plan switch)", async () => {
        const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
        const { job } = await seedJob(fixture, { parkedAt: PARKED });
        const quiet = earlier(PARKED, HOUR);
        await stampLedger(fixture.workspaceId, {
          balance: quiet,
          subscription: quiet,
        });
        await resumeParkedWork({ now: NOW });
        expect(await statusOf(job.id)).toBe("WAITING_BUDGET");

        // The balances stay as quiet as they were: the subscription row alone is
        // newer than the job.
        await stampLedger(fixture.workspaceId, {
          subscription: later(PARKED, HOUR),
        });
        const summary = await resumeParkedWork({ now: NOW });
        expect(summary.resumed).toBe(1);
        expect(await statusOf(job.id)).toBe("QUEUED");
      });

      it("a sweep closes a job whose task is gone even when nothing about the allowance changed", async () => {
        const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
        const { job } = await seedJob(fixture, {
          taskStatus: "CANCELLED",
          parkedAt: PARKED,
        });
        const quiet = earlier(PARKED, HOUR);
        await stampLedger(fixture.workspaceId, {
          balance: quiet,
          subscription: quiet,
        });

        const summary = await resumeParkedWork({ now: NOW });

        expect(summary).toEqual({ resumed: 0, cancelled: 1, stillParked: 0 });
        expect(await statusOf(job.id)).toBe("CANCELLED");
        expect(await dispatchEventsOf(job.id)).toHaveLength(0);
        expect(await reservationsOf(fixture.workspaceId)).toHaveLength(0);
      });

      // A workspace is judged by its OLDEST parked job. A newer job of the same
      // workspace that parked after the write must not hide it from the sweep: the
      // older job is the one waiting for it.
      it.each(["balance", "subscription"] as const)(
        "a %s write after the oldest job brings the workspace back in view, although a newer job parked after the write",
        async (kind) => {
          const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
          const oldest = await seedJob(fixture, {
            parkedAt: earlier(NOW, 5 * HOUR),
          });
          const newest = await seedJob(fixture, {
            parkedAt: earlier(NOW, HOUR),
          });
          // Quiet since before either job parked, except for the one write under
          // test: after the oldest job parked, before the newest one did.
          const quiet = earlier(NOW, 6 * HOUR);
          await stampLedger(fixture.workspaceId, {
            balance: quiet,
            subscription: quiet,
          });
          const between = earlier(NOW, 3 * HOUR);
          await stampLedger(
            fixture.workspaceId,
            kind === "balance"
              ? { balance: between }
              : { subscription: between },
          );

          const summary = await resumeParkedWork({ now: NOW });

          expect(summary).toEqual({ resumed: 2, cancelled: 0, stillParked: 0 });
          expect(await statusOf(oldest.job.id)).toBe("QUEUED");
          expect(await statusOf(newest.job.id)).toBe("QUEUED");
        },
      );

      it("a sweep closes a job that has waited too long, although a newer job of the workspace parked later", async () => {
        const fixture = await newWorkspace({ images: 5, micros: 3_000_000 });
        const stale = await seedJob(fixture, {
          parkedAt: earlier(NOW, MAX_PARK_AGE_MS + DAY),
        });
        const fresh = await seedJob(fixture, { parkedAt: earlier(NOW, HOUR) });
        const quiet = earlier(NOW, MAX_PARK_AGE_MS + 2 * DAY);
        await stampLedger(fixture.workspaceId, {
          balance: quiet,
          subscription: quiet,
        });

        const summary = await resumeParkedWork({ now: NOW });

        expect(summary).toEqual({ resumed: 1, cancelled: 1, stillParked: 0 });
        expect(await statusOf(stale.job.id)).toBe("CANCELLED");
        expect(await statusOf(fresh.job.id)).toBe("QUEUED");
      });

      it("a sweep still closes work that has waited too long in a workspace nothing happened in", async () => {
        const fixture = await newWorkspace({ images: 0, micros: 0 });
        const stale = await seedJob(fixture, {
          parkedAt: earlier(NOW, MAX_PARK_AGE_MS + DAY),
        });
        const quiet = earlier(NOW, MAX_PARK_AGE_MS + 2 * DAY);
        await stampLedger(fixture.workspaceId, {
          balance: quiet,
          subscription: quiet,
        });
        await resumeParkedWork({ now: NOW });
        expect(await statusOf(stale.job.id)).toBe("CANCELLED");
      });
    });

    describe("a long queue", () => {
      it("ranks every parked job of the workspace before trying any, not just the oldest 50", async () => {
        const fixture = await newWorkspace({ images: 1, micros: 3_000_000 });
        // 60 background posts parked one after the other; the client's urgent
        // request is parked after all of them: the 61st by when it parked.
        const background = Array.from({ length: 60 }, (_, index): JobSeed => ({
          priority: "LOW",
          createdBy: "SYSTEM",
          parkedAt: later(earlier(NOW, 2 * HOUR), index * 1_000),
        }));
        const ids = await seedJobs(fixture, [
          ...background,
          { priority: "HIGH", createdBy: "USER", parkedAt: earlier(NOW, HOUR) },
        ]);
        const urgent = ids[60]!;

        const summary = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });

        // Room for one picture, and it goes to the urgent request.
        expect(await statusOf(urgent.jobId)).toBe("QUEUED");
        expect(summary).toEqual({ resumed: 1, cancelled: 0, stillParked: 60 });
        expect(
          await prisma.executionJob.count({
            where: { workspaceId: fixture.workspaceId, status: "QUEUED" },
          }),
        ).toBe(1);
        expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
          used: 0,
          reserved: 1,
        });
      });

      it("sizes each job from its own request, also past the first batch of 50 payloads", async () => {
        const fixture = await newWorkspace({ images: 60, micros: 3_000_000 });
        // 55 ordinary posts (1 picture each) and, last in line, a request for 3
        // variants: its request is not among the first 50 that were read.
        const created = (index: number) =>
          later(earlier(NOW, 3 * HOUR), index * 1_000);
        const ordinary = Array.from({ length: 55 }, (_, index): JobSeed => ({
          createdAt: created(index),
        }));
        const ids = await seedJobs(fixture, [
          ...ordinary,
          {
            payload: { request: "a", variantCount: 3 },
            createdAt: created(55),
          },
        ]);

        const summary = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });

        expect(summary).toEqual({ resumed: 56, cancelled: 0, stillParked: 0 });
        expect(await statusOf(ids[55]!.jobId)).toBe("QUEUED");
        // 55 + 3 pictures: the variants request was sized from its own payload.
        expect(await balanceOf(fixture.workspaceId, "IMAGE")).toEqual({
          used: 0,
          reserved: 58,
        });
      });
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

  describe("background share: the system's own work does not take the user's part", () => {
    // Growth is a full-autonomy plan: the system may use 70% of the window, so with
    // 10 images and 7 used the 3 left are the user's.
    async function nearlyUsedUp(plan: "growth" | "starter" = "growth") {
      const fixture = await newWorkspace({ images: 10, micros: 0 });
      await prisma.subscription.updateMany({
        where: { workspaceId: fixture.workspaceId },
        data: { planKey: plan },
      });
      await prisma.usageBalance.updateMany({
        where: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        data: { periodUsed: B(plan === "growth" ? 7 : 5) },
      });
      return fixture;
    }

    it("a system job waits for the user's share, and a user job behind it still goes", async () => {
      const fixture = await nearlyUsedUp();
      // The system's job ranks first (HIGH) but cannot take what is held back.
      const system = await seedJob(fixture, {
        createdBy: "SYSTEM",
        priority: "HIGH",
      });
      const user = await seedJob(fixture, { createdBy: "USER" });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(summary).toEqual({ resumed: 1, cancelled: 0, stillParked: 1 });
      expect(await statusOf(system.job.id)).toBe("WAITING_BUDGET");
      expect(await statusOf(user.job.id)).toBe("QUEUED");
    });

    it("one blocked system job does not stop the next system jobs from being tried, nor does it hide the user's", async () => {
      const fixture = await nearlyUsedUp();
      const first = await seedJob(fixture, {
        createdBy: "AI",
        priority: "HIGH",
      });
      const second = await seedJob(fixture, {
        createdBy: "SYSTEM",
        priority: "MEDIUM",
      });
      const user = await seedJob(fixture, {
        createdBy: "USER",
        priority: "LOW",
      });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(summary.resumed).toBe(1);
      expect(await statusOf(first.job.id)).toBe("WAITING_BUDGET");
      expect(await statusOf(second.job.id)).toBe("WAITING_BUDGET");
      expect(await statusOf(user.job.id)).toBe("QUEUED");
    });

    it("when even the user's job does not fit, system jobs are not tried at all", async () => {
      const fixture = await nearlyUsedUp();
      await prisma.usageBalance.updateMany({
        where: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        data: { periodUsed: B(10) },
      });
      const user = await seedJob(fixture, {
        createdBy: "USER",
        priority: "HIGH",
      });
      const system = await seedJob(fixture, {
        createdBy: "SYSTEM",
        priority: "MEDIUM",
      });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(summary).toEqual({ resumed: 0, cancelled: 0, stillParked: 2 });
      expect(await statusOf(user.job.id)).toBe("WAITING_BUDGET");
      expect(await statusOf(system.job.id)).toBe("WAITING_BUDGET");
    });

    it("a limited plan (Starter) leaves the system less room than a full one", async () => {
      // The same state on both: 10 granted, 5 used, 5 left. Starter keeps 6 of the
      // 10 for the user (55%, rounded up), so a system job does not fit; Growth
      // keeps 3, so the same job does.
      const starter = await nearlyUsedUp("starter");
      const growth = await nearlyUsedUp("growth");
      await prisma.usageBalance.updateMany({
        where: { workspaceId: growth.workspaceId, unit: "IMAGE" },
        data: { periodUsed: B(5) },
      });
      const onStarter = await seedJob(starter, { createdBy: "SYSTEM" });
      const onGrowth = await seedJob(growth, { createdBy: "SYSTEM" });

      await resumeParkedWork({ workspaceId: starter.workspaceId, now: NOW });
      await resumeParkedWork({ workspaceId: growth.workspaceId, now: NOW });

      expect(await statusOf(onStarter.job.id)).toBe("WAITING_BUDGET");
      expect(await statusOf(onGrowth.job.id)).toBe("QUEUED");
    });

    // A queued job of a task made by `createdBy`, started the way the worker does.
    // beginJobBilling reads the clock itself: it is put inside the window.
    const paidProvider: ExecutionProvider = {
      key: "test-paid",
      type: "AI",
      isConfigured: true,
      canExecute: async () => true,
      usageEstimate: () => ({ class: "content", images: 1 }),
      execute: async (request) => ({
        executionReference: request.correlationId,
        isMock: false,
      }),
      getStatus: async () => ({ status: "COMPLETED", isMock: false }),
    };
    async function startAs(
      fixture: AgencyFixture,
      createdBy: ActorType,
      approval?: Partial<{
        entityType: string;
        status: "PENDING" | "APPROVED" | "REJECTED";
        reviewedByUserId: string | null;
      }>,
    ) {
      const { job, task } = await seedJob(fixture, {
        createdBy,
        jobStatus: "QUEUED",
      });
      if (approval) await approve(fixture, task.id, approval);
      const queued = await prisma.executionJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      const context: ExecutionPolicyContext = {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        taskId: task.id,
        capability: "CREATE_SOCIAL_CREATIVE",
        riskLevel: "MEDIUM",
      };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      try {
        return await beginJobBilling({
          job: queued,
          provider: paidProvider,
          context,
        });
      } finally {
        vi.useRealTimers();
      }
    }

    it("beginJobBilling labels the job by who created its task", async () => {
      const fixture = await nearlyUsedUp();

      const bySystem = await startAs(fixture, "SYSTEM");
      const byUser = await startAs(fixture, "USER");

      expect(bySystem.kind).toBe("stop"); // parked: it would eat into the user's share
      expect(byUser.kind).toBe("run");
      if (byUser.kind === "run") await byUser.operation.finish("aborted");
      if (bySystem.kind === "stop") {
        // The allowance is not used up (3 left): the job says it waits for its share.
        expect(bySystem.job).toMatchObject({
          status: "WAITING_BUDGET",
          errorCode: "QUOTA_HELD_BACK",
        });
      }
    });

    it("a job parked because the allowance itself is used up is not called held back", async () => {
      const fixture = await nearlyUsedUp();
      await prisma.usageBalance.updateMany({
        where: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
        data: { periodUsed: B(10) },
      });

      const bySystem = await startAs(fixture, "SYSTEM");
      const byUser = await startAs(fixture, "USER");

      for (const started of [bySystem, byUser]) {
        expect(started.kind).toBe("stop");
        if (started.kind === "stop") {
          expect(started.job.errorCode).toBe("QUOTA_EXCEEDED");
        }
      }
    });

    describe("the reason a job waits follows the real state, not the moment it was parked", () => {
      const codeOf = (id: string) =>
        prisma.executionJob.findUniqueOrThrow({
          where: { id },
          select: { errorCode: true, updatedAt: true, status: true },
        });

      it("held back by the share, then the person uses up their own allowance: it no longer says their requests are unaffected", async () => {
        const fixture = await nearlyUsedUp();
        const parked = await startAs(fixture, "SYSTEM");
        expect(parked.kind).toBe("stop");
        if (parked.kind !== "stop") return;
        const before = await codeOf(parked.job.id);
        expect(before.errorCode).toBe("QUOTA_HELD_BACK");
        await prisma.usageBalance.updateMany({
          where: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
          data: { periodUsed: B(10) },
        });

        const summary = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });

        expect(summary).toMatchObject({ resumed: 0, stillParked: 1 });
        const after = await codeOf(parked.job.id);
        expect(after.errorCode).toBe("QUOTA_EXCEEDED");
        // Still waiting, and the clock of the wait (expiry, sweep filter) did not move.
        expect(after.status).toBe("WAITING_BUDGET");
        expect(after.updatedAt).toEqual(before.updatedAt);
      });

      it("used up, then the window gives room but not enough for the system's share: it now says held back", async () => {
        const fixture = await nearlyUsedUp();
        await prisma.usageBalance.updateMany({
          where: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
          data: { periodUsed: B(10) },
        });
        const parked = await startAs(fixture, "SYSTEM");
        expect(parked.kind).toBe("stop");
        if (parked.kind !== "stop") return;
        expect((await codeOf(parked.job.id)).errorCode).toBe("QUOTA_EXCEEDED");
        // 3 images are available again, all of them the user's share.
        await prisma.usageBalance.updateMany({
          where: { workspaceId: fixture.workspaceId, unit: "IMAGE" },
          data: { periodUsed: B(7) },
        });

        await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW });

        const after = await codeOf(parked.job.id);
        expect(after.status).toBe("WAITING_BUDGET");
        expect(after.errorCode).toBe("QUOTA_HELD_BACK");
      });

      it("an unchanged refusal writes nothing", async () => {
        const fixture = await nearlyUsedUp();
        const parked = await startAs(fixture, "SYSTEM");
        expect(parked.kind).toBe("stop");
        if (parked.kind !== "stop") return;
        const before = await codeOf(parked.job.id);

        await resumeParkedWork({ workspaceId: fixture.workspaceId, now: NOW });

        expect(await codeOf(parked.job.id)).toEqual(before);
      });
    });

    describe("a system task that a person approved", () => {
      it("is the user's own work: it goes where the system's share would have parked it", async () => {
        const fixture = await nearlyUsedUp(); // 3 left, all of them the user's

        const unapproved = await startAs(fixture, "SYSTEM");
        const approved = await startAs(fixture, "SYSTEM", {
          status: "APPROVED",
          reviewedByUserId: "user-1",
        });

        expect(unapproved.kind).toBe("stop");
        expect(approved.kind).toBe("run");
        if (approved.kind === "run") await approved.operation.finish("aborted");
      });

      it.each([
        ["still waiting", { status: "PENDING" as const }],
        ["rejected", { status: "REJECTED" as const }],
        [
          "approved without a person behind it",
          { status: "APPROVED" as const, reviewedByUserId: null },
        ],
        [
          "an approval of the made piece, not of the task",
          { entityType: "Creative", status: "APPROVED" as const },
        ],
      ])(
        "stays the system's when the approval is %s",
        async (_label, approval) => {
          const fixture = await nearlyUsedUp();

          const started = await startAs(fixture, "SYSTEM", {
            reviewedByUserId: "user-1",
            ...approval,
          });

          expect(started.kind).toBe("stop");
        },
      );

      it("resumes with the user's work: into the user's share, ahead of the system's", async () => {
        const fixture = await nearlyUsedUp(); // 3 left, all of them the user's
        // The system's job is older, so it would go first if nothing set them apart.
        const plain = await seedJob(fixture, { createdBy: "SYSTEM" });
        const approved = await seedJob(fixture, { createdBy: "SYSTEM" });
        await approve(fixture, approved.task.id);

        const summary = await resumeParkedWork({
          workspaceId: fixture.workspaceId,
          now: NOW,
        });

        expect(summary).toEqual({ resumed: 1, cancelled: 0, stillParked: 1 });
        expect(await statusOf(approved.job.id)).toBe("QUEUED");
        expect(await statusOf(plain.job.id)).toBe("WAITING_BUDGET");
      });
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
      // Shadow sweeps every workspace; the strays of other files were retired
      // before the test, so the job is the only one.
      expect(summary.resumed).toBe(1);
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
      expect(summary).toEqual({ resumed: 1, cancelled: 1, stillParked: 0 });
      expect(await statusOf(alive.job.id)).toBe("QUEUED");
      expect(await statusOf(gone.job.id)).toBe("CANCELLED");
    });
  });
});
