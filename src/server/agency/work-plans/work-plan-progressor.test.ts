import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantee this file exists to prove: a FAILED task must not leave
// its dependents READY forever, and a WorkPlan with a dead branch must still
// reach a terminal status — see task.repository.ts's TASK_FAILED/
// TASK_CANCELLED triggers and this file's onTaskTerminal.

const task = { findUnique: vi.fn(), findMany: vi.fn() };
const taskDependency = { findMany: vi.fn() };
const idea = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { task, taskDependency, idea },
}));

vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: {
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

const { WorkPlanProgressor } =
  await import("@/server/agency/work-plans/work-plan-progressor");
const { TaskRepository } =
  await import("@/server/repositories/task.repository");
const { WorkPlanRepository } =
  await import("@/server/repositories/work-plan.repository");

beforeEach(() => {
  vi.clearAllMocks();
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

  it("does not cascade-cancel dependents for a plain CANCELLED terminal (only FAILED cascades)", async () => {
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
      tasks: [{ status: "CANCELLED" }],
    } as never);

    await WorkPlanProgressor.onTaskTerminal("task-a", "CANCELLED");

    expect(taskDependency.findMany).not.toHaveBeenCalled();
    expect(TaskRepository.transition).not.toHaveBeenCalled();
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
