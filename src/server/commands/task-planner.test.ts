import { beforeEach, describe, expect, it, vi } from "vitest";

// GA-F7: dispatchApprovedTask, ANALYTICS_EDIT için GaFixes.onTaskApproved'a
// yönlenir (ExecutionJob yok); diğer yetenekler bugünkü yoldan gider.

const findByIdInProject = vi.fn();
const transition = vi.fn();
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { findByIdInProject, transition },
}));
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: {},
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {},
}));
const snapshotCreate = vi.fn();
vi.mock("@/server/context/context-snapshot.service", () => ({
  ContextSnapshotService: { create: snapshotCreate },
}));
vi.mock("@/server/execution/approval-policy", () => ({
  ApprovalPolicy: {},
  isAutoExecutable: vi.fn(),
  maxLevel: vi.fn(),
}));
vi.mock("@/server/execution/approval-details", () => ({
  approvalCategory: vi.fn(),
  buildApprovalDetails: vi.fn(),
}));
vi.mock("@/server/execution/execution-policy", () => ({
  ExecutionPolicy: {},
}));
vi.mock("@/server/execution/capability-input", () => ({
  missingCapabilityInput: vi.fn(),
}));
const dispatch = vi.fn();
vi.mock("@/server/execution/execution-service", () => ({
  ExecutionService: { dispatch },
}));
vi.mock("@/lib/execution-backlog", () => ({ isMetaSpendWrite: vi.fn() }));
const onTaskApproved = vi.fn();
vi.mock("@/server/website-analytics/fixes/fixes", () => ({
  GaFixes: { onTaskApproved },
}));

const { TaskPlanner } = await import("@/server/commands/task-planner");

function task(capability: string) {
  return {
    id: "t1",
    projectId: "p1",
    workspaceId: "w1",
    brandId: "b1",
    capability,
    riskLevel: "HIGH",
    payload: { request: "x" },
    description: null,
  };
}

describe("TaskPlanner.dispatchApprovedTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotCreate.mockResolvedValue({ id: "snap" });
    dispatch.mockResolvedValue({ id: "job" });
  });

  it("hands an ANALYTICS_EDIT task to GaFixes and creates no ExecutionJob", async () => {
    findByIdInProject.mockResolvedValue(task("ANALYTICS_EDIT"));
    const result = await TaskPlanner.dispatchApprovedTask("t1", "p1");
    expect(result).toBeNull();
    expect(onTaskApproved).toHaveBeenCalledTimes(1);
    expect(onTaskApproved).toHaveBeenCalledWith({
      id: "t1",
      projectId: "p1",
      workspaceId: "w1",
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(snapshotCreate).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("never calls GaFixes for any other capability", async () => {
    findByIdInProject.mockResolvedValue(task("WEBSITE_UPDATE"));
    const result = await TaskPlanner.dispatchApprovedTask("t1", "p1");
    expect(result).toEqual({ id: "job" });
    expect(onTaskApproved).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing task", async () => {
    findByIdInProject.mockResolvedValue(null);
    expect(await TaskPlanner.dispatchApprovedTask("t1", "p1")).toBeNull();
    expect(onTaskApproved).not.toHaveBeenCalled();
  });
});
