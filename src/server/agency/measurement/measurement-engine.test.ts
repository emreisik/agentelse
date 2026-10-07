import { beforeEach, describe, expect, it, vi } from "vitest";

// Two core guarantees this file proves:
// 1. A MEASUREMENT_CHECK task ending FAILED/CANCELLED must not leave its
//    MeasurementCheck stuck at RUNNING forever (it must retry with backoff,
//    then eventually give up and let the plan complete).
// 2. A check with no real postUrl/platformPostId/campaignId must be
//    skipped honestly (NO_MEASURABLE_TARGET), never handed the meaningless
//    "measurement plan <id>" fallback.

const task = { findUnique: vi.fn() };
const executionJob = { findFirst: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { task, executionJob },
}));

vi.mock("@/server/agency/fingerprint", () => ({
  taskFingerprint: vi.fn(() => "fp-1"),
}));

vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: {
    planForCapability: vi
      .fn()
      .mockResolvedValue({ task: { id: "check-task-1" } }),
  },
}));

vi.mock("@/server/repositories/measurement.repository", () => ({
  MeasurementRepository: {
    listDueChecks: vi.fn(),
    transitionCheck: vi.fn().mockResolvedValue(undefined),
    completePlanIfDone: vi.fn().mockResolvedValue(undefined),
    findCheckByResultTask: vi.fn(),
    findPlanForTask: vi.fn(),
    createPlan: vi.fn().mockResolvedValue(undefined),
  },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);

vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const { MeasurementEngine } =
  await import("@/server/agency/measurement/measurement-engine");
const { TaskPlanner } = await import("@/server/commands/task-planner");
const { MeasurementRepository } =
  await import("@/server/repositories/measurement.repository");

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
});

function dueCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: "check-1",
    planId: "plan-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    label: "24h engagement check",
    status: "PENDING",
    plan: {
      postUrl: "https://instagram.com/p/abc",
      platformPostId: null,
      campaignId: null,
      platform: "INSTAGRAM",
    },
    ...overrides,
  };
}

describe("MeasurementEngine.runDueChecks", () => {
  it("skips with NO_MEASURABLE_TARGET when the plan has no real identifier", async () => {
    vi.mocked(MeasurementRepository.listDueChecks).mockResolvedValue([
      dueCheck({
        plan: {
          postUrl: null,
          platformPostId: null,
          campaignId: null,
          platform: null,
        },
      }),
    ] as never);

    const started = await MeasurementEngine.runDueChecks();

    expect(started).toBe(0);
    expect(TaskPlanner.planForCapability).not.toHaveBeenCalled();
    expect(MeasurementRepository.transitionCheck).toHaveBeenCalledWith(
      "check-1",
      "p-1",
      "SKIPPED",
      expect.objectContaining({
        resultSummary: expect.objectContaining({
          reason: "NO_MEASURABLE_TARGET",
        }),
      }),
    );
    expect(MeasurementRepository.completePlanIfDone).toHaveBeenCalledWith(
      "plan-1",
    );
  });

  it("creates a MEASUREMENT_CHECK task and moves the check to RUNNING when a real target exists", async () => {
    vi.mocked(MeasurementRepository.listDueChecks).mockResolvedValue([
      dueCheck(),
    ] as never);

    const started = await MeasurementEngine.runDueChecks();

    expect(started).toBe(1);
    expect(TaskPlanner.planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.stringContaining("https://instagram.com/p/abc"),
      }),
    );
    expect(MeasurementRepository.transitionCheck).toHaveBeenCalledWith(
      "check-1",
      "p-1",
      "SCHEDULED",
      { resultTaskId: "check-task-1" },
    );
    expect(MeasurementRepository.transitionCheck).toHaveBeenCalledWith(
      "check-1",
      "p-1",
      "RUNNING",
    );
  });
});

describe("MeasurementEngine.runDueChecks (paused-project guard, audit scenario L)", () => {
  it("skips a PAUSED project's due check but still starts one for an ACTIVE project", async () => {
    const pausedCheck = dueCheck({
      id: "check-paused",
      projectId: "proj-paused",
      plan: {
        postUrl: "https://instagram.com/p/paused",
        platformPostId: null,
        campaignId: null,
        platform: "INSTAGRAM",
        projectId: "proj-paused",
      },
    });
    const activeCheck = dueCheck({
      id: "check-active",
      projectId: "proj-active",
      plan: {
        postUrl: "https://instagram.com/p/active",
        platformPostId: null,
        campaignId: null,
        platform: "INSTAGRAM",
        projectId: "proj-active",
      },
    });
    vi.mocked(MeasurementRepository.listDueChecks).mockResolvedValue([
      pausedCheck,
      activeCheck,
    ] as never);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );

    const started = await MeasurementEngine.runDueChecks();

    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
    expect(started).toBe(1);
    expect(TaskPlanner.planForCapability).toHaveBeenCalledTimes(1);
    expect(TaskPlanner.planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.stringContaining("https://instagram.com/p/active"),
      }),
    );
    expect(MeasurementRepository.transitionCheck).not.toHaveBeenCalledWith(
      "check-paused",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("MeasurementEngine.onCheckTaskTerminal", () => {
  it("retries with backoff when attempts remain", async () => {
    vi.mocked(MeasurementRepository.findCheckByResultTask).mockResolvedValue({
      id: "check-1",
      projectId: "p-1",
      planId: "plan-1",
      status: "RUNNING",
      attemptCount: 0,
      maxAttempts: 3,
    } as never);

    await MeasurementEngine.onCheckTaskTerminal("task-1", "FAILED");

    expect(MeasurementRepository.transitionCheck).toHaveBeenNthCalledWith(
      1,
      "check-1",
      "p-1",
      "FAILED",
      expect.objectContaining({ attemptCount: 1 }),
    );
    expect(MeasurementRepository.transitionCheck).toHaveBeenNthCalledWith(
      2,
      "check-1",
      "p-1",
      "SCHEDULED",
      expect.objectContaining({ nextAttemptAt: expect.any(Date) }),
    );
    expect(MeasurementRepository.completePlanIfDone).not.toHaveBeenCalled();
  });

  it("gives up and completes the plan once maxAttempts is reached", async () => {
    vi.mocked(MeasurementRepository.findCheckByResultTask).mockResolvedValue({
      id: "check-1",
      projectId: "p-1",
      planId: "plan-1",
      status: "RUNNING",
      attemptCount: 2,
      maxAttempts: 3,
    } as never);

    await MeasurementEngine.onCheckTaskTerminal("task-1", "FAILED");

    expect(MeasurementRepository.transitionCheck).toHaveBeenCalledTimes(1);
    expect(MeasurementRepository.transitionCheck).toHaveBeenCalledWith(
      "check-1",
      "p-1",
      "FAILED",
      expect.objectContaining({ attemptCount: 3 }),
    );
    expect(MeasurementRepository.completePlanIfDone).toHaveBeenCalledWith(
      "plan-1",
    );
  });

  it("is a no-op when the check is not found or already resolved", async () => {
    vi.mocked(MeasurementRepository.findCheckByResultTask).mockResolvedValue(
      null,
    );
    await MeasurementEngine.onCheckTaskTerminal("task-1", "FAILED");
    expect(MeasurementRepository.transitionCheck).not.toHaveBeenCalled();

    vi.mocked(MeasurementRepository.findCheckByResultTask).mockResolvedValue({
      id: "check-1",
      projectId: "p-1",
      planId: "plan-1",
      status: "COMPLETED",
      attemptCount: 0,
      maxAttempts: 3,
    } as never);
    await MeasurementEngine.onCheckTaskTerminal("task-2", "CANCELLED");
    expect(MeasurementRepository.transitionCheck).not.toHaveBeenCalled();
  });
});

// SC-F8: WordPress değişikliği görevleri için ölçüm planı açılmaz (SC-F6 ölçer).
describe("MeasurementEngine.planForCompletedTask", () => {
  const websiteTask = (payload: unknown) => ({
    id: "task-w",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    workPlanId: null,
    capability: "WEBSITE_UPDATE",
    title: "Update the site",
    status: "COMPLETED",
    payload,
  });

  it("creates no plan for a completed seo-apply task", async () => {
    task.findUnique.mockResolvedValue(
      websiteTask({ seoApply: { v: 1, changeId: "c1", kind: "TITLE_META" } }),
    );
    await MeasurementEngine.planForCompletedTask("task-w");
    expect(MeasurementRepository.createPlan).not.toHaveBeenCalled();
  });

  it("still plans an unmarked WEBSITE_UPDATE task", async () => {
    task.findUnique.mockResolvedValue(websiteTask({ request: "x" }));
    vi.mocked(MeasurementRepository.findPlanForTask).mockResolvedValue(null);
    executionJob.findFirst.mockResolvedValue(null);
    await MeasurementEngine.planForCompletedTask("task-w");
    expect(MeasurementRepository.createPlan).toHaveBeenCalledTimes(1);
  });
});
