import { beforeEach, describe, expect, it, vi } from "vitest";

// Reliability audit concern 8 (docs/brand-workspace-migration.md §7):
// a schedule that throws must not retry on every single tick forever with
// no cooldown, and one broken schedule must not block the rest of the
// batch. Same mocking pattern as work-plan-progressor.test.ts.

const projectSchedule = { findMany: vi.fn(), update: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { projectSchedule },
}));

const planForCapability = vi.fn();
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability },
}));

const publishNextQueuedInstagramCreative = vi.fn();
vi.mock("@/server/commands/approval-decisions", () => ({
  publishNextQueuedInstagramCreative,
}));

const planWeeklyInstagramContent = vi.fn();
vi.mock("@/server/agency/content/instagram-week-planner", () => ({
  planWeeklyInstagramContent,
}));

const deadLetterCreate = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/dead-letter.repository", () => ({
  DeadLetterRepository: { create: deadLetterCreate },
}));

const { SchedulerService } = await import("./scheduler-service");

function schedule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sched-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    name: "Weekly research",
    capability: "SIGNAL_SCAN",
    scheduleType: "INTERVAL",
    cronExpression: null,
    timezone: null,
    configuration: { intervalMinutes: 60 },
    enabled: true,
    nextRunAt: new Date("2026-09-24T12:00:00.000Z"),
    lastRunAt: null,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  planForCapability.mockResolvedValue(undefined);
  projectSchedule.update.mockResolvedValue({});
});

describe("SchedulerService.runDueSchedules", () => {
  it("plans the capability and resets failure bookkeeping on success", async () => {
    projectSchedule.findMany.mockResolvedValue([schedule()]);

    const ran = await SchedulerService.runDueSchedules();

    expect(ran).toBe(1);
    expect(planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1", capability: "SIGNAL_SCAN" }),
    );
    expect(projectSchedule.update).toHaveBeenCalledWith({
      where: { id: "sched-1" },
      data: expect.objectContaining({
        consecutiveFailures: 0,
        lastError: null,
      }),
    });
  });

  it("retries with backoff (schedule stays enabled) when attempts remain", async () => {
    planForCapability.mockRejectedValue(new Error("transient DB error"));
    projectSchedule.findMany.mockResolvedValue([
      schedule({ consecutiveFailures: 1 }),
    ]);

    const ran = await SchedulerService.runDueSchedules();

    expect(ran).toBe(0);
    expect(projectSchedule.update).toHaveBeenCalledWith({
      where: { id: "sched-1" },
      data: expect.objectContaining({
        consecutiveFailures: 2,
        lastError: "transient DB error",
      }),
    });
    const call = projectSchedule.update.mock.calls[0]![0];
    expect(call.data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(call.data.enabled).toBeUndefined();
    expect(deadLetterCreate).not.toHaveBeenCalled();
  });

  it("disables the schedule and dead-letters it once MAX_ATTEMPTS is reached", async () => {
    planForCapability.mockRejectedValue(new Error("permanently broken"));
    projectSchedule.findMany.mockResolvedValue([
      schedule({ consecutiveFailures: 4 }), // 5th attempt == MAX_ATTEMPTS
    ]);

    await SchedulerService.runDueSchedules();

    expect(projectSchedule.update).toHaveBeenCalledWith({
      where: { id: "sched-1" },
      data: {
        enabled: false,
        consecutiveFailures: 5,
        lastError: "permanently broken",
      },
    });
    expect(deadLetterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "scheduler.run_due_schedule_failed_after_5_attempts",
        attempts: 5,
        lastError: "permanently broken",
      }),
    );
  });

  it("does not let one failing schedule block the next one in the same batch", async () => {
    planForCapability.mockImplementation(
      async (input: { projectId: string }) => {
        if (input.projectId === "p-broken") {
          throw new Error("boom");
        }
      },
    );
    projectSchedule.findMany.mockResolvedValue([
      schedule({ id: "sched-broken", projectId: "p-broken" }),
      schedule({ id: "sched-ok", projectId: "p-ok" }),
    ]);

    const ran = await SchedulerService.runDueSchedules();

    expect(ran).toBe(1);
    expect(planForCapability).toHaveBeenCalledTimes(2);
    expect(projectSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sched-ok" } }),
    );
  });

  it("routes PUBLISH_NEXT_READY schedules to the queue-release helper, not the generic planner", async () => {
    projectSchedule.findMany.mockResolvedValue([
      schedule({
        capability: "INSTAGRAM_PUBLISH",
        configuration: { mode: "PUBLISH_NEXT_READY" },
      }),
    ]);

    await SchedulerService.runDueSchedules();

    expect(publishNextQueuedInstagramCreative).toHaveBeenCalledOnce();
    expect(planForCapability).not.toHaveBeenCalled();
  });

  it("switches off a leftover idea-generation row instead of running it or planning it as a task", async () => {
    projectSchedule.findMany.mockResolvedValue([
      schedule({
        id: "sched-ideas",
        name: "Idea generation schedule",
        capability: "GENERATE_IDEAS",
        scheduleType: "CRON",
        cronExpression: "0 9 * * 1",
        configuration: { cadence: "WEEKLY", limit: 5 },
      }),
      schedule({ id: "sched-ok", projectId: "p-ok" }),
    ]);

    const ran = await SchedulerService.runDueSchedules();

    // Only the ordinary schedule ran; the retired one was not planned as a
    // task named "Idea generation schedule" either.
    expect(ran).toBe(1);
    expect(planForCapability).toHaveBeenCalledOnce();
    expect(planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-ok" }),
    );
    expect(projectSchedule.update).toHaveBeenCalledWith({
      where: { id: "sched-ideas" },
      data: {
        enabled: false,
        lastError: expect.stringContaining("Retired"),
      },
    });
    expect(deadLetterCreate).not.toHaveBeenCalled();
  });
});
