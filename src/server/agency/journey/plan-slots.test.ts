import { describe, expect, it } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

import { withPlanSlots } from "./plan-slots";

const plan = (over: Record<string, unknown> = {}) =>
  ({
    kind: "content-plan-draft",
    title: "Plan",
    timezone: "UTC",
    state: "saved",
    items: [],
    savedCreativeIds: ["a", "b", "gone"],
    ...over,
  }) as IdeaEventCardData;

const stages = new Map([
  ["a", { stage: "IN_REVIEW" as const, assetId: "asset-1" }],
  ["b", { stage: "PLANNED" as const, assetId: undefined }],
]);

describe("withPlanSlots", () => {
  it("lines each saved piece up with its stage, in the plan's order", () => {
    const card = withPlanSlots(plan(), stages);
    expect(card).toMatchObject({
      slots: [
        { id: "a", stage: "IN_REVIEW", assetId: "asset-1" },
        { id: "b", stage: "PLANNED" },
        null,
      ],
    });
  });

  it("does not touch the stored card", () => {
    const original = plan();
    withPlanSlots(original, stages);
    expect(original).not.toHaveProperty("slots");
  });

  it("leaves every other card, and an unsaved or replaced plan, alone", () => {
    const draft = plan({ state: "draft" });
    const superseded = plan({ state: "superseded" });
    const other = { kind: "content-package", topic: "t", state: "draft", items: [] } as IdeaEventCardData;
    expect(withPlanSlots(draft, stages)).toBe(draft);
    expect(withPlanSlots(superseded, stages)).toBe(superseded);
    expect(withPlanSlots(other, stages)).toBe(other);
    expect(withPlanSlots(undefined, stages)).toBeUndefined();
  });

  it("a saved plan from before pieces were recorded has no slots", () => {
    const old = plan({ savedCreativeIds: undefined });
    expect(withPlanSlots(old, stages)).toBe(old);
  });
});
