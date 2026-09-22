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

const { IdeaFoundry } = await import("@/server/agency/ideas/idea-foundry");

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
});

describe("IdeaFoundry.generateForTopOpportunities (paused-project guard, audit scenario L)", () => {
  it("skips the batch dispatch into generateForOpportunity for a PAUSED project's opportunity but still dispatches an ACTIVE project's opportunity", async () => {
    const pausedOpportunity = {
      id: "opp-paused",
      projectId: "proj-paused",
      title: "Paused opportunity",
    };
    const activeOpportunity = {
      id: "opp-active",
      projectId: "proj-active",
      title: "Active opportunity",
    };
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
