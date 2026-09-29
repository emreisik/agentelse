import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the PLANNING-stranding bug: IDEA_TRANSITIONS
// (state-machine/transitions.ts) allows exactly one exit from PLANNING ->
// ACTIVE, and nothing ever re-lists or retries a PLANNING idea. So an Idea
// that reaches PLANNING and then hits a thrown error (autonomy budget cap,
// work-plan builder failure, planner failure) used to be stranded there
// forever, permanently occupying a maxActiveIdeas slot
// (IdeaRepository.countActive() counts PLANNING as active). decideOnIdea
// must not transition the Idea past SHORTLISTED until the risky operation
// it's paying for has actually succeeded.

const ideaTransition = vi.fn().mockResolvedValue(undefined);
const findByIdInProject = vi.fn();
const listByStatusPerProject = vi.fn();

vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {
    findByIdInProject,
    transition: ideaTransition,
    listByStatusPerProject,
  },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);

vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const decisionCreate = vi.fn();
const findMostRecentForSubject = vi.fn();

vi.mock("@/server/repositories/agency-decision.repository", () => ({
  AgencyDecisionRepository: {
    create: decisionCreate,
    findMostRecentForSubject,
  },
}));

const getOrCreate = vi.fn();
const checkAndIncrement = vi.fn();

vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    getOrCreate,
    checkAndIncrement,
  },
}));

const findOpportunityByIdInProject = vi.fn();

vi.mock("@/server/repositories/opportunity.repository", () => ({
  OpportunityRepository: {
    findByIdInProject: findOpportunityByIdInProject,
  },
}));

const listActiveOrApproved = vi.fn();

vi.mock("@/server/repositories/project-goal.repository", () => ({
  ProjectGoalRepository: {
    listActiveOrApproved,
  },
}));

const findRecentByFingerprint = vi.fn();
const countActiveSystemTasks = vi.fn();

vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: {
    findRecentByFingerprint,
    countActiveSystemTasks,
  },
}));

const planForCapability = vi.fn();

vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: {
    planForCapability,
  },
}));

vi.mock("@/server/agency/departments/department-router", () => ({
  DepartmentRouter: {
    ownerOf: vi.fn().mockReturnValue("COPY_CONTENT"),
  },
}));

vi.mock("@/server/agency/goals/goal-engine", () => ({
  GoalEngine: {
    assertGoalsLinked: vi.fn(),
  },
}));

const { AgencyDirector } =
  await import("@/server/agency/director/agency-director");

// Scored well above APPROVE_THRESHOLD (0.45) with a single, non-visual
// department so decideOnIdea takes the CREATE_TASK path (not
// CREATE_MULTI_DEPARTMENT_PLAN) — that's the path with the autonomy cap
// check this test targets.
const baseIdea = {
  id: "idea-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  opportunityId: "opp-1",
  status: "SHORTLISTED" as const,
  title: "Test idea",
  description: "A test idea long enough to slice for the task request.",
  concept: {},
  lens: null,
  isMock: false,
  councilEvaluations: [],
};

const baseOpportunity = {
  id: "opp-1",
  title: "Test opportunity",
  timeWindowEnd: null,
  valueScore: 1,
  goalIds: ["goal-1"],
  urgencyScore: 1,
  evidenceStrength: 1,
  confidenceScore: 1,
  riskScore: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
  findByIdInProject.mockResolvedValue(baseIdea);
  findMostRecentForSubject.mockResolvedValue(null);
  getOrCreate.mockResolvedValue({
    taskCooldownHours: 24,
    scoringWeights: null,
    unlimitedMode: false,
    maxConcurrentSystemTasks: 15,
  });
  findOpportunityByIdInProject.mockResolvedValue(baseOpportunity);
  findRecentByFingerprint.mockResolvedValue(null);
  countActiveSystemTasks.mockResolvedValue(0);
  checkAndIncrement.mockResolvedValue(undefined);
  decisionCreate.mockResolvedValue({ id: "decision-1" });
});

describe("AgencyDirector.decideOnIdea", () => {
  it("does not strand the Idea in PLANNING when the autonomy cap is reached (audit test E)", async () => {
    checkAndIncrement.mockRejectedValue(
      new Error("BUDGET_EXCEEDED: tasksCreated cap reached for project"),
    );

    const decision = await AgencyDirector.decideOnIdea("idea-1", "proj-1");

    expect(decision).toEqual({ id: "decision-1" });
    // The cap check failed before any task/plan was created, so the risky
    // work downstream of it must never have run...
    expect(planForCapability).not.toHaveBeenCalled();
    // ...and the Idea must never have been moved off SHORTLISTED: no call
    // to transition() named PLANNING (or APPROVED/ACTIVE) at all.
    expect(ideaTransition).not.toHaveBeenCalledWith(
      "idea-1",
      "proj-1",
      "PLANNING",
    );
    expect(ideaTransition).not.toHaveBeenCalledWith(
      "idea-1",
      "proj-1",
      "APPROVED",
    );
    expect(ideaTransition).not.toHaveBeenCalledWith(
      "idea-1",
      "proj-1",
      "ACTIVE",
      expect.anything(),
    );
    for (const call of ideaTransition.mock.calls) {
      expect(call[2]).not.toBe("PLANNING");
    }
  });
});

describe("AgencyDirector.decideOnIdea (concurrency backpressure, Phase 7)", () => {
  it("leaves the Idea SHORTLISTED and creates no task when the project is at its concurrent-system-task cap", async () => {
    countActiveSystemTasks.mockResolvedValue(15);

    const decision = await AgencyDirector.decideOnIdea("idea-1", "proj-1");

    expect(decision).toEqual({ id: "decision-1" });
    expect(checkAndIncrement).not.toHaveBeenCalled();
    expect(planForCapability).not.toHaveBeenCalled();
    for (const call of ideaTransition.mock.calls) {
      expect(call[2]).not.toBe("PLANNING");
    }
  });

  it("skips the concurrency check entirely in unlimitedMode", async () => {
    getOrCreate.mockResolvedValue({
      taskCooldownHours: 24,
      scoringWeights: null,
      unlimitedMode: true,
      maxConcurrentSystemTasks: 15,
    });
    countActiveSystemTasks.mockResolvedValue(999);
    planForCapability.mockResolvedValue({ task: { id: "task-1" } });

    await AgencyDirector.decideOnIdea("idea-1", "proj-1");

    expect(countActiveSystemTasks).not.toHaveBeenCalled();
    expect(planForCapability).toHaveBeenCalled();
  });
});

describe("AgencyDirector.decideShortlisted (paused-project guard, audit scenario L)", () => {
  it("skips the batch dispatch into decideOnIdea for a PAUSED project's idea but still dispatches an ACTIVE project's idea", async () => {
    const pausedIdea = {
      ...baseIdea,
      id: "idea-paused",
      projectId: "proj-paused",
      councilEvaluations: [{ id: "ce-1" }],
    };
    const activeIdea = {
      ...baseIdea,
      id: "idea-active",
      projectId: "proj-active",
      councilEvaluations: [{ id: "ce-2" }],
    };
    listByStatusPerProject.mockResolvedValue([[pausedIdea], [activeIdea]]);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );
    const decideOnIdea = vi
      .spyOn(AgencyDirector, "decideOnIdea")
      .mockResolvedValue({ id: "decision-x" } as never);

    const decided = await AgencyDirector.decideShortlisted(5);

    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
    expect(decideOnIdea).not.toHaveBeenCalledWith("idea-paused", "proj-paused");
    expect(decideOnIdea).toHaveBeenCalledWith("idea-active", "proj-active");
    expect(decided).toBe(1);

    decideOnIdea.mockRestore();
  });
});
