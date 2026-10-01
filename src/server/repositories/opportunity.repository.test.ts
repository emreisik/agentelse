import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the open-opportunity cap counts only opportunities
// still waiting for attention. ACCEPTED (ideas were made from it, and nothing
// ever moves it on) used to count, which filled the cap for good: a project with
// 30 such opportunities could never get a new one evaluated.

const count = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { opportunity: { count } } }));
vi.mock("@/server/repositories/insight.repository", () => ({
  InsightRepository: {},
}));

const { OpportunityRepository } = await import("./opportunity.repository");

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(3);
});

describe("OpportunityRepository.countOpen", () => {
  it("counts the ones still waiting: new, under review, evaluated", async () => {
    expect(await OpportunityRepository.countOpen("proj-1")).toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        status: { in: ["NEW", "REVIEWING", "EVALUATED"] },
      },
    });
  });

  it("does not count an opportunity that already became ideas", async () => {
    await OpportunityRepository.countOpen("proj-1");
    const { status } = count.mock.calls[0]![0].where as {
      status: { in: string[] };
    };
    for (const done of [
      "ACCEPTED",
      "CONVERTED_TO_IDEA",
      "CONVERTED_TO_TASK",
      "DISMISSED",
      "EXPIRED",
      "DUPLICATE",
    ]) {
      expect(status.in).not.toContain(done);
    }
  });
});
