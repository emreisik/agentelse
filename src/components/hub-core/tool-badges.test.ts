import { describe, expect, it } from "vitest";

import { toolBadgesFrom, type ToolBadgeCounts } from "./tool-badges";

const counts = (over: Partial<ToolBadgeCounts> = {}): ToolBadgeCounts => ({
  setupWaitingClient: 0,
  proposedGoals: 0,
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

  it("badges setup while a stage waits for the client", () => {
    expect(toolBadgesFrom(counts({ setupWaitingClient: 1 }))).toEqual({
      setup: 1,
    });
  });
});
