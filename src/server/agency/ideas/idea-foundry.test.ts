import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): IdeaFoundry must not dispatch a
// PAUSED project's opportunity into generateForOpportunity — same
// silent-skip contract every other autonomous engine's batch loop now
// follows (see agency-director.ts, opportunity-engine.ts, council-engine.ts).

const opportunity = { findMany: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { opportunity },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const opportunityTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/opportunity.repository", () => ({
  OpportunityRepository: { transition: opportunityTransition },
}));

const { IdeaFoundry } = await import("@/server/agency/ideas/idea-foundry");

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
