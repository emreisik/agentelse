import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): CouncilEngine must not dispatch a
// PAUSED project's idea into evaluateIdea — same silent-skip contract every
// other autonomous engine's batch loop now follows (see agency-director.ts,
// opportunity-engine.ts, idea-foundry.ts).

const listByStatusPerProject = vi.fn();
const findByIdInProject = vi.fn();
const addCouncilEvaluation = vi.fn().mockResolvedValue(undefined);
const ideaTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {
    listByStatusPerProject,
    findByIdInProject,
    addCouncilEvaluation,
    transition: ideaTransition,
  },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const competitorInsightFindMany = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/prisma", () => ({
  prisma: { competitorInsight: { findMany: competitorInsightFindMany } },
}));

const getBrandContext = vi.fn().mockResolvedValue({});
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext },
}));

const reasoningRun = vi.fn().mockResolvedValue({
  output: {
    scores: {},
    overallScore: 5,
    recommendation: "APPROVE",
    rationale: "",
  },
  isMock: false,
  reasoningCallId: "call-1",
});
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: reasoningRun },
}));

const postSystemMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { postSystemMessage },
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
    listByStatusPerProject.mockResolvedValue([[pausedIdea], [activeIdea]]);
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

// { postToChat: false } (agency-wiring.ts's INITIAL_IDEA_PORTFOLIO, this
// function's sole caller today) must still record the council evaluation
// and the idea's status transition but skip the chat message — the default
// (postToChat unset) keeps posting to chat exactly as before.
describe("CouncilEngine.evaluateIdea (postToChat option)", () => {
  function setUpEvaluation() {
    findByIdInProject.mockResolvedValue({
      id: "idea-1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      lens: "BRAND",
      title: "An idea",
      description: "desc",
      concept: {},
    });
  }

  it("posts the council verdict to chat by default (no opts)", async () => {
    setUpEvaluation();

    const result = await CouncilEngine.evaluateIdea("idea-1", "proj-1");

    expect(result.recommendation).toBe("APPROVE");
    expect(addCouncilEvaluation).toHaveBeenCalled();
    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ideaId: "idea-1" }),
    );
  });

  it("still records the evaluation but skips the chat message when postToChat is false", async () => {
    setUpEvaluation();

    const result = await CouncilEngine.evaluateIdea("idea-1", "proj-1", {
      postToChat: false,
    });

    expect(result.recommendation).toBe("APPROVE");
    expect(addCouncilEvaluation).toHaveBeenCalled();
    expect(postSystemMessage).not.toHaveBeenCalled();
  });
});
