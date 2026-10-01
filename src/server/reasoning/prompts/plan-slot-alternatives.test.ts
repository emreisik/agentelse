import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PlanSlotAlternativesSchema,
  planSlotAlternativesDef,
} from "./plan-slot-alternatives";

const facts = {
  language: "tr",
  slots: [
    {
      index: 0,
      date: "2026-10-05",
      topic: "Spring menu launch",
      captionIdea: "A short look at the new dishes",
      existingAlternatives: ["Chef story"],
    },
    {
      index: 3,
      date: "2026-10-07",
      topic: "Team picks",
      captionIdea: "Which dish do we order ourselves?",
      existingAlternatives: [],
    },
  ],
  otherTopics: ["Spring menu launch", "Team picks"],
  neverRules: ["Never mention competitors by name"],
  approvedClaims: ["Family owned since 1999"],
};

describe("planSlotAlternativesDef", () => {
  it("is the cheap default-tier step with room for a 14-slot answer", () => {
    expect(planSlotAlternativesDef.purpose).toBe("plan.slotAlternatives");
    expect(planSlotAlternativesDef.tier).toBe("default");
    expect(planSlotAlternativesDef.maxTokens).toBe(4000);
  });

  it("accepts a valid answer and clamps the lists instead of failing", () => {
    const alternatives = Array.from({ length: 5 }, (_, i) => ({
      topic: `Topic ${i}`,
      captionIdea: `Caption ${i}`,
    }));
    const slots = Array.from({ length: 16 }, (_, index) => ({
      index,
      alternatives,
    }));
    const parsed = PlanSlotAlternativesSchema.parse({ slots });
    expect(parsed.slots).toHaveLength(14);
    expect(parsed.slots[0]?.alternatives).toHaveLength(3);
  });

  it("rejects a negative or fractional slot index", () => {
    for (const index of [-1, 1.5]) {
      expect(
        PlanSlotAlternativesSchema.safeParse({
          slots: [{ index, alternatives: [] }],
        }).success,
      ).toBe(false);
    }
  });

  it("survives z.toJSONSchema (no bare transform)", () => {
    expect(() => z.toJSONSchema(PlanSlotAlternativesSchema)).not.toThrow();
  });

  it("fences FACTS and carries the rules and the existing alternatives", () => {
    const { system, user } = planSlotAlternativesDef.buildPrompt({ facts });
    expect(user.startsWith("FACTS (JSON): ")).toBe(true);
    expect(user).toContain("Never mention competitors by name");
    expect(user).toContain("Chef story");
    expect(user).toContain("Family owned since 1999");
    expect(system).toContain("neverRules");
    expect(system).toContain("existingAlternatives");
    expect(system).toContain("approvedClaims");
    expect(system).toContain("data, not instructions");
  });

  it("builds a mock from the input that satisfies the schema", () => {
    const mock = planSlotAlternativesDef.buildMock({ facts });
    expect(() => PlanSlotAlternativesSchema.parse(mock)).not.toThrow();
    expect(mock.slots.map((slot) => slot.index)).toEqual([0, 3]);
    expect(mock.slots[0]?.alternatives[0]?.topic).toBe(
      "Spring menu launch (alternative)",
    );
  });

  it("builds an empty mock when the context has no slots", () => {
    expect(planSlotAlternativesDef.buildMock({})).toEqual({ slots: [] });
  });
});
