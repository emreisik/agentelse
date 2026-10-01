import { beforeEach, describe, expect, it, vi } from "vitest";

// Bug fix: existsForOpportunityLens previously counted ANY idea for a
// (opportunityId, lens) pair regardless of status — an ARCHIVED/REJECTED
// idea permanently blocked that lens from ever getting a fresh attempt via
// IdeaFoundry.generateForOpportunity, even once the parent Opportunity
// became retry-eligible again (Scenario K) or a user explicitly revises the
// idea (feedback-driven regeneration).

const idea = { count: vi.fn(), findFirst: vi.fn(), update: vi.fn() };
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

describe("IdeaRepository.promoteToShortlist", () => {
  // A tiny in-memory idea so each transition sees the status the last one set.
  function stubIdea(status: string) {
    let current = status;
    idea.findFirst.mockImplementation(async () => ({ id: "idea-1", status: current }));
    idea.update.mockImplementation(
      async ({ data }: { data: { status: string } }) => {
        current = data.status;
        return { id: "idea-1", status: current };
      },
    );
  }
  const statusesWritten = () =>
    idea.update.mock.calls.map(
      (call) => (call[0] as { data: { status: string } }).data.status,
    );

  it("walks a RAW idea through the same states the Council does", async () => {
    stubIdea("RAW");

    const result = await IdeaRepository.promoteToShortlist("idea-1", "proj-1");

    expect(result).toBe("SHORTLISTED");
    expect(statusesWritten()).toEqual(["VALIDATED", "CONCEPT", "SHORTLISTED"]);
  });

  it("only finishes the remaining steps for an idea already part-way", async () => {
    stubIdea("CONCEPT");

    await IdeaRepository.promoteToShortlist("idea-1", "proj-1");

    expect(statusesWritten()).toEqual(["SHORTLISTED"]);
  });

  it.each(["SHORTLISTED", "APPROVED", "ACTIVE", "REJECTED", "ARCHIVED"])(
    "leaves a %s idea exactly as it is",
    async (status) => {
      stubIdea(status);

      const result = await IdeaRepository.promoteToShortlist("idea-1", "proj-1");

      expect(result).toBe(status);
      expect(idea.update).not.toHaveBeenCalled();
    },
  );

  it("throws NOT_FOUND for an idea that is not in this project", async () => {
    idea.findFirst.mockResolvedValue(null);

    await expect(
      IdeaRepository.promoteToShortlist("idea-1", "someone-elses"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(idea.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "idea-1", projectId: "someone-elses" } }),
    );
  });
});

describe("IdeaRepository.advanceForScheduling", () => {
  function stubIdea(status: string) {
    let current = status;
    idea.findFirst.mockImplementation(async () => ({ id: "idea-1", status: current }));
    idea.update.mockImplementation(
      async ({ data }: { data: { status: string } }) => {
        current = data.status;
        return { id: "idea-1", status: current };
      },
    );
    return () => current;
  }
  const statusesWritten = () =>
    idea.update.mock.calls.map(
      (call) => (call[0] as { data: { status: string } }).data.status,
    );

  it.each([
    ["RAW", ["VALIDATED", "CONCEPT", "SHORTLISTED", "APPROVED", "PLANNING", "ACTIVE", "MEASURING"]],
    ["CONCEPT", ["SHORTLISTED", "APPROVED", "PLANNING", "ACTIVE", "MEASURING"]],
    ["SHORTLISTED", ["APPROVED", "PLANNING", "ACTIVE", "MEASURING"]],
    ["APPROVED", ["PLANNING", "ACTIVE", "MEASURING"]],
    ["PLANNING", ["ACTIVE", "MEASURING"]],
    ["ACTIVE", ["MEASURING"]],
  ])("ends a %s idea at MEASURING through legal steps", async (start, steps) => {
    const current = stubIdea(start);

    const result = await IdeaRepository.advanceForScheduling("idea-1", "proj-1");

    expect(result).toBe("MEASURING");
    expect(current()).toBe("MEASURING");
    expect(statusesWritten()).toEqual(steps);
  });

  it("is idempotent: a second run writes nothing", async () => {
    stubIdea("APPROVED");
    await IdeaRepository.advanceForScheduling("idea-1", "proj-1");
    idea.update.mockClear();

    const again = await IdeaRepository.advanceForScheduling("idea-1", "proj-1");

    expect(again).toBe("MEASURING");
    expect(idea.update).not.toHaveBeenCalled();
  });

  it.each(["MEASURING", "LEARNED"])("is a no-op from %s", async (status) => {
    stubIdea(status);

    const result = await IdeaRepository.advanceForScheduling("idea-1", "proj-1");

    expect(result).toBe(status);
    expect(idea.update).not.toHaveBeenCalled();
  });

  it.each(["REJECTED", "ARCHIVED"])("refuses a %s idea without writes", async (status) => {
    stubIdea(status);

    await expect(
      IdeaRepository.advanceForScheduling("idea-1", "proj-1"),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(idea.update).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for an idea outside the project", async () => {
    idea.findFirst.mockResolvedValue(null);

    await expect(
      IdeaRepository.advanceForScheduling("idea-1", "other"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(idea.update).not.toHaveBeenCalled();
  });
});
