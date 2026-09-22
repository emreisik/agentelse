import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): IntelligenceEngine must not score
// signals or synthesize insights for a PAUSED project — same silent-skip
// contract every other autonomous engine's batch loop now follows (see
// agency-director.ts, work-handoff-engine.ts, measurement-engine.ts,
// learning-engine.ts).

const signal = { findMany: vi.fn(), groupBy: vi.fn() };
const finding = { findMany: vi.fn(), groupBy: vi.fn() };
const insight = { findFirst: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { signal, finding, insight },
}));

const getBrandContext = vi.fn().mockResolvedValue({});
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext },
}));

vi.mock("@/server/reasoning/prompts/signal-relevance", () => ({
  signalRelevanceDef: {},
}));
vi.mock("@/server/reasoning/prompts/insight-synthesis", () => ({
  insightSynthesisDef: {},
}));

const run = vi.fn();
const isMockMode = vi.fn().mockReturnValue(false);
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run, isMockMode },
}));

const listByStatus = vi.fn();
const signalTransition = vi.fn().mockResolvedValue(undefined);
const listForProject = vi.fn().mockResolvedValue([]);
vi.mock("@/server/repositories/signal.repository", () => ({
  SignalRepository: {
    listByStatus,
    transition: signalTransition,
    listForProject,
  },
}));

vi.mock("@/server/repositories/finding.repository", () => ({
  FindingRepository: { listForProject: vi.fn().mockResolvedValue([]) },
}));

const writeMany = vi.fn().mockResolvedValue(undefined);
vi.mock("./finding-writer", () => ({
  FindingWriter: { writeMany },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const { IntelligenceEngine } =
  await import("@/server/agency/intelligence/intelligence-engine");

function signalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sig-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    title: "Some signal",
    summary: "Summary",
    category: "TREND",
    source: "web",
    reliability: 0.7,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
  getBrandContext.mockResolvedValue({});
  finding.groupBy.mockResolvedValue([]);
  run.mockResolvedValue({
    output: { relevanceScore: 80, shouldPromote: false },
    isMock: false,
  });
});

describe("IntelligenceEngine.processNewSignals (paused-project guard, audit scenario L)", () => {
  it("skips a PAUSED project's signal but still scores an ACTIVE project's signal", async () => {
    const pausedSignal = signalRow({
      id: "sig-paused",
      projectId: "proj-paused",
    });
    const activeSignal = signalRow({
      id: "sig-active",
      projectId: "proj-active",
    });
    listByStatus.mockResolvedValue([pausedSignal, activeSignal]);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );

    const processed = await IntelligenceEngine.processNewSignals(20);

    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
    expect(processed).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(signalTransition).toHaveBeenCalledWith(
      "sig-active",
      "proj-active",
      "SCORED",
      expect.anything(),
    );
    expect(signalTransition).not.toHaveBeenCalledWith(
      "sig-paused",
      "proj-paused",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("IntelligenceEngine.projectsNeedingInsights (paused-project guard, audit scenario L)", () => {
  it("excludes a PAUSED project from the returned candidate list", async () => {
    signal.groupBy.mockResolvedValue([
      {
        workspaceId: "ws-1",
        projectId: "proj-paused",
        brandId: "b-1",
        _count: { id: 3 },
      },
      {
        workspaceId: "ws-1",
        projectId: "proj-active",
        brandId: "b-1",
        _count: { id: 2 },
      },
    ]);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );

    const candidates = await IntelligenceEngine.projectsNeedingInsights(5);

    expect(candidates.map((c) => c.projectId)).toEqual(["proj-active"]);
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
  });
});
