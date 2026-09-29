import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Kept apart from continuous-agency-engine.test.ts on purpose: handler and
// step registration is module-level state that never resets, so a fresh test
// file (a fresh module instance) is what keeps these registrations from
// leaking into, or being polluted by, the other suite.

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

const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  AgencyLoopStateRepository: {
    getOrCreate: vi.fn().mockResolvedValue({}),
    recordProgress: vi.fn().mockResolvedValue(undefined),
    recordNoProgress: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/server/repositories/agency-cycle.repository", () => ({
  AgencyCycleRepository: {
    start: vi.fn().mockResolvedValue({ id: "cycle-1" }),
    complete: vi.fn().mockResolvedValue(undefined),
  },
}));

const {
  ContinuousAgencyEngine,
  registerAgencyTickStep,
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

// Registered once (module state never resets) and re-armed per test.
const failingLegacy = vi.fn();
const publishCompletion = vi.fn();
const drainer = vi.fn();
const generator = vi.fn();
const terminalFailing = vi.fn();
const terminalReal = vi.fn();
registerTaskCompletedHandler(failingLegacy, "work-plan-progression");
registerTaskCompletedHandler(publishCompletion, "creative-publish-completion");
registerTaskCompletedHandler(drainer, "handoff-close-out");
registerTaskCompletedHandler(generator, "measurement-planning");
registerTaskTerminalHandler(terminalFailing, "work-plan-terminal");
registerTaskTerminalHandler(terminalReal, "some-real-terminal-handler");

const stepRuns: string[] = [];
for (const name of [
  "signal-scans",
  "council-evaluation",
  "director-decisions",
  "handoff-progression",
  "learning",
  "signal-processing",
  "insight-synthesis",
  "opportunity-evaluation",
  "telegram-approval-polling",
]) {
  registerAgencyTickStep({
    name,
    run: async () => {
      stepRuns.push(name);
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stepRuns.length = 0;
  materializeTask.mockResolvedValue(undefined);
  failingLegacy.mockResolvedValue(undefined);
  publishCompletion.mockResolvedValue(undefined);
  drainer.mockResolvedValue(undefined);
  generator.mockResolvedValue(undefined);
  terminalFailing.mockResolvedValue(undefined);
  terminalReal.mockResolvedValue(undefined);
  claimPending.mockResolvedValue([]);
  delete process.env.LEGACY_AGENCY_LOOP;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("processTriggers handler isolation", () => {
  it("still runs later handlers when an earlier legacy handler throws", async () => {
    claimPending.mockResolvedValue([trigger()]);
    failingLegacy.mockRejectedValue(new Error("work plan exploded"));

    await ContinuousAgencyEngine.processTriggers();

    // The real product handler registered AFTER the throwing one must run:
    // this is the publish -> PUBLISHED flip that used to be skipped.
    expect(publishCompletion).toHaveBeenCalledWith("task-1", {
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
    });
    expect(drainer).toHaveBeenCalled();
  });

  it("still marks the trigger FAILED with the handler's message and audits the failure", async () => {
    claimPending.mockResolvedValue([trigger()]);
    failingLegacy.mockRejectedValue(new Error("work plan exploded"));

    await ContinuousAgencyEngine.processTriggers();

    expect(markProcessed).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith("trig-1", "work plan exploded");
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "p-1",
        action: "agency.trigger.handler_failed.work-plan-progression",
        entityType: "AgencyTrigger",
        entityId: "trig-1",
        metadata: expect.objectContaining({ taskId: "task-1" }),
      }),
    );
  });

  it("joins the messages when more than one unit fails", async () => {
    claimPending.mockResolvedValue([trigger()]);
    materializeTask.mockRejectedValue(new Error("extraction failed"));
    failingLegacy.mockRejectedValue(new Error("work plan exploded"));

    await ContinuousAgencyEngine.processTriggers();

    expect(markFailed).toHaveBeenCalledWith(
      "trig-1",
      "extraction failed; work plan exploded",
    );
    // A failing materializer no longer starves the handlers either.
    expect(publishCompletion).toHaveBeenCalled();
  });

  it("isolates terminal handlers the same way", async () => {
    claimPending.mockResolvedValue([
      trigger({
        type: "TASK_FAILED",
        payload: { taskId: "task-9", terminalStatus: "FAILED" },
      }),
    ]);
    terminalFailing.mockRejectedValue(new Error("terminal boom"));

    await ContinuousAgencyEngine.processTriggers();

    expect(terminalReal).toHaveBeenCalledWith("task-9", "FAILED", {
      workspaceId: "ws-1",
      projectId: "p-1",
      brandId: "b-1",
    });
    expect(markFailed).toHaveBeenCalledWith("trig-1", "terminal boom");
  });

  it("does not fail the trigger when the audit write itself fails", async () => {
    claimPending.mockResolvedValue([trigger()]);
    failingLegacy.mockRejectedValue(new Error("work plan exploded"));
    auditRecord.mockRejectedValue(new Error("audit down"));

    await ContinuousAgencyEngine.processTriggers();

    expect(publishCompletion).toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith("trig-1", "work plan exploded");
  });
});

describe("LEGACY_AGENCY_LOOP gating", () => {
  it("runs every handler in on mode (the default)", async () => {
    claimPending.mockResolvedValue([trigger()]);

    await ContinuousAgencyEngine.processTriggers();

    expect(failingLegacy).toHaveBeenCalled();
    expect(drainer).toHaveBeenCalled();
    expect(generator).toHaveBeenCalled();
    expect(publishCompletion).toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith("trig-1");
  });

  it("skips generator handlers but keeps drainers in drain mode", async () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "drain");
    claimPending.mockResolvedValue([trigger()]);

    await ContinuousAgencyEngine.processTriggers();

    expect(generator).not.toHaveBeenCalled();
    expect(failingLegacy).toHaveBeenCalled();
    expect(drainer).toHaveBeenCalled();
    expect(publishCompletion).toHaveBeenCalled();
  });

  it("skips generator and drainer handlers in off mode, never the product ones", async () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "off");
    claimPending.mockResolvedValue([trigger()]);

    await ContinuousAgencyEngine.processTriggers();

    expect(generator).not.toHaveBeenCalled();
    expect(failingLegacy).not.toHaveBeenCalled();
    expect(drainer).not.toHaveBeenCalled();
    expect(publishCompletion).toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalledWith("trig-1");
  });

  it("gates terminal handlers by name too", async () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "off");
    claimPending.mockResolvedValue([
      trigger({
        type: "TASK_CANCELLED",
        payload: { taskId: "task-7", terminalStatus: "CANCELLED" },
      }),
    ]);

    await ContinuousAgencyEngine.processTriggers();

    expect(terminalFailing).not.toHaveBeenCalled();
    expect(terminalReal).toHaveBeenCalled();
  });
});

describe("tick step gating", () => {
  const GENERATORS = [
    "signal-scans",
    "council-evaluation",
    "director-decisions",
  ];
  const DRAINERS = ["handoff-progression", "learning"];
  const KEPT = [
    "signal-processing",
    "insight-synthesis",
    "opportunity-evaluation",
    "telegram-approval-polling",
  ];

  it("runs every registered step in on mode", async () => {
    await ContinuousAgencyEngine.tick();
    expect(stepRuns).toEqual([...GENERATORS, ...DRAINERS, ...KEPT]);
  });

  it("drops the generator steps in drain mode", async () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "drain");
    await ContinuousAgencyEngine.tick();
    expect(stepRuns).toEqual([...DRAINERS, ...KEPT]);
  });

  it("drops generator and drainer steps in off mode, keeping the light intelligence chain", async () => {
    vi.stubEnv("LEGACY_AGENCY_LOOP", "off");
    await ContinuousAgencyEngine.tick();
    expect(stepRuns).toEqual(KEPT);
  });
});
