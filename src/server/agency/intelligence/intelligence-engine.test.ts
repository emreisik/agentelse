import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): IntelligenceEngine must not score
// signals or synthesize insights for a PAUSED project — same silent-skip
// contract every other autonomous engine's batch loop now follows (see
// agency-director.ts, work-handoff-engine.ts, measurement-engine.ts,
// learning-engine.ts).

const signal = { findMany: vi.fn(), groupBy: vi.fn() };
const finding = { findMany: vi.fn(), groupBy: vi.fn() };
const insight = { findFirst: vi.fn() };
const reasoningCall = { findMany: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { signal, finding, insight, reasoningCall },
}));

const getBrandContext = vi.fn().mockResolvedValue({});
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext },
}));

vi.mock("@/server/reasoning/prompts/signal-relevance", () => ({
  signalRelevanceDef: {},
}));
vi.mock("@/server/reasoning/prompts/insight-synthesis", () => ({
  insightSynthesisDef: { purpose: "insight.synthesize" },
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

const { IntelligenceEngine, needsInsightSynthesis } =
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
  reasoningCall.findMany.mockResolvedValue([]);
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
        _max: { updatedAt: new Date("2026-10-01T10:00:00Z") },
      },
      {
        workspaceId: "ws-1",
        projectId: "proj-active",
        brandId: "b-1",
        _max: { updatedAt: new Date("2026-10-01T10:00:00Z") },
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

// What this suite proves: a project is synthesized again only when new
// material arrived after its last attempt (PROMOTED signals stay in the pool
// forever, so without this the same signals cost one LLM call every tick); a
// failed attempt is retried after an hour; the longest-waiting projects go
// first.
describe("IntelligenceEngine.projectsNeedingInsights (no re-run on the same material)", () => {
  const NOW = new Date("2026-10-04T12:00:00Z");
  const group = (projectId: string, at: string) => ({
    workspaceId: "ws-1",
    projectId,
    brandId: "b-1",
    _max: { updatedAt: new Date(at) },
  });

  it("skips a project whose signals are older than its last synthesis", async () => {
    signal.groupBy.mockResolvedValue([
      group("p-old", "2026-10-04T08:00:00Z"),
      group("p-new", "2026-10-04T11:00:00Z"),
    ]);
    reasoningCall.findMany.mockResolvedValue([
      { projectId: "p-old", createdAt: new Date("2026-10-04T09:00:00Z"), status: "OK" },
      { projectId: "p-new", createdAt: new Date("2026-10-04T09:00:00Z"), status: "OK" },
    ]);

    const candidates = await IntelligenceEngine.projectsNeedingInsights(5, NOW);

    expect(candidates.map((c) => c.projectId)).toEqual(["p-new"]);
    expect(reasoningCall.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ purpose: "insight.synthesize" }),
      }),
    );
  });

  it("counts a new finding as new material too", async () => {
    signal.groupBy.mockResolvedValue([]);
    finding.groupBy.mockResolvedValue([
      {
        workspaceId: "ws-1",
        projectId: "p-1",
        brandId: "b-1",
        _max: { createdAt: new Date("2026-10-04T11:30:00Z") },
      },
    ]);
    reasoningCall.findMany.mockResolvedValue([
      { projectId: "p-1", createdAt: new Date("2026-10-04T09:00:00Z"), status: "OK" },
    ]);

    const candidates = await IntelligenceEngine.projectsNeedingInsights(5, NOW);
    expect(candidates.map((c) => c.projectId)).toEqual(["p-1"]);
  });

  it("puts never-synthesized and longest-waiting projects first, up to the limit", async () => {
    signal.groupBy.mockResolvedValue([
      group("p-a", "2026-10-04T11:00:00Z"),
      group("p-b", "2026-10-04T11:00:00Z"),
      group("p-c", "2026-10-04T11:00:00Z"),
    ]);
    reasoningCall.findMany.mockResolvedValue([
      { projectId: "p-a", createdAt: new Date("2026-10-04T10:00:00Z"), status: "OK" },
      { projectId: "p-b", createdAt: new Date("2026-10-03T10:00:00Z"), status: "OK" },
    ]);

    const candidates = await IntelligenceEngine.projectsNeedingInsights(2, NOW);
    expect(candidates.map((c) => c.projectId)).toEqual(["p-c", "p-b"]);
  });
});

describe("needsInsightSynthesis", () => {
  const NOW = new Date("2026-10-04T12:00:00Z");
  const at = (iso: string) => new Date(iso);

  it("runs when nothing was ever tried, or the material is newer", () => {
    expect(needsInsightSynthesis(at("2026-10-04T11:00:00Z"), null, NOW)).toBe(true);
    expect(
      needsInsightSynthesis(
        at("2026-10-04T11:00:00Z"),
        { createdAt: at("2026-10-04T10:00:00Z"), status: "OK" },
        NOW,
      ),
    ).toBe(true);
  });

  it("does not run again on the same material after a good attempt", () => {
    expect(
      needsInsightSynthesis(
        at("2026-10-04T09:00:00Z"),
        { createdAt: at("2026-10-04T10:00:00Z"), status: "OK" },
        NOW,
      ),
    ).toBe(false);
  });

  it("retries a failed attempt only after an hour", () => {
    const material = at("2026-10-04T09:00:00Z");
    expect(
      needsInsightSynthesis(material, { createdAt: at("2026-10-04T11:30:00Z"), status: "ERROR" }, NOW),
    ).toBe(false);
    expect(
      needsInsightSynthesis(material, { createdAt: at("2026-10-04T10:30:00Z"), status: "ERROR" }, NOW),
    ).toBe(true);
  });
});
