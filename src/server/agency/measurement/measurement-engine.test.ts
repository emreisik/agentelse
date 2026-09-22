import { beforeEach, describe, expect, it, vi } from "vitest";

// Two core guarantees this file proves:
// 1. A MEASUREMENT_CHECK task ending FAILED/CANCELLED must not leave its
//    MeasurementCheck stuck at RUNNING forever (it must retry with backoff,
//    then eventually give up and let the plan complete).
// 2. A check with no real postUrl/platformPostId/campaignId must be
//    skipped honestly (NO_MEASURABLE_TARGET), never handed the meaningless
//    "measurement plan <id>" fallback.

const task = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { task },
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
  },
}));

const { MeasurementEngine } =
  await import("@/server/agency/measurement/measurement-engine");
const { TaskPlanner } = await import("@/server/commands/task-planner");
const { MeasurementRepository } =
  await import("@/server/repositories/measurement.repository");

beforeEach(() => {
  vi.clearAllMocks();
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
