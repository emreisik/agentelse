import { beforeEach, describe, expect, it, vi } from "vitest";

// The setup state machine, driven stage by stage against an in-memory state
// store (the REAL transition rules, faked persistence) with every engine it
// calls mocked, so what is asserted is the orchestration: which stages run,
// which are skipped in an enrichment, and what happens when deep discovery
// produces nothing. (The DB-backed walk of a full setup is in
// project-setup.integration.test.ts.)

type StageRecord = {
  stage: string;
  status: string;
  attemptCount: number;
  error: string | null;
};
type FakeState = {
  id: string;
  workspaceId: string;
  projectId: string;
  brandId: string;
  intake: Record<string, unknown>;
  currentStage: string;
  activatedAt: Date | null;
  stageRecords: StageRecord[];
};
const store = vi.hoisted(() => ({
  state: null as unknown as FakeState | null,
}));

const taskFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: taskFindMany },
    project: {
      findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE" }),
      update: vi.fn(),
    },
    brand: { update: vi.fn() },
  },
}));

// Real transition rules, fake persistence.
const { StateMachine } = await import("@/server/state-machine/transitions");
vi.mock(
  "@/server/repositories/setup-state.repository",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/repositories/setup-state.repository")
      >();
    const record = (stage: string) =>
      store.state!.stageRecords.find((r) => r.stage === stage)!;
    return {
      ...actual,
      SetupStateRepository: {
        findByProject: async () => store.state,
        listUnfinished: async () =>
          store.state?.activatedAt ? [] : [store.state],
        setCurrentStage: async (_projectId: string, stage: string) => {
          store.state!.currentStage = stage;
        },
        markActivated: async () => {
          store.state!.activatedAt = new Date();
        },
        transitionStage: async (
          _projectId: string,
          stage: string,
          to: string,
          extra?: { error?: string },
        ) => {
          const rec = record(stage);
          StateMachine.assertSetupStageTransition(
            rec.status as never,
            to as never,
          );
          rec.status = to;
          if (to === "RUNNING") rec.attemptCount += 1;
          if (extra?.error) rec.error = extra.error;
        },
      },
    };
  },
);

const planForCapability = vi.fn().mockResolvedValue({ task: { id: "t" } });
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability },
}));

const synthesize = vi.fn().mockResolvedValue({});
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { synthesize },
}));
const strategySynthesize = vi.fn().mockResolvedValue({});
vi.mock("@/server/agency/strategy/strategy-service", () => ({
  StrategyEngine: { synthesize: strategySynthesize },
}));
const generateProfiles = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/agency/signals/signal-profile.service", () => ({
  SignalProfileService: { generateForProject: generateProfiles },
}));
const generateAudits = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/agency/audits/baseline-audit.service", () => ({
  BaselineAuditService: { generateAll: generateAudits },
}));
const generateGoals = vi.fn().mockResolvedValue(undefined);
const approveAllGoals = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/agency/goals/goal-engine", () => ({
  GoalEngine: {
    generateForProject: generateGoals,
    approveAll: approveAllGoals,
  },
}));
const recommendModes = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/agency/departments/department-router", () => ({
  DepartmentRouter: { recommendModes },
}));

vi.mock("@/server/agency/setup/demo-post-generator", () => ({
  DEMO_POST_STAGES: [],
  generateDemoPost: vi.fn(),
}));
vi.mock("@/server/projects/browser-profiles", () => ({
  ensureStandardBrowserProfiles: vi.fn(),
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
const getForProject = vi.fn();
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    getOrCreate: vi.fn().mockResolvedValue({ maxConcurrentResearchTasks: 2 }),
    getForProject,
  },
}));
vi.mock("@/server/repositories/project.repository", () => ({
  ProjectRepository: { transition: vi.fn() },
}));
vi.mock("@/server/repositories/signal-profile.repository", () => ({
  SignalProfileRepository: {
    listForProject: vi.fn().mockResolvedValue([]),
    setNextScan: vi.fn(),
  },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { appendSetupDemoPost: vi.fn() },
}));

const {
  ProjectSetupOrchestrator,
  registerSetupStageRunner,
  MAX_STAGE_ATTEMPTS,
} = await import("./project-setup-orchestrator");
const { SETUP_STAGE_ORDER } =
  await import("@/server/repositories/setup-state.repository");
const { DISCOVERY_FAILED_MESSAGE } = await import("./setup-stages");

// The three late stages are wired in agency-wiring.ts in production; spies here.
const lateRunners = {
  INITIAL_OPPORTUNITIES: vi.fn().mockResolvedValue(undefined),
  INITIAL_IDEA_PORTFOLIO: vi.fn().mockResolvedValue(undefined),
  INITIAL_WORK_PLAN: vi.fn().mockResolvedValue(undefined),
} as const;
registerSetupStageRunner(
  "INITIAL_OPPORTUNITIES",
  lateRunners.INITIAL_OPPORTUNITIES,
);
registerSetupStageRunner(
  "INITIAL_IDEA_PORTFOLIO",
  lateRunners.INITIAL_IDEA_PORTFOLIO,
);
registerSetupStageRunner("INITIAL_WORK_PLAN", lateRunners.INITIAL_WORK_PLAN);

function newState(intake: Record<string, unknown>): FakeState {
  return {
    id: "state-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    intake: { brandName: "Acme", domain: "acme.com.tr", ...intake },
    currentStage: "DEEP_DISCOVERY",
    activatedAt: null,
    stageRecords: SETUP_STAGE_ORDER.map((stage) => ({
      stage,
      // start() runs INTAKE inline before handing over to the worker.
      status: stage === "INTAKE" ? "COMPLETED" : "PENDING",
      attemptCount: 0,
      error: null,
    })),
  };
}

const statusOf = (stage: string) =>
  store.state!.stageRecords.find((r) => r.stage === stage)!.status;
const statuses = () =>
  Object.fromEntries(store.state!.stageRecords.map((r) => [r.stage, r.status]));

const completedTasks = (n = 6) =>
  Array.from({ length: n }, () => ({
    status: "COMPLETED",
    createdAt: new Date(),
  }));

// Calls advance() until it stops making progress (the worker does the same,
// bounded per tick), returning how many steps it took.
async function advanceUntilIdle(limit = 80) {
  let steps = 0;
  for (; steps < limit; steps += 1) {
    const result = await ProjectSetupOrchestrator.advance("proj-1");
    if (!result.advanced) break;
  }
  return steps;
}

beforeEach(() => {
  vi.clearAllMocks();
  taskFindMany.mockResolvedValue(completedTasks());
  getForProject.mockResolvedValue({ setupAutoApprove: false });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("an ENRICHMENT setup", () => {
  beforeEach(() => {
    store.state = newState({ mode: "ENRICHMENT" });
  });

  it("does the research, the constitution, the signal profile and the goals, then parks for the client's approval of the goals", async () => {
    await advanceUntilIdle();

    expect(statuses()).toMatchObject({
      INTAKE: "COMPLETED",
      DEEP_DISCOVERY: "COMPLETED",
      BRAND_CONSTITUTION: "COMPLETED",
      SIGNAL_PROFILE: "COMPLETED",
      BASELINE_AUDITS: "SKIPPED",
      GOAL_GENERATION: "WAITING_CLIENT",
      AGENCY_CONFIGURATION: "PENDING",
    });
    expect(planForCapability).toHaveBeenCalledTimes(6);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(generateProfiles).toHaveBeenCalledTimes(1);
    expect(generateGoals).toHaveBeenCalledTimes(1);
    expect(store.state!.activatedAt).toBeNull();
  });

  it("never runs the engines behind the stages it skips, and finishes once the goals are decided", async () => {
    await advanceUntilIdle();
    await ProjectSetupOrchestrator.submitClientDecision(
      "proj-1",
      "GOAL_GENERATION",
      { approve: true, approvedByUserId: "user-1" },
    );
    await advanceUntilIdle();

    expect(statuses()).toMatchObject({
      GOAL_GENERATION: "COMPLETED",
      AGENCY_CONFIGURATION: "SKIPPED",
      AUTONOMY_CONFIGURATION: "SKIPPED",
      INITIAL_OPPORTUNITIES: "SKIPPED",
      INITIAL_IDEA_PORTFOLIO: "SKIPPED",
      INITIAL_WORK_PLAN: "SKIPPED",
      PROJECT_ACTIVATION: "COMPLETED",
    });
    expect(store.state!.activatedAt).toBeInstanceOf(Date);

    expect(generateAudits).not.toHaveBeenCalled();
    expect(recommendModes).not.toHaveBeenCalled();
    for (const runner of Object.values(lateRunners)) {
      expect(runner).not.toHaveBeenCalled();
    }
    expect(approveAllGoals).toHaveBeenCalledWith("proj-1", "USER", "user-1");
  });

  it("approves the goals itself only when the client asked for that", async () => {
    getForProject.mockResolvedValue({ setupAutoApprove: true });

    await advanceUntilIdle();

    expect(approveAllGoals).toHaveBeenCalledWith("proj-1", "SYSTEM");
    expect(statuses()).toMatchObject({
      GOAL_GENERATION: "COMPLETED",
      PROJECT_ACTIVATION: "COMPLETED",
    });
    expect(store.state!.activatedAt).toBeInstanceOf(Date);
  });

  it("moves the pointer past a skipped stage on the next step", async () => {
    store.state!.currentStage = "BASELINE_AUDITS";
    for (const stage of [
      "DEEP_DISCOVERY",
      "BRAND_CONSTITUTION",
      "SIGNAL_PROFILE",
    ]) {
      store.state!.stageRecords.find((r) => r.stage === stage)!.status =
        "COMPLETED";
    }

    const skipped = await ProjectSetupOrchestrator.advance("proj-1");
    const moved = await ProjectSetupOrchestrator.advance("proj-1");

    expect(skipped).toEqual({
      stage: "BASELINE_AUDITS",
      status: "SKIPPED",
      advanced: true,
    });
    expect(moved).toEqual({
      stage: "GOAL_GENERATION",
      status: "PENDING",
      advanced: true,
    });
  });
});

describe("a FULL setup (the default, and what every earlier setup is)", () => {
  it("runs every stage, skipping none", async () => {
    store.state = newState({});
    getForProject.mockResolvedValue({ setupAutoApprove: true });

    await advanceUntilIdle();

    for (const stage of SETUP_STAGE_ORDER) {
      expect(statusOf(stage), stage).toBe("COMPLETED");
    }
    expect(generateAudits).toHaveBeenCalledTimes(1);
    expect(recommendModes).toHaveBeenCalledTimes(1);
    for (const runner of Object.values(lateRunners)) {
      expect(runner).toHaveBeenCalledTimes(1);
    }
    expect(store.state!.activatedAt).toBeInstanceOf(Date);
  });

  it("treats a stored intake that has no mode as FULL", async () => {
    store.state = newState({ mode: undefined });
    getForProject.mockResolvedValue({ setupAutoApprove: true });

    await advanceUntilIdle();

    expect(generateAudits).toHaveBeenCalledTimes(1);
  });
});

describe("deep discovery that produces nothing", () => {
  beforeEach(() => {
    store.state = newState({ mode: "ENRICHMENT" });
  });

  it("FAILS with a clear message instead of staying RUNNING forever", async () => {
    await ProjectSetupOrchestrator.advance("proj-1"); // starts the research
    expect(statusOf("DEEP_DISCOVERY")).toBe("RUNNING");

    taskFindMany.mockResolvedValue(
      Array.from({ length: 6 }, () => ({
        status: "FAILED",
        createdAt: new Date(),
      })),
    );
    const result = await ProjectSetupOrchestrator.advance("proj-1");

    expect(result).toEqual({
      stage: "DEEP_DISCOVERY",
      status: "FAILED",
      advanced: true,
    });
    const record = store.state!.stageRecords.find(
      (r) => r.stage === "DEEP_DISCOVERY",
    )!;
    expect(record.status).toBe("FAILED");
    expect(record.error).toBe(DISCOVERY_FAILED_MESSAGE);
    // The constitution was not built from nothing.
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("retries on its own a bounded number of times, then stops and waits for a manual retry", async () => {
    taskFindMany.mockResolvedValue(
      Array.from({ length: 6 }, () => ({
        status: "FAILED",
        createdAt: new Date(),
      })),
    );

    await advanceUntilIdle();

    const record = store.state!.stageRecords.find(
      (r) => r.stage === "DEEP_DISCOVERY",
    )!;
    expect(record.status).toBe("FAILED");
    expect(record.attemptCount).toBe(MAX_STAGE_ATTEMPTS);
    // Every attempt planned a fresh wave of research, and no more than that.
    expect(planForCapability).toHaveBeenCalledTimes(6 * MAX_STAGE_ATTEMPTS);

    // Idle from here on: no silent re-burning of research budget every tick.
    const before = planForCapability.mock.calls.length;
    await expect(ProjectSetupOrchestrator.advance("proj-1")).resolves.toEqual({
      stage: "DEEP_DISCOVERY",
      status: "FAILED",
      advanced: false,
    });
    expect(planForCapability.mock.calls.length).toBe(before);
  });

  it("lets the client retry by hand after the automatic retries ran out", async () => {
    taskFindMany.mockResolvedValue(
      Array.from({ length: 6 }, () => ({
        status: "FAILED",
        createdAt: new Date(),
      })),
    );
    await advanceUntilIdle();
    const before = planForCapability.mock.calls.length;

    await ProjectSetupOrchestrator.retryStageNow("proj-1");

    expect(statusOf("DEEP_DISCOVERY")).toBe("RUNNING");
    expect(planForCapability.mock.calls.length).toBe(before + 6);
  });

  it("goes on with partial results when some research completed and the rest hung past the limit", async () => {
    await ProjectSetupOrchestrator.advance("proj-1");
    const longAgo = new Date(Date.now() - 45 * 60_000);
    taskFindMany.mockResolvedValue([
      ...Array.from({ length: 3 }, () => ({
        status: "COMPLETED",
        createdAt: longAgo,
      })),
      ...Array.from({ length: 3 }, () => ({
        status: "RUNNING",
        createdAt: longAgo,
      })),
    ]);

    await advanceUntilIdle();

    expect(statusOf("DEEP_DISCOVERY")).toBe("COMPLETED");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting while research is genuinely still running", async () => {
    await ProjectSetupOrchestrator.advance("proj-1");
    taskFindMany.mockResolvedValue(
      Array.from({ length: 6 }, () => ({
        status: "RUNNING",
        createdAt: new Date(),
      })),
    );

    const result = await ProjectSetupOrchestrator.advance("proj-1");

    expect(result).toEqual({
      stage: "DEEP_DISCOVERY",
      status: "RUNNING",
      advanced: false,
    });
    expect(statusOf("DEEP_DISCOVERY")).toBe("RUNNING");
  });
});
