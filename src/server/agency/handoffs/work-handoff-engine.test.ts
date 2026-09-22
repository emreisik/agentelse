import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantee this file exists to prove: WorkHandoffRepository.listByStatus
// (see work-handoff.repository.ts) had zero callers despite doing exactly the
// right query — a handoff whose task creation was deferred by the daily cap
// (accept()'s old "a later tick can create the task" comment) had no later
// tick to resume it, and nothing ever wrote WorkHandoffStatus.EXPIRED. This
// tests progressPending, the tick step that closes both gaps, plus a
// non-regression check that accept()'s own behavior is unchanged now that it
// shares attemptTaskCreation with progressPending.

const agencyDecision = { findFirst: vi.fn() };
const projectGoal = { findMany: vi.fn() };
const workHandoff = { findFirst: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { agencyDecision, projectGoal, workHandoff },
}));

vi.mock("@/server/agency/departments/department-router", () => ({
  DepartmentRouter: {
    allowsTaskCreation: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: {
    planForCapability: vi.fn(),
  },
}));

vi.mock("@/server/repositories/agency-decision.repository", () => ({
  AgencyDecisionRepository: {
    create: vi.fn(),
  },
}));

vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    checkAndIncrement: vi.fn(),
  },
}));

vi.mock("@/server/repositories/work-handoff.repository", () => ({
  WorkHandoffRepository: {
    findByIdInProject: vi.fn(),
    listByStatus: vi.fn(),
    transition: vi.fn(),
  },
}));

const { WorkHandoffEngine } =
  await import("@/server/agency/handoffs/work-handoff-engine");
const { DepartmentRouter } =
  await import("@/server/agency/departments/department-router");
const { TaskPlanner } = await import("@/server/commands/task-planner");
const { AgencyDecisionRepository } =
  await import("@/server/repositories/agency-decision.repository");
const { AutonomyPolicyRepository } =
  await import("@/server/repositories/autonomy-policy.repository");
const { WorkHandoffRepository } =
  await import("@/server/repositories/work-handoff.repository");

function makeHandoff(overrides: Record<string, unknown> = {}) {
  return {
    id: "handoff-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    workPlanId: null,
    fromDepartment: "COPY_CONTENT",
    toDepartment: "WEB_PRODUCT",
    fromTaskId: null,
    toTaskId: null,
    reason: "Approved content ready for landing page deployment",
    payload: { capability: "WEBSITE_UPDATE", request: "Deploy the page" },
    status: "ACCEPTED",
    decisionId: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(DepartmentRouter.allowsTaskCreation).mockResolvedValue(true);
  vi.mocked(WorkHandoffRepository.transition).mockResolvedValue(
    undefined as never,
  );
  projectGoal.findMany.mockResolvedValue([{ id: "goal-1" }]);
});

describe("WorkHandoffEngine.progressPending", () => {
  it("Test F: resumes an ACCEPTED handoff deferred by a cap hit and creates the task once capacity is available", async () => {
    const handoff = makeHandoff({ status: "ACCEPTED" });
    vi.mocked(WorkHandoffRepository.listByStatus).mockImplementation(
      (status) =>
        Promise.resolve(status === "ACCEPTED" ? [handoff] : []) as never,
    );
    agencyDecision.findFirst.mockResolvedValue({ id: "decision-1" });
    vi.mocked(AutonomyPolicyRepository.checkAndIncrement).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(TaskPlanner.planForCapability).mockResolvedValue({
      task: { id: "task-1" },
    } as never);

    const result = await WorkHandoffEngine.progressPending(10);

    expect(result).toEqual({ retried: 1, expired: 0 });
    expect(TaskPlanner.planForCapability).toHaveBeenCalledTimes(1);
    expect(WorkHandoffRepository.transition).toHaveBeenCalledWith(
      "handoff-1",
      "proj-1",
      "TASK_CREATED",
      { toTaskId: "task-1", decisionId: "decision-1" },
    );
  });

  it("transitions handoffs whose expiresAt has passed to EXPIRED, for both ACCEPTED and PROPOSED", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    const acceptedExpired = makeHandoff({
      id: "handoff-2",
      status: "ACCEPTED",
      expiresAt: pastDate,
    });
    const proposedExpired = makeHandoff({
      id: "handoff-3",
      status: "PROPOSED",
      expiresAt: pastDate,
    });
    vi.mocked(WorkHandoffRepository.listByStatus).mockImplementation(
      (status) => {
        if (status === "ACCEPTED")
          return Promise.resolve([acceptedExpired]) as never;
        if (status === "PROPOSED")
          return Promise.resolve([proposedExpired]) as never;
        return Promise.resolve([]) as never;
      },
    );

    const result = await WorkHandoffEngine.progressPending(10);

    expect(result).toEqual({ retried: 0, expired: 2 });
    expect(WorkHandoffRepository.transition).toHaveBeenCalledWith(
      "handoff-2",
      "proj-1",
      "EXPIRED",
    );
    expect(WorkHandoffRepository.transition).toHaveBeenCalledWith(
      "handoff-3",
      "proj-1",
      "EXPIRED",
    );
    // An expired handoff is never worth resuming — skip straight past it,
    // no decision lookup or task-creation attempt.
    expect(agencyDecision.findFirst).not.toHaveBeenCalled();
    expect(TaskPlanner.planForCapability).not.toHaveBeenCalled();
  });

  it("leaves a still-capped, not-yet-expired ACCEPTED handoff untouched (no transition, no duplicate task creation)", async () => {
    const handoff = makeHandoff({
      status: "ACCEPTED",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    vi.mocked(WorkHandoffRepository.listByStatus).mockImplementation(
      (status) =>
        Promise.resolve(status === "ACCEPTED" ? [handoff] : []) as never,
    );
    agencyDecision.findFirst.mockResolvedValue({ id: "decision-1" });
    vi.mocked(AutonomyPolicyRepository.checkAndIncrement).mockRejectedValue(
      new Error("BUDGET_EXCEEDED"),
    );

    const result = await WorkHandoffEngine.progressPending(10);

    expect(result).toEqual({ retried: 0, expired: 0 });
    expect(TaskPlanner.planForCapability).not.toHaveBeenCalled();
    expect(WorkHandoffRepository.transition).not.toHaveBeenCalled();
  });
});

describe("WorkHandoffEngine.accept (regression — shared attemptTaskCreation helper)", () => {
  it("still creates the task and transitions to TASK_CREATED when capacity is available", async () => {
    const handoff = makeHandoff({ status: "PROPOSED" });
    vi.mocked(WorkHandoffRepository.findByIdInProject).mockResolvedValue(
      handoff as never,
    );
    vi.mocked(AgencyDecisionRepository.create).mockResolvedValue({
      id: "decision-9",
    } as never);
    vi.mocked(AutonomyPolicyRepository.checkAndIncrement).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(TaskPlanner.planForCapability).mockResolvedValue({
      task: { id: "task-9" },
    } as never);

    const result = await WorkHandoffEngine.accept("handoff-1", "proj-1", {
      capability: "WEBSITE_UPDATE" as never,
      request: "Deploy the page",
      goalIds: ["goal-1"],
    });

    expect(result).toEqual({
      handoff,
      task: { id: "task-9" },
      decision: { id: "decision-9" },
    });
    expect(WorkHandoffRepository.transition).toHaveBeenNthCalledWith(
      1,
      "handoff-1",
      "proj-1",
      "ACCEPTED",
    );
    expect(WorkHandoffRepository.transition).toHaveBeenNthCalledWith(
      2,
      "handoff-1",
      "proj-1",
      "TASK_CREATED",
      { toTaskId: "task-9", decisionId: "decision-9" },
    );
  });

  it("still leaves the handoff ACCEPTED with no error when the daily task cap is hit", async () => {
    const handoff = makeHandoff({ status: "PROPOSED" });
    vi.mocked(WorkHandoffRepository.findByIdInProject).mockResolvedValue(
      handoff as never,
    );
    vi.mocked(AgencyDecisionRepository.create).mockResolvedValue({
      id: "decision-9",
    } as never);
    vi.mocked(AutonomyPolicyRepository.checkAndIncrement).mockRejectedValue(
      new Error("BUDGET_EXCEEDED"),
    );

    const result = await WorkHandoffEngine.accept("handoff-1", "proj-1", {
      capability: "WEBSITE_UPDATE" as never,
      request: "Deploy the page",
      goalIds: ["goal-1"],
    });

    expect(result).toBeNull();
    expect(TaskPlanner.planForCapability).not.toHaveBeenCalled();
    // ACCEPTED was set once, and never advanced any further — this is
    // exactly the state progressPending's ACCEPTED sweep looks for.
    expect(WorkHandoffRepository.transition).toHaveBeenCalledTimes(1);
    expect(WorkHandoffRepository.transition).toHaveBeenCalledWith(
      "handoff-1",
      "proj-1",
      "ACCEPTED",
    );
  });
});
