import { beforeEach, describe, expect, it, vi } from "vitest";

// Paused-project guard (audit scenario L): OpportunityEngine must not
// dispatch a PAUSED project's insight into evaluateInsight — same
// silent-skip contract every other autonomous engine's batch loop now
// follows (see agency-director.ts, work-handoff-engine.ts,
// measurement-engine.ts, learning-engine.ts, council-engine.ts).

const listByStatus = vi.fn();
vi.mock("@/server/repositories/insight.repository", () => ({
  InsightRepository: { listByStatus },
}));

const isProjectAgencyActive = vi.fn().mockResolvedValue(true);
vi.mock("@/server/repositories/agency-loop-state.repository", () => ({
  isProjectAgencyActive,
}));

const { OpportunityEngine } =
  await import("@/server/agency/opportunities/opportunity-engine");

beforeEach(() => {
  vi.clearAllMocks();
  isProjectAgencyActive.mockResolvedValue(true);
});

describe("OpportunityEngine.evaluatePromotedInsights (paused-project guard, audit scenario L)", () => {
  it("skips the batch dispatch into evaluateInsight for a PAUSED project's insight but still dispatches an ACTIVE project's insight", async () => {
    const pausedInsight = {
      id: "insight-paused",
      projectId: "proj-paused",
      title: "Paused insight",
    };
    const activeInsight = {
      id: "insight-active",
      projectId: "proj-active",
      title: "Active insight",
    };
    listByStatus.mockResolvedValue([pausedInsight, activeInsight]);
    isProjectAgencyActive.mockImplementation(
      async (projectId: string) => projectId !== "proj-paused",
    );
    const evaluateInsight = vi
      .spyOn(OpportunityEngine, "evaluateInsight")
      .mockResolvedValue({ created: true, opportunityId: "opp-1" });

    const created = await OpportunityEngine.evaluatePromotedInsights(10);

    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-paused");
    expect(isProjectAgencyActive).toHaveBeenCalledWith("proj-active");
    expect(evaluateInsight).not.toHaveBeenCalledWith(
      "insight-paused",
      "proj-paused",
    );
    expect(evaluateInsight).toHaveBeenCalledWith(
      "insight-active",
      "proj-active",
    );
    expect(created).toBe(1);

    evaluateInsight.mockRestore();
  });
});
