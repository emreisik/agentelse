import { beforeEach, describe, expect, it, vi } from "vitest";

// SC-F8 doğrulaması: işaretli (payload.seoApply) WEBSITE_UPDATE görevi
// workPlanId taşımaz ve ExecutionJob'u yoktur. TASK_COMPLETED / TASK_FAILED /
// TASK_CANCELLED tetikleyicilerinin tüketicileri bu görevde hiçbir şey yapmaz.

const taskFindUnique = vi.fn();
const taskDependencyFindMany = vi.fn();
const workHandoffFindFirst = vi.fn();
const adsDecisionFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: taskFindUnique },
    taskDependency: { findMany: taskDependencyFindMany },
    workHandoff: { findFirst: workHandoffFindFirst },
    adsDecision: { findFirst: adsDecisionFindFirst },
  },
}));
vi.mock("@/server/commands/task-planner", () => ({ TaskPlanner: {} }));
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn() },
}));
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {},
}));
const taskTransition = vi.fn();
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: taskTransition },
}));
vi.mock("@/server/repositories/work-plan.repository", () => ({
  WorkPlanRepository: {},
}));
vi.mock("@/server/repositories/work-handoff.repository", () => ({
  WorkHandoffRepository: { transition: vi.fn() },
}));

const { WorkPlanProgressor } = await import(
  "@/server/agency/work-plans/work-plan-progressor"
);
const { WorkHandoffEngine } = await import(
  "@/server/agency/handoffs/work-handoff-engine"
);
const { AdsDecisions } = await import("@/server/ads/decisions");

const seoTask = {
  id: "t-seo",
  workPlanId: null,
  projectId: "p-1",
  capability: "WEBSITE_UPDATE",
  status: "COMPLETED",
  payload: { seoApply: { v: 1, changeId: "c1", kind: "TITLE_META" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  taskFindUnique.mockResolvedValue(seoTask);
  workHandoffFindFirst.mockResolvedValue(null);
  adsDecisionFindFirst.mockResolvedValue(null);
});

describe("task event consumers and a seo-apply task", () => {
  it("WorkPlanProgressor ignores a task without a work plan", async () => {
    await WorkPlanProgressor.onTaskCompleted("t-seo");
    await WorkPlanProgressor.onTaskTerminal("t-seo", "FAILED");
    await WorkPlanProgressor.onTaskTerminal("t-seo", "CANCELLED");
    expect(taskDependencyFindMany).not.toHaveBeenCalled();
    expect(taskTransition).not.toHaveBeenCalled();
  });

  it("WorkHandoffEngine finds no handoff and does nothing", async () => {
    await WorkHandoffEngine.onTaskCompleted("t-seo");
    expect(workHandoffFindFirst).toHaveBeenCalledTimes(1);
  });

  it("AdsDecisions finds no decision and does nothing", async () => {
    await AdsDecisions.onTaskCompleted("t-seo");
    await AdsDecisions.onTaskTerminal("t-seo", "FAILED");
    expect(adsDecisionFindFirst).toHaveBeenCalledTimes(2);
  });
});
