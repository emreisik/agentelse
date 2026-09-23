import { beforeEach, describe, expect, it, vi } from "vitest";

// Bug fix: existsForOpportunityLens previously counted ANY idea for a
// (opportunityId, lens) pair regardless of status — an ARCHIVED/REJECTED
// idea permanently blocked that lens from ever getting a fresh attempt via
// IdeaFoundry.generateForOpportunity, even once the parent Opportunity
// became retry-eligible again (Scenario K) or a user explicitly revises the
// idea (feedback-driven regeneration).

const idea = { count: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { idea },
}));

const { IdeaRepository } = await import("./idea.repository");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IdeaRepository.existsForOpportunityLens", () => {
  it("excludes ARCHIVED and REJECTED ideas from the existence check", async () => {
    idea.count.mockResolvedValue(0);

    await IdeaRepository.existsForOpportunityLens("opp-1", "BRAND");

    expect(idea.count).toHaveBeenCalledWith({
      where: {
        opportunityId: "opp-1",
        lens: "BRAND",
        status: { notIn: ["ARCHIVED", "REJECTED"] },
      },
    });
  });

  it("returns true when a non-terminal idea exists for the lens", async () => {
    idea.count.mockResolvedValue(1);

    const exists = await IdeaRepository.existsForOpportunityLens(
      "opp-1",
      "BRAND",
    );

    expect(exists).toBe(true);
  });

  it("returns false when only ARCHIVED/REJECTED ideas exist for the lens (retry-eligible)", async () => {
    // The query itself already filters these out — a count of 0 here
    // simulates the DB correctly excluding the archived/rejected rows.
    idea.count.mockResolvedValue(0);

    const exists = await IdeaRepository.existsForOpportunityLens(
      "opp-1",
      "BRAND",
    );

    expect(exists).toBe(false);
  });
});
