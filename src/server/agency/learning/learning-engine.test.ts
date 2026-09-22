import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): LearningEngine must not extract
// BrandLearning entries for a PAUSED project's completed measurement plan —
// same silent-skip contract every other autonomous engine's batch loop now
// follows (see agency-director.ts, work-handoff-engine.ts,
// measurement-engine.ts).

const measurementPlan = { findMany: vi.fn() };
const brandLearning = { findFirst: vi.fn(), create: vi.fn() };
const task = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { measurementPlan, brandLearning, task },
}));

vi.mock("@/server/reasoning/prompts/learning-extraction", () => ({
  learningExtractionDef: {},
}));

const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);

vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const { LearningEngine } =
  await import("@/server/agency/learning/learning-engine");

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    brandId: "b-1",
    taskId: null,
    description: "Measurement plan",
    status: "COMPLETED",
    checks: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
  brandLearning.findFirst.mockResolvedValue(null);
  task.findUnique.mockResolvedValue(null);
  run.mockResolvedValue({ output: { learnings: [] }, isMock: false });
});

describe("LearningEngine.processCompletedMeasurements (paused-project guard, audit scenario L)", () => {
  it("skips a PAUSED project's completed plan but still extracts learnings for an ACTIVE project", async () => {
    const pausedPlan = plan({ id: "plan-paused", projectId: "proj-paused" });
    const activePlan = plan({ id: "plan-active", projectId: "proj-active" });
    measurementPlan.findMany.mockResolvedValue([pausedPlan, activePlan]);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );
    run.mockResolvedValue({
      output: { learnings: [{ insight: "Do X", confidence: 0.8 }] },
      isMock: false,
    });

    const extracted = await LearningEngine.processCompletedMeasurements(10);

    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
    expect(extracted).toBe(1);
    expect(brandLearning.findFirst).toHaveBeenCalledTimes(1);
    expect(brandLearning.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceRef: "plan-active" }),
      }),
    );
    expect(brandLearning.create).toHaveBeenCalledTimes(1);
    expect(brandLearning.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: "proj-active" }),
      }),
    );
  });
});
