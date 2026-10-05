import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): IdeaFoundry must not dispatch a
// PAUSED project's opportunity into generateForOpportunity — same
// silent-skip contract every other autonomous engine's batch loop now
// follows (see agency-director.ts, opportunity-engine.ts, council-engine.ts).

const opportunity = { findMany: vi.fn() };
const reasoningCall = { findMany: vi.fn().mockResolvedValue([]) };
vi.mock("@/lib/prisma", () => ({
  prisma: { opportunity, reasoningCall },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const opportunityTransition = vi.fn().mockResolvedValue(undefined);
const opportunityFindByIdInProject = vi.fn();
vi.mock("@/server/repositories/opportunity.repository", () => ({
  OpportunityRepository: {
    transition: opportunityTransition,
    findByIdInProject: opportunityFindByIdInProject,
  },
}));

const getBrandContext = vi.fn().mockResolvedValue({});
vi.mock("@/server/agency/constitution/constitution-service", () => ({
  ConstitutionService: { getBrandContext },
}));

const reasoningRun = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: reasoningRun },
}));

const ideaCountActive = vi.fn().mockResolvedValue(0);
const ideaExistsForOpportunityLens = vi.fn().mockResolvedValue(false);
const ideaCreate = vi.fn();
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {
    countActive: ideaCountActive,
    existsForOpportunityLens: ideaExistsForOpportunityLens,
    create: ideaCreate,
  },
}));

const autonomyGetOrCreate = vi
  .fn()
  .mockResolvedValue({ unlimitedMode: false, maxActiveIdeas: 20 });
const autonomyCheckAndIncrement = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    getOrCreate: autonomyGetOrCreate,
    checkAndIncrement: autonomyCheckAndIncrement,
  },
}));

const postSystemMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { postSystemMessage },
}));

const { IdeaFoundry, dailyIdeaRunBlocks } = await import(
  "@/server/agency/ideas/idea-foundry"
);

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "opp-1",
    projectId: "proj-1",
    title: "An opportunity",
    _count: { ideas: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
  reasoningCall.findMany.mockResolvedValue([]);
});

describe("IdeaFoundry.generateForTopOpportunities (paused-project guard, audit scenario L)", () => {
  it("skips the batch dispatch into generateForOpportunity for a PAUSED project's opportunity but still dispatches an ACTIVE project's opportunity", async () => {
    const pausedOpportunity = candidate({
      id: "opp-paused",
      projectId: "proj-paused",
      title: "Paused opportunity",
    });
    const activeOpportunity = candidate({
      id: "opp-active",
      projectId: "proj-active",
      title: "Active opportunity",
    });
    opportunity.findMany.mockResolvedValue([
      pausedOpportunity,
      activeOpportunity,
    ]);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );
    const generateForOpportunity = vi
      .spyOn(IdeaFoundry, "generateForOpportunity")
      .mockResolvedValue(1);

    const total = await IdeaFoundry.generateForTopOpportunities(3);

    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
    expect(generateForOpportunity).not.toHaveBeenCalledWith(
      "opp-paused",
      "proj-paused",
    );
    expect(generateForOpportunity).toHaveBeenCalledWith(
      "opp-active",
      "proj-active",
    );
    expect(total).toBe(1);

    generateForOpportunity.mockRestore();
  });
});

describe("IdeaFoundry.generateForTopOpportunities (opportunity retry cap, audit scenario K)", () => {
  it("queries for opportunities whose ideas are all ARCHIVED/REJECTED (or have none)", async () => {
    opportunity.findMany.mockResolvedValue([]);

    await IdeaFoundry.generateForTopOpportunities(3);

    expect(opportunity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ideas: { none: { status: { notIn: ["ARCHIVED", "REJECTED"] } } },
        }),
      }),
    );
  });

  it("dismisses an opportunity that has already reached the attempt cap instead of generating another idea", async () => {
    const exhausted = candidate({
      id: "opp-exhausted",
      _count: { ideas: 3 },
    });
    opportunity.findMany.mockResolvedValue([exhausted]);
    const generateForOpportunity = vi
      .spyOn(IdeaFoundry, "generateForOpportunity")
      .mockResolvedValue(1);

    const total = await IdeaFoundry.generateForTopOpportunities(3);

    expect(generateForOpportunity).not.toHaveBeenCalled();
    expect(opportunityTransition).toHaveBeenCalledWith(
      "opp-exhausted",
      "proj-1",
      "DISMISSED",
    );
    expect(total).toBe(0);

    generateForOpportunity.mockRestore();
  });

  it("still generates an idea for an opportunity under the attempt cap", async () => {
    const retrying = candidate({ id: "opp-retry", _count: { ideas: 1 } });
    opportunity.findMany.mockResolvedValue([retrying]);
    const generateForOpportunity = vi
      .spyOn(IdeaFoundry, "generateForOpportunity")
      .mockResolvedValue(1);

    const total = await IdeaFoundry.generateForTopOpportunities(3);

    expect(generateForOpportunity).toHaveBeenCalledWith("opp-retry", "proj-1");
    expect(opportunityTransition).not.toHaveBeenCalled();
    expect(total).toBe(1);

    generateForOpportunity.mockRestore();
  });
});

// { postToChat: false } (agency-wiring.ts's INITIAL_IDEA_PORTFOLIO, the
// one-time onboarding batch) must still create the Idea row but skip the
// chat message — every other caller (default, postToChat unset) keeps
// posting to chat exactly as before.
describe("IdeaFoundry.generateForOpportunity (postToChat option)", () => {
  function setUpOneIdeaGeneration() {
    opportunityFindByIdInProject.mockResolvedValue({
      id: "opp-1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      insightId: null,
      category: "OTHER",
      status: "RAW",
      title: "An opportunity",
      description: "desc",
      createdAt: new Date(),
    });
    reasoningRun.mockResolvedValue({
      output: {
        ideas: [
          {
            lens: "BRAND",
            title: "A new idea",
            description: "Idea description",
            concept: {},
          },
        ],
      },
      isMock: false,
    });
    ideaCreate.mockResolvedValue({ id: "idea-1" });
  }

  it("posts the idea to chat by default (no opts)", async () => {
    setUpOneIdeaGeneration();

    const created = await IdeaFoundry.generateForOpportunity(
      "opp-1",
      "proj-1",
      { lenses: ["BRAND"] },
    );

    expect(created).toBe(1);
    expect(ideaCreate).toHaveBeenCalled();
    expect(postSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ideaId: "idea-1" }),
    );
  });

  it("still creates the idea but skips the chat message when postToChat is false", async () => {
    setUpOneIdeaGeneration();

    const created = await IdeaFoundry.generateForOpportunity(
      "opp-1",
      "proj-1",
      { lenses: ["BRAND"], postToChat: false },
    );

    expect(created).toBe(1);
    expect(ideaCreate).toHaveBeenCalled();
    expect(postSystemMessage).not.toHaveBeenCalled();
  });
});

// What these suites prove: the Brand Brain's daily idea step serves each
// project at most once a day (a failed run is retried after an hour, not every
// tick), quietly (no chat cards) and a few lenses at a time, and serves at most
// `limit` projects per tick.
describe("IdeaFoundry.generateDaily", () => {
  const NOW = new Date("2026-10-04T12:00:00Z");

  it("runs once for a project not served today, quietly and three lenses at a time", async () => {
    opportunity.findMany.mockResolvedValue([candidate()]);
    const generate = vi
      .spyOn(IdeaFoundry, "generateForOpportunity")
      .mockResolvedValue(3);

    expect(await IdeaFoundry.generateDaily(3, NOW)).toBe(3);
    expect(generate).toHaveBeenCalledWith("opp-1", "proj-1", {
      postToChat: false,
      maxLenses: 3,
    });
    expect(reasoningCall.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ purpose: "idea.generate" }),
      }),
    );
    generate.mockRestore();
  });

  it("skips a project already served today and serves at most `limit` projects", async () => {
    opportunity.findMany.mockResolvedValue([
      candidate({ id: "o-done", projectId: "p-done" }),
      candidate({ id: "o-a", projectId: "p-a" }),
      candidate({ id: "o-b", projectId: "p-b" }),
    ]);
    reasoningCall.findMany.mockResolvedValue([
      { projectId: "p-done", createdAt: new Date("2026-10-04T02:00:00Z"), status: "OK" },
    ]);
    const generate = vi
      .spyOn(IdeaFoundry, "generateForOpportunity")
      .mockResolvedValue(1);

    await IdeaFoundry.generateDaily(1, NOW);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("o-a", "p-a", expect.anything());
    generate.mockRestore();
  });

  it("does nothing without an evaluated opportunity", async () => {
    opportunity.findMany.mockResolvedValue([]);
    expect(await IdeaFoundry.generateDaily(3, NOW)).toBe(0);
    expect(reasoningCall.findMany).not.toHaveBeenCalled();
  });

  it("a failed run blocks the project for an hour, a good one for the day", () => {
    const at = (iso: string) => new Date(iso);
    expect(dailyIdeaRunBlocks({ createdAt: at("2026-10-04T01:00:00Z"), status: "OK" }, NOW)).toBe(true);
    expect(dailyIdeaRunBlocks({ createdAt: at("2026-10-04T11:30:00Z"), status: "ERROR" }, NOW)).toBe(true);
    expect(dailyIdeaRunBlocks({ createdAt: at("2026-10-04T10:30:00Z"), status: "ERROR" }, NOW)).toBe(false);
  });
});

describe("IdeaFoundry.generateForOpportunity (maxLenses)", () => {
  it("asks for at most maxLenses lenses in one call", async () => {
    opportunityFindByIdInProject.mockResolvedValue({
      id: "opp-1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "b-1",
      title: "An opportunity",
      description: "Why it matters",
      category: "TREND",
      status: "EVALUATED",
    });
    reasoningRun.mockResolvedValue({ output: { ideas: [] }, isMock: true });

    await IdeaFoundry.generateForOpportunity("opp-1", "proj-1", {
      postToChat: false,
      maxLenses: 2,
    });

    const context = reasoningRun.mock.calls[0]![1].context as { lenses: string[] };
    expect(context.lenses).toHaveLength(2);
  });
});
