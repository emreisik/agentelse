import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PlanOptionsArgsSchema,
  buildOptionsCard,
  optionItems,
  optionsShapeError,
  type PlanOptionsArgs,
} from "./plan-options";
import type { PlanSlot } from "./plan-layout";

const SLOTS: PlanSlot[] = [
  { date: "2026-10-05", time: "10:00", channel: "instagram", formatKey: "instagram.post" },
  { date: "2026-10-07", time: "10:00", channel: "linkedin", formatKey: "linkedin.post" },
];

const idea = (n: number) => ({ topic: `Topic ${n}`, captionIdea: `Caption ${n}` });

function args(over: Partial<PlanOptionsArgs> = {}): PlanOptionsArgs {
  return {
    title: "  Launch week  ",
    reason: " Fits the new launch ",
    options: [
      { label: " Education first ", angle: "Teach", basis: " Clients ask how ", ideas: [idea(1), idea(2)] },
      { label: "Behind the scenes", angle: "Show", ideas: [idea(3), idea(4)] },
    ],
    ...over,
  };
}

describe("PlanOptionsArgsSchema", () => {
  it("accepts a valid shape", () => {
    expect(PlanOptionsArgsSchema.safeParse(args()).success).toBe(true);
    expect(PlanOptionsArgsSchema.safeParse({ ...args(), goal: "leads" }).success).toBe(true);
  });

  it("rejects 1 and 4 options", () => {
    const base = args().options;
    expect(PlanOptionsArgsSchema.safeParse({ ...args(), options: [base[0]] }).success).toBe(false);
    expect(
      PlanOptionsArgsSchema.safeParse({ ...args(), options: [base[0], base[1], base[0], base[1]] }).success,
    ).toBe(false);
  });

  it("rejects empty, too many ideas, long caption, long basis, bad goal", () => {
    const base = args().options;
    const withIdeas = (ideas: { topic: string; captionIdea: string }[]) => ({
      ...args(),
      options: [{ ...base[0]!, ideas }, base[1]],
    });
    expect(PlanOptionsArgsSchema.safeParse(withIdeas([])).success).toBe(false);
    expect(
      PlanOptionsArgsSchema.safeParse(withIdeas(Array.from({ length: 11 }, (_, i) => idea(i)))).success,
    ).toBe(false);
    expect(
      PlanOptionsArgsSchema.safeParse(withIdeas(Array.from({ length: 10 }, (_, i) => idea(i)))).success,
    ).toBe(true);
    expect(
      PlanOptionsArgsSchema.safeParse(withIdeas([{ topic: "t", captionIdea: "x".repeat(201) }])).success,
    ).toBe(false);
    expect(
      PlanOptionsArgsSchema.safeParse({
        ...args(),
        options: [{ ...base[0]!, basis: "x".repeat(81) }, base[1]],
      }).success,
    ).toBe(false);
    expect(PlanOptionsArgsSchema.safeParse({ ...args(), goal: "fame" }).success).toBe(false);
  });

  it("is representable as JSON schema", () => {
    expect(() => z.toJSONSchema(PlanOptionsArgsSchema)).not.toThrow();
  });
});

describe("optionsShapeError", () => {
  it("is null when every option matches the slot count", () => {
    expect(optionsShapeError(args(), 2)).toBeNull();
  });

  it("names the offending option", () => {
    const message = optionsShapeError(args(), 3);
    expect(message).toContain("Education first");
    expect(message).toContain("2 ideas");
    expect(message).toContain("3");
    const second = optionsShapeError(
      args({ options: [args().options[0]!, { ...args().options[1]!, ideas: [idea(9)] }] }),
      2,
    );
    expect(second).toContain("Behind the scenes");
  });
});

describe("buildOptionsCard", () => {
  it("builds an open card with ids a,b, trimmed strings and brandCheck", () => {
    const card = buildOptionsCard({
      args: { ...args(), goal: "leads" },
      slots: SLOTS,
      timezone: "Europe/Istanbul",
      brandCheck: { state: "checked", rules: 4 },
    });
    expect(card.kind).toBe("content-plan-options");
    expect(card.state).toBe("open");
    expect(card.title).toBe("Launch week");
    expect(card.reason).toBe("Fits the new launch");
    expect(card.goal).toBe("leads");
    expect(card.timezone).toBe("Europe/Istanbul");
    expect(card.brandCheck).toEqual({ state: "checked", rules: 4 });
    expect(card.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(card.options[0]!.label).toBe("Education first");
    expect(card.options[0]!.basis).toBe("Clients ask how");
    expect(card.options[1]!.basis).toBeUndefined();
    expect(card.slots).toEqual(SLOTS);
  });

  it("omits goal and brandCheck when absent and gives c to a third option", () => {
    const three = args();
    three.options.push({ label: "Stories", angle: "Tell", ideas: [idea(5), idea(6)] });
    const card = buildOptionsCard({ args: three, slots: SLOTS, timezone: "UTC" });
    expect("goal" in card).toBe(false);
    expect("brandCheck" in card).toBe(false);
    expect(card.options.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });
});

describe("optionItems", () => {
  const card = buildOptionsCard({ args: args(), slots: SLOTS, timezone: "UTC" });

  it("zips slots and ideas", () => {
    expect(optionItems(card, "b")).toEqual([
      { ...SLOTS[0], topic: "Topic 3", captionIdea: "Caption 3" },
      { ...SLOTS[1], topic: "Topic 4", captionIdea: "Caption 4" },
    ]);
  });

  it("is null for an unknown option or a length mismatch", () => {
    expect(optionItems(card, "c")).toBeNull();
    const broken = { ...card, slots: [SLOTS[0]!] };
    expect(optionItems(broken, "a")).toBeNull();
  });
});
