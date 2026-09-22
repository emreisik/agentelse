import { beforeEach, describe, expect, it, vi } from "vitest";

// The core Phase 1 guarantee: TASK_FAILED/TASK_CANCELLED triggers actually
// reach registered handlers, symmetric to how TASK_COMPLETED already did —
// previously a FAILED task was chat/Telegram-visible but structurally
// invisible to the rest of the Agency OS loop.

const materializeTask = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/agency/intelligence/research-result-materializer", () => ({
  ResultMaterializer: { materializeTask },
}));

vi.mock("@/server/agency/setup/project-setup-orchestrator", () => ({
  ProjectSetupOrchestrator: { advanceAll: vi.fn().mockResolvedValue(0) },
}));

const claimPending = vi.fn();
const markProcessed = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/agency-trigger.repository", () => ({
  AgencyTriggerRepository: { claimPending, markProcessed, markFailed },
}));

vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));

const getOrCreate = vi.fn().mockResolvedValue({});
const recordProgress = vi.fn().mockResolvedValue(undefined);
const recordNoProgress = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  AgencyLoopStateRepository: {
    getOrCreate,
    recordProgress,
    recordNoProgress,
  },
}));

const cycleStart = vi.fn().mockResolvedValue({ id: "cycle-1" });
const cycleComplete = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/agency-cycle.repository", () => ({
  AgencyCycleRepository: { start: cycleStart, complete: cycleComplete },
}));

const {
  ContinuousAgencyEngine,
  registerTaskCompletedHandler,
  registerTaskTerminalHandler,
} = await import("@/server/agency/continuous/continuous-agency-engine");

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    id: "trig-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    type: "TASK_COMPLETED",
    payload: { taskId: "task-1" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ContinuousAgencyEngine.processTriggers", () => {
  it("runs TASK_COMPLETED_HANDLERS and materializes the result for TASK_COMPLETED", async () => {
    claimPending.mockResolvedValue([trigger()]);
    const handler = vi.fn().mockResolvedValue(undefined);
    registerTaskCompletedHandler(handler);

    await ContinuousAgencyEngine.processTriggers();

    expect(materializeTask).toHaveBeenCalledWith("task-1");
    expect(handler).toHaveBeenCalledWith("task-1", {
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
    });
    expect(markProcessed).toHaveBeenCalledWith("trig-1");
  });

  it("runs TASK_TERMINAL_HANDLERS (not materializeTask) for TASK_FAILED", async () => {
    claimPending.mockResolvedValue([
      trigger({
        type: "TASK_FAILED",
        payload: { taskId: "task-2", terminalStatus: "FAILED" },
      }),
    ]);
    const handler = vi.fn().mockResolvedValue(undefined);
    registerTaskTerminalHandler(handler);

    await ContinuousAgencyEngine.processTriggers();

    expect(materializeTask).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith("task-2", "FAILED", {
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
    });
    expect(markProcessed).toHaveBeenCalledWith("trig-1");
  });

  it("runs TASK_TERMINAL_HANDLERS with CANCELLED for TASK_CANCELLED", async () => {
    claimPending.mockResolvedValue([
      trigger({
        type: "TASK_CANCELLED",
        payload: { taskId: "task-3", terminalStatus: "CANCELLED" },
      }),
    ]);
    const handler = vi.fn().mockResolvedValue(undefined);
    registerTaskTerminalHandler(handler);

    await ContinuousAgencyEngine.processTriggers();

    expect(handler).toHaveBeenCalledWith("task-3", "CANCELLED", {
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
    });
  });

  it("marks the trigger FAILED (not processed) when a handler throws", async () => {
    claimPending.mockResolvedValue([
      trigger({ type: "TASK_FAILED", payload: { taskId: "task-4" } }),
    ]);
    registerTaskTerminalHandler(vi.fn().mockRejectedValue(new Error("boom")));

    await ContinuousAgencyEngine.processTriggers();

    expect(markProcessed).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith("trig-1", "boom");
  });

  it("records AgencyCycle/AgencyLoopState progress for a task trigger that did work", async () => {
    claimPending.mockResolvedValue([trigger()]);
    registerTaskCompletedHandler(vi.fn().mockResolvedValue(undefined));

    await ContinuousAgencyEngine.processTriggers();

    expect(getOrCreate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
    });
    expect(cycleStart).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: "p-1", brandId: "b-1" },
      { type: "TASK_COMPLETED", id: "trig-1" },
    );
    expect(recordProgress).toHaveBeenCalledWith("p-1", "TASK_COMPLETED");
    expect(cycleComplete).toHaveBeenCalledWith("cycle-1", "COMPLETED");
  });

  it("records NOOP when a task trigger has no actionable payload", async () => {
    claimPending.mockResolvedValue([
      trigger({ type: "TASK_COMPLETED", payload: {} }),
    ]);

    await ContinuousAgencyEngine.processTriggers();

    expect(recordNoProgress).toHaveBeenCalledWith("p-1", "TASK_COMPLETED");
    expect(cycleComplete).toHaveBeenCalledWith("cycle-1", "NOOP");
  });

  it("records FAILED on the cycle and no-progress on the loop state when a handler throws", async () => {
    claimPending.mockResolvedValue([trigger({ type: "TASK_FAILED" })]);
    registerTaskTerminalHandler(vi.fn().mockRejectedValue(new Error("boom")));

    await ContinuousAgencyEngine.processTriggers();

    expect(recordNoProgress).toHaveBeenCalledWith("p-1", "TASK_FAILED");
    expect(cycleComplete).toHaveBeenCalledWith("cycle-1", "FAILED", {
      errorCount: 1,
    });
  });

  it("does not touch AgencyCycle/AgencyLoopState for non-task trigger types", async () => {
    claimPending.mockResolvedValue([
      trigger({ type: "SCHEDULE", payload: {} }),
    ]);

    await ContinuousAgencyEngine.processTriggers();

    expect(getOrCreate).not.toHaveBeenCalled();
    expect(cycleStart).not.toHaveBeenCalled();
    expect(recordProgress).not.toHaveBeenCalled();
    expect(recordNoProgress).not.toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith("trig-1");
  });
});
