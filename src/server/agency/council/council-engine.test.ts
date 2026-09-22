import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): CouncilEngine must not dispatch a
// PAUSED project's idea into evaluateIdea — same silent-skip contract every
// other autonomous engine's batch loop now follows (see agency-director.ts,
// opportunity-engine.ts, idea-foundry.ts).

const listByStatus = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: { listByStatus },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const { CouncilEngine } =
  await import("@/server/agency/council/council-engine");

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
});

describe("CouncilEngine.evaluatePendingIdeas (paused-project guard, audit scenario L)", () => {
  it("skips the batch dispatch into evaluateIdea for a PAUSED project's idea but still dispatches an ACTIVE project's idea", async () => {
    const pausedIdea = {
      id: "idea-paused",
      projectId: "proj-paused",
      title: "Paused idea",
      councilEvaluations: [],
    };
    const activeIdea = {
      id: "idea-active",
      projectId: "proj-active",
      title: "Active idea",
      councilEvaluations: [],
    };
    listByStatus.mockResolvedValue([pausedIdea, activeIdea]);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );
    const evaluateIdea = vi
      .spyOn(CouncilEngine, "evaluateIdea")
      .mockResolvedValue({ recommendation: "PURSUE" } as never);

    const evaluated = await CouncilEngine.evaluatePendingIdeas(5);

    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
    expect(evaluateIdea).not.toHaveBeenCalledWith("idea-paused", "proj-paused");
    expect(evaluateIdea).toHaveBeenCalledWith("idea-active", "proj-active");
    expect(evaluated).toBe(1);

    evaluateIdea.mockRestore();
  });
});
