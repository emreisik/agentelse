import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantee this file exists to prove: a FAILED task must not leave
// its dependents READY forever, and a WorkPlan with a dead branch must still
// reach a terminal status — see task.repository.ts's TASK_FAILED/
// TASK_CANCELLED triggers and this file's onTaskTerminal.

const task = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 1 }),
};
const taskDependency = { findMany: vi.fn() };
const idea = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { task, taskDependency, idea },
}));

vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: {
    approvalNow: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(undefined),
    dispatchApprovedTask: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: {
    transition: vi.fn().mockResolvedValue(undefined),
    dependenciesSatisfied: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("@/server/repositories/work-plan.repository", () => ({
  WorkPlanRepository: {
    findByIdInProject: vi.fn(),
    transition: vi.fn().mockResolvedValue(undefined),
  },
}));

const ideaTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { transition: ideaTransition },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const auditLogRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditLogRecord },
}));

const { WorkPlanProgressor } =
  await import("@/server/agency/work-plans/work-plan-progressor");
const { TaskRepository } =
  await import("@/server/repositories/task.repository");
const { WorkPlanRepository } =
  await import("@/server/repositories/work-plan.repository");
const { TaskPlanner } = await import("@/server/commands/task-planner");

// What the planner answers for a ready node. By default it agrees with the flag the
// node was stored with (nothing changed since it was made); a test says otherwise.
function approvalFollowsStoredFlag() {
  vi.mocked(TaskPlanner.approvalNow).mockImplementation(async (node) => {
    const flagged =
      (node as { requiresApproval?: boolean }).requiresApproval === true;
    return {
      level: flagged ? "LEVEL_3_CLIENT" : "LEVEL_1_INTERNAL_AUTOMATIC",
      requiresApproval: flagged,
      note: undefined,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalFollowsStoredFlag();
  task.updateMany.mockResolvedValue({ count: 1 });
  task.findMany.mockResolvedValue([]);
  taskDependency.findMany.mockResolvedValue([]);
  isProjectAgencyActive.mockResolvedValue(true);
  idea.findUnique.mockResolvedValue(null);
});

describe("WorkPlanProgressor.onTaskTerminal", () => {
  it("cancels a non-terminal direct dependent when its dependency FAILED", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    taskDependency.findMany.mockResolvedValue([
      {
        taskId: "task-b",
        task: { status: "READY", projectId: "p-1" },
      },
    ]);
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      tasks: [{ status: "FAILED" }, { status: "CANCELLED" }],
    } as never);

    await WorkPlanProgressor.onTaskTerminal("task-a", "FAILED");

    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "task-b",
      "p-1",
      "CANCELLED",
      { failureReason: "Upstream dependency task-a failed" },
    );
  });

  it("does not re-cancel a dependent that's already terminal", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    taskDependency.findMany.mockResolvedValue([
      { taskId: "task-b", task: { status: "COMPLETED", projectId: "p-1" } },
      { taskId: "task-c", task: { status: "CANCELLED", projectId: "p-1" } },
    ]);
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      tasks: [{ status: "FAILED" }],
    } as never);

    await WorkPlanProgressor.onTaskTerminal("task-a", "FAILED");

    expect(TaskRepository.transition).not.toHaveBeenCalled();
  });

  it("also cascade-cancels dependents for a plain CANCELLED terminal (e.g. a user-cancelled task)", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    taskDependency.findMany.mockResolvedValue([
      { taskId: "task-b", task: { status: "READY", projectId: "p-1" } },
    ]);
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      tasks: [{ status: "CANCELLED" }, { status: "CANCELLED" }],
    } as never);

    await WorkPlanProgressor.onTaskTerminal("task-a", "CANCELLED");

    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "task-b",
      "p-1",
      "CANCELLED",
      { failureReason: "Upstream dependency task-a was cancelled" },
    );
  });

  it("cascades a second hop: a FAILED root's cascade-CANCELLED dependent's own trigger cancels ITS dependent too", async () => {
    // Simulates WorkPlanBuilder's strategy -> middle -> measurement graph:
    // strategy FAILS, middle cascade-CANCELs (first onTaskTerminal call,
    // status "FAILED"), middle's own TASK_CANCELLED trigger then fires a
    // second onTaskTerminal call (status "CANCELLED") that must still reach
    // measurement, 2 hops from the original failure.
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    taskDependency.findMany.mockResolvedValueOnce([
      { taskId: "middle", task: { status: "READY", projectId: "p-1" } },
    ]);
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      tasks: [{ status: "READY" }],
    } as never);

    await WorkPlanProgressor.onTaskTerminal("strategy", "FAILED");
    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "middle",
      "p-1",
      "CANCELLED",
      { failureReason: "Upstream dependency strategy failed" },
    );

    taskDependency.findMany.mockResolvedValueOnce([
      { taskId: "measurement", task: { status: "READY", projectId: "p-1" } },
    ]);

    await WorkPlanProgressor.onTaskTerminal("middle", "CANCELLED");
    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "measurement",
      "p-1",
      "CANCELLED",
      { failureReason: "Upstream dependency middle was cancelled" },
    );
  });

  it("transitions the plan to FAILED once every task is terminal and at least one FAILED", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      tasks: [
        { status: "FAILED" },
        { status: "CANCELLED" },
        { status: "COMPLETED" },
      ],
    } as never);

    await WorkPlanProgressor.onTaskTerminal("task-a", "FAILED");

    expect(WorkPlanRepository.transition).toHaveBeenCalledWith(
      "plan-1",
      "p-1",
      "FAILED",
    );
  });

  it("resolves the plan to CANCELLED (not COMPLETED) when its only non-success path was a direct CANCELLED, with zero FAILED tasks", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      ideaId: "idea-1",
      tasks: [{ status: "CANCELLED" }, { status: "COMPLETED" }],
    } as never);
    idea.findUnique.mockResolvedValue({ status: "ACTIVE" });

    await WorkPlanProgressor.onTaskTerminal("task-a", "CANCELLED");

    expect(WorkPlanRepository.transition).toHaveBeenCalledWith(
      "plan-1",
      "p-1",
      "CANCELLED",
    );
    // Same idea-archival safety net as the FAILED case — a CANCELLED plan
    // must not strand its ACTIVE idea either (§ audit scenario K).
    expect(ideaTransition).toHaveBeenCalledWith("idea-1", "p-1", "ARCHIVED");
  });

  it("archives the plan's ACTIVE idea when the plan reaches FAILED (audit scenario K)", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      ideaId: "idea-1",
      tasks: [{ status: "FAILED" }, { status: "COMPLETED" }],
    } as never);
    idea.findUnique.mockResolvedValue({ status: "ACTIVE" });

    await WorkPlanProgressor.onTaskTerminal("task-a", "FAILED");

    expect(ideaTransition).toHaveBeenCalledWith("idea-1", "p-1", "ARCHIVED");
  });

  it("does not archive the idea when the plan COMPLETES (no failure)", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      ideaId: "idea-1",
      tasks: [{ status: "COMPLETED" }, { status: "COMPLETED" }],
    } as never);

    await WorkPlanProgressor.onTaskCompleted("task-a");

    expect(ideaTransition).not.toHaveBeenCalled();
  });

  it("does not try to archive an idea that has already moved on from ACTIVE", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      ideaId: "idea-1",
      tasks: [{ status: "FAILED" }, { status: "COMPLETED" }],
    } as never);
    idea.findUnique.mockResolvedValue({ status: "MEASURING" });

    await WorkPlanProgressor.onTaskTerminal("task-a", "FAILED");

    expect(ideaTransition).not.toHaveBeenCalled();
  });

  it("leaves the plan IN_PROGRESS while any task is still non-terminal", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      tasks: [{ status: "FAILED" }, { status: "READY" }],
    } as never);

    await WorkPlanProgressor.onTaskTerminal("task-a", "FAILED");

    expect(WorkPlanRepository.transition).not.toHaveBeenCalled();
  });

  it("no-ops for a task with no work plan", async () => {
    task.findUnique.mockResolvedValue({ workPlanId: null, projectId: "p-1" });

    await WorkPlanProgressor.onTaskTerminal("task-a", "FAILED");

    expect(taskDependency.findMany).not.toHaveBeenCalled();
    expect(WorkPlanRepository.findByIdInProject).not.toHaveBeenCalled();
  });
});

describe("WorkPlanProgressor.onTaskCompleted (regression — shared reconcilePlan)", () => {
  it("still completes the plan once every task is COMPLETED", async () => {
    task.findUnique.mockResolvedValue({
      workPlanId: "plan-1",
      projectId: "p-1",
    });
    vi.mocked(WorkPlanRepository.findByIdInProject).mockResolvedValue({
      id: "plan-1",
      status: "IN_PROGRESS",
      tasks: [{ status: "COMPLETED" }, { status: "COMPLETED" }],
    } as never);

    await WorkPlanProgressor.onTaskCompleted("task-a");

    expect(WorkPlanRepository.transition).toHaveBeenCalledWith(
      "plan-1",
      "p-1",
      "COMPLETED",
    );
  });
});

describe("WorkPlanProgressor.dispatchReadyTasks", () => {
  it("returns 0 and runs no query when the project is paused", async () => {
    isProjectAgencyActive.mockResolvedValue(false);

    const result = await WorkPlanProgressor.dispatchReadyTasks(
      "plan-1",
      "p-paused",
    );

    expect(result).toBe(0);
    expect(task.findMany).not.toHaveBeenCalled();
    expect(isProjectAgencyActive).toHaveBeenCalledWith("p-paused");
  });
});

// A plan node is judged again when its dependencies are done: the flag stored at
// creation is not what decides. (The real policy, planner and database:
// work-plan-progressor.cost-approval.integration.test.ts.)
describe("WorkPlanProgressor.dispatchReadyTasks: the approval decision", () => {
  const node = (overrides: Record<string, unknown> = {}) => ({
    id: "task-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    title: "Do the thing",
    capability: "CREATE_SOCIAL_CREATIVE",
    riskLevel: "LOW",
    createdByType: "SYSTEM",
    createdByUserId: null,
    departmentKey: null,
    requiresApproval: false,
    payload: { request: "a post", variantCount: 3 },
    ...overrides,
  });

  it("asks the planner about every ready node with the payload it is stored with", async () => {
    task.findMany.mockResolvedValueOnce([node(), node({ id: "task-2" })]);

    await WorkPlanProgressor.dispatchReadyTasks("plan-1", "p-1");

    expect(TaskPlanner.approvalNow).toHaveBeenCalledTimes(2);
    expect(TaskPlanner.approvalNow).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "CREATE_SOCIAL_CREATIVE",
        createdByType: "SYSTEM",
        payload: { request: "a post", variantCount: 3 },
      }),
    );
    expect(task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ payload: true }),
      }),
    );
  });

  it("parks a node that is not flagged but now needs asking, flags it, and hands the card its reason", async () => {
    task.findMany.mockResolvedValueOnce([node({ requiresApproval: false })]);
    vi.mocked(TaskPlanner.approvalNow).mockResolvedValue({
      level: "LEVEL_3_CLIENT",
      requiresApproval: true,
      note: "This automatic task would use 3 post images of your plan.",
    });

    const result = await WorkPlanProgressor.dispatchReadyTasks("plan-1", "p-1");

    expect(result).toBe(1);
    expect(task.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "READY" },
      data: { requiresApproval: true },
    });
    expect(TaskPlanner.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      "LEVEL_3_CLIENT",
      "This automatic task would use 3 post images of your plan.",
    );
    expect(TaskPlanner.dispatchApprovedTask).not.toHaveBeenCalled();
  });

  it("dispatches a flagged node that no longer needs asking, and clears its flag", async () => {
    task.findMany.mockResolvedValueOnce([node({ requiresApproval: true })]);
    vi.mocked(TaskPlanner.approvalNow).mockResolvedValue({
      level: "LEVEL_1_INTERNAL_AUTOMATIC",
      requiresApproval: false,
      note: undefined,
    });

    await WorkPlanProgressor.dispatchReadyTasks("plan-1", "p-1");

    expect(task.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "READY" },
      data: { requiresApproval: false },
    });
    expect(TaskPlanner.dispatchApprovedTask).toHaveBeenCalledWith(
      "task-1",
      "p-1",
    );
    expect(TaskPlanner.requestApproval).not.toHaveBeenCalled();
  });

  it("writes nothing when the answer is the flag it already has", async () => {
    task.findMany.mockResolvedValueOnce([
      node({ requiresApproval: true }),
      node({ id: "task-2", requiresApproval: false }),
    ]);

    await WorkPlanProgressor.dispatchReadyTasks("plan-1", "p-1");

    expect(task.updateMany).not.toHaveBeenCalled();
    expect(TaskPlanner.requestApproval).toHaveBeenCalledTimes(1);
    expect(TaskPlanner.dispatchApprovedTask).toHaveBeenCalledTimes(1);
  });

  it("leaves a node whose dependencies are not done alone: it is not even judged", async () => {
    task.findMany.mockResolvedValueOnce([node()]);
    vi.mocked(TaskRepository.dependenciesSatisfied).mockResolvedValueOnce(
      false,
    );

    const result = await WorkPlanProgressor.dispatchReadyTasks("plan-1", "p-1");

    expect(result).toBe(0);
    expect(TaskPlanner.approvalNow).not.toHaveBeenCalled();
  });

  it("one node failing does not stop the others", async () => {
    task.findMany.mockResolvedValueOnce([node(), node({ id: "task-2" })]);
    vi.mocked(TaskPlanner.approvalNow).mockRejectedValueOnce(
      new Error("exploded"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await WorkPlanProgressor.dispatchReadyTasks("plan-1", "p-1");
    spy.mockRestore();

    expect(result).toBe(1);
    expect(TaskPlanner.dispatchApprovedTask).toHaveBeenCalledWith(
      "task-2",
      "p-1",
    );
  });
});

describe("WorkPlanProgressor.sweepOrphanedReadyTasks", () => {
  function readyTask(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "task-1",
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
      title: "Do the thing",
      capability: "CREATE_COPY",
      riskLevel: "LOW",
      createdByType: "SYSTEM",
      createdByUserId: null,
      departmentKey: null,
      requiresApproval: false,
      ...overrides,
    };
  }

  it("dispatches a stale READY task with satisfied deps and logs one audit entry for the rescued plan", async () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    const staleSince = new Date("2026-09-24T10:00:00.000Z");
    task.findMany
      .mockResolvedValueOnce([
        {
          workPlanId: "plan-1",
          projectId: "p-1",
          workspaceId: "ws-1",
          updatedAt: staleSince,
        },
      ])
      .mockResolvedValueOnce([readyTask()]);

    const result = await WorkPlanProgressor.sweepOrphanedReadyTasks(20, now);

    expect(result).toBe(1);
    expect(TaskPlanner.dispatchApprovedTask).toHaveBeenCalledWith(
      "task-1",
      "p-1",
    );
    expect(auditLogRecord).toHaveBeenCalledTimes(1);
    expect(auditLogRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "p-1",
        action: "self-healing.stale_ready_tasks_rescued",
        entityType: "WorkPlan",
        entityId: "plan-1",
        metadata: expect.objectContaining({
          dispatchedCount: 1,
          staleForMinutes: 120,
        }),
      }),
    );
  });

  it("does not act when the stale scan finds nothing, and queries with the expected cutoff", async () => {
    const now = new Date("2026-09-24T12:00:00.000Z");

    const result = await WorkPlanProgressor.sweepOrphanedReadyTasks(20, now);

    expect(result).toBe(0);
    expect(task.findMany).toHaveBeenCalledTimes(1);
    expect(task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workPlanId: { not: null },
          status: "READY",
          updatedAt: { lt: new Date("2026-09-24T11:30:00.000Z") },
        },
        distinct: ["workPlanId"],
        take: 20,
      }),
    );
    expect(TaskRepository.dependenciesSatisfied).not.toHaveBeenCalled();
    expect(auditLogRecord).not.toHaveBeenCalled();
  });

  it("skips a stale task in a PAUSED project (no dispatch, no audit log)", async () => {
    task.findMany.mockResolvedValueOnce([
      {
        workPlanId: "plan-1",
        projectId: "p-paused",
        workspaceId: "ws-1",
        updatedAt: new Date("2026-09-24T10:00:00.000Z"),
      },
    ]);
    isProjectAgencyActive.mockResolvedValueOnce(false);

    const result = await WorkPlanProgressor.sweepOrphanedReadyTasks(
      20,
      new Date("2026-09-24T12:00:00.000Z"),
    );

    expect(result).toBe(0);
    expect(TaskPlanner.dispatchApprovedTask).not.toHaveBeenCalled();
    expect(TaskPlanner.requestApproval).not.toHaveBeenCalled();
    expect(auditLogRecord).not.toHaveBeenCalled();
  });

  it("leaves a task whose dependency isn't satisfied yet alone (dispatchReadyTasks's own gate is not bypassed)", async () => {
    task.findMany
      .mockResolvedValueOnce([
        {
          workPlanId: "plan-1",
          projectId: "p-1",
          workspaceId: "ws-1",
          updatedAt: new Date("2026-09-24T10:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([readyTask()]);
    vi.mocked(TaskRepository.dependenciesSatisfied).mockResolvedValueOnce(
      false,
    );

    const result = await WorkPlanProgressor.sweepOrphanedReadyTasks(
      20,
      new Date("2026-09-24T12:00:00.000Z"),
    );

    expect(result).toBe(0);
    expect(TaskPlanner.dispatchApprovedTask).not.toHaveBeenCalled();
    expect(auditLogRecord).not.toHaveBeenCalled();
  });

  it("parks a requiresApproval stale task via requestApproval instead of dispatching it, and still logs it as rescued", async () => {
    task.findMany
      .mockResolvedValueOnce([
        {
          workPlanId: "plan-1",
          projectId: "p-1",
          workspaceId: "ws-1",
          updatedAt: new Date("2026-09-24T10:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([readyTask({ requiresApproval: true })]);

    const result = await WorkPlanProgressor.sweepOrphanedReadyTasks(
      20,
      new Date("2026-09-24T12:00:00.000Z"),
    );

    expect(result).toBe(1);
    expect(TaskPlanner.requestApproval).toHaveBeenCalledTimes(1);
    expect(TaskPlanner.dispatchApprovedTask).not.toHaveBeenCalled();
    expect(auditLogRecord).toHaveBeenCalledTimes(1);
  });

  it("processes multiple distinct stale workPlanIds in one sweep and logs one audit entry per rescued plan", async () => {
    task.findMany
      .mockResolvedValueOnce([
        {
          workPlanId: "plan-1",
          projectId: "p-1",
          workspaceId: "ws-1",
          updatedAt: new Date("2026-09-24T10:00:00.000Z"),
        },
        {
          workPlanId: "plan-2",
          projectId: "p-2",
          workspaceId: "ws-2",
          updatedAt: new Date("2026-09-24T09:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([readyTask({ id: "task-1", projectId: "p-1" })])
      .mockResolvedValueOnce([readyTask({ id: "task-2", projectId: "p-2" })]);

    const result = await WorkPlanProgressor.sweepOrphanedReadyTasks(
      20,
      new Date("2026-09-24T12:00:00.000Z"),
    );

    expect(result).toBe(2);
    expect(auditLogRecord).toHaveBeenCalledTimes(2);
    expect(auditLogRecord).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "plan-1" }),
    );
    expect(auditLogRecord).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "plan-2" }),
    );
  });
});
