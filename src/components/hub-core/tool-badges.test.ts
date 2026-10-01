import { describe, expect, it } from "vitest";

import { toolBadgesFrom, type ToolBadgeCounts } from "./tool-badges";

const counts = (over: Partial<ToolBadgeCounts> = {}): ToolBadgeCounts => ({
  setupWaitingClient: 0,
  pendingHumanActions: 0,
  proposedGoals: 0,
  proposedHandoffs: 0,
  awaitingPlans: 0,
  ...over,
});

describe("toolBadgesFrom", () => {
  it("has no badge when nothing waits, or before the counts are known", () => {
    expect(toolBadgesFrom(null)).toEqual({});
    expect(toolBadgesFrom(counts())).toEqual({});
  });

  it("goals waiting for a decision badge Brand Brain (Goals is one of its tabs)", () => {
    expect(toolBadgesFrom(counts({ proposedGoals: 3 }))).toEqual({
      "brand-brain": 3,
    });
    // The old Goals panel key is not used any more.
    expect(toolBadgesFrom(counts({ proposedGoals: 3 }))).not.toHaveProperty("goals");
  });

  it("badges the other entries with what waits there", () => {
    expect(
      toolBadgesFrom(
        counts({
          setupWaitingClient: 1,
          pendingHumanActions: 2,
          proposedHandoffs: 3,
          awaitingPlans: 4,
        }),
      ),
    ).toEqual({ setup: 1, "human-action": 2, work: 7 });
  });
});
