import { describe, expect, it } from "vitest";
import {
  MAX_ALTERNATIVES_STORED,
  alternativesFromOptions,
  canSwapSlot,
  normalizeAlternatives,
  swapItem,
  swappableIndexes,
  type PlanAlternative,
  type SwapSlotState,
} from "./plan-alternatives";

const base = {
  date: "2026-10-05",
  time: "10:00",
  channel: "instagram",
  formatKey: "instagram.post",
  origin: "plan",
  ideaId: "i1",
  topic: "Spring menu",
  captionIdea: "Show the new menu",
  from: "Education first",
  brandFlags: [{ kind: "never-term" }],
  alternatives: [
    { topic: "Behind the scenes", captionIdea: "Kitchen at dawn", from: "Story first" },
    { topic: "Customer story", captionIdea: "A regular tells", from: "Proof first" },
  ] as PlanAlternative[],
};

describe("swapItem", () => {
  it("rotates the idea into the same index with its label and keeps scheduling fields", () => {
    const out = swapItem(base, 1)!;
    expect(out.topic).toBe("Customer story");
    expect(out.from).toBe("Proof first");
    expect(out.alternatives?.[1]).toEqual({
      topic: "Spring menu",
      captionIdea: "Show the new menu",
      from: "Education first",
    });
    expect(out.alternatives?.[0]).toEqual(base.alternatives[0]);
    for (const k of ["date", "time", "channel", "formatKey", "origin", "ideaId"] as const) {
      expect(out[k]).toBe(base[k]);
    }
    expect("brandFlags" in out).toBe(false);
  });

  it("a second swap restores idea and label", () => {
    const once = swapItem(base, 0)!;
    const twice = swapItem(once, 0)!;
    expect(twice.topic).toBe(base.topic);
    expect(twice.captionIdea).toBe(base.captionIdea);
    expect(twice.from).toBe(base.from);
    expect(twice.alternatives).toEqual(base.alternatives);
  });

  it("handles a missing label on either side", () => {
    const item = { topic: "A", captionIdea: "a", alternatives: [{ topic: "B", captionIdea: "b" }] };
    const out = swapItem(item, 0)!;
    expect("from" in out).toBe(false);
    expect(out.alternatives?.[0]).toEqual({ topic: "A", captionIdea: "a" });
  });

  it("returns null out of range and for legacy items", () => {
    expect(swapItem(base, 2)).toBeNull();
    expect(swapItem(base, -1)).toBeNull();
    expect(swapItem({ topic: "A", captionIdea: "a" }, 0)).toBeNull();
  });
});

describe("canSwapSlot", () => {
  const free: SwapSlotState = { status: "DRAFT", hasVersion: false, liveTask: false, inRunningClaim: false };
  it("matrix", () => {
    expect(canSwapSlot("superseded", free)).toMatchObject({ ok: false, code: "SUPERSEDED" });
    expect(canSwapSlot("draft", null)).toEqual({ ok: true });
    expect(canSwapSlot("saved", free)).toEqual({ ok: true });
    expect(canSwapSlot("saved", null)).toMatchObject({ ok: false, code: "LOCKED" });
    expect(canSwapSlot("saved", { ...free, status: "READY" })).toMatchObject({ code: "LOCKED" });
    expect(canSwapSlot("saved", { ...free, hasVersion: true })).toMatchObject({ code: "LOCKED" });
    expect(canSwapSlot("saved", { ...free, liveTask: true })).toMatchObject({ code: "LOCKED" });
    expect(canSwapSlot("saved", { ...free, inRunningClaim: true })).toMatchObject({ code: "LOCKED" });
  });
});

describe("normalizeAlternatives", () => {
  const current = { topic: "İndirim günü", captionIdea: "x" };
  it("dedupes with diacritics against current, taken, existing and itself", () => {
    const out = normalizeAlternatives(
      [
        { topic: "INDIRIM GUNU", captionIdea: "dup of current" },
        { topic: "Taken ışık", captionIdea: "dup of taken" },
        { topic: "Old one", captionIdea: "dup of existing" },
        { topic: "  ", captionIdea: "empty" },
        { topic: "Fresh", captionIdea: "" },
        { topic: " New A ", captionIdea: " a " },
        { topic: "new a", captionIdea: "dup of earlier" },
        { topic: "New B", captionIdea: "b" },
        { topic: "New C", captionIdea: "c" },
      ],
      current,
      ["taken ISIK"],
      [{ topic: "old one", captionIdea: "o" }],
    );
    expect(out).toEqual([
      { topic: "New A", captionIdea: "a" },
      { topic: "New B", captionIdea: "b" },
    ]);
  });

  it("never lets the stored total exceed the cap", () => {
    const existing = [1, 2, 3].map((n) => ({ topic: `E${n}`, captionIdea: "e" }));
    const out = normalizeAlternatives(
      [{ topic: "N1", captionIdea: "n" }, { topic: "N2", captionIdea: "n" }],
      current,
      [],
      existing,
    );
    expect(out).toHaveLength(MAX_ALTERNATIVES_STORED - 3);
    expect(
      normalizeAlternatives([{ topic: "N1", captionIdea: "n" }], current, [], [...existing, { topic: "E4", captionIdea: "e" }]),
    ).toEqual([]);
  });
});

describe("alternativesFromOptions", () => {
  const options = [
    { label: "Education first", ideas: [{ topic: "a0", captionIdea: "c" }, { topic: "a1", captionIdea: "c" }] },
    { label: "Story first", ideas: [{ topic: "b0", captionIdea: "c" }, { topic: "b1", captionIdea: "c" }] },
    { label: "Proof first", ideas: [{ topic: "c0", captionIdea: "c" }] },
  ];
  it("takes the other options' idea in order, labelled", () => {
    expect(alternativesFromOptions(options, 0, 0)).toEqual([
      { topic: "b0", captionIdea: "c", from: "Story first" },
      { topic: "c0", captionIdea: "c", from: "Proof first" },
    ]);
    expect(alternativesFromOptions(options, 1, 1)).toEqual([
      { topic: "a1", captionIdea: "c", from: "Education first" },
    ]);
    expect(alternativesFromOptions(options, 0, 5)).toEqual([]);
  });
});

describe("swappableIndexes", () => {
  const free: SwapSlotState = { status: "DRAFT", hasVersion: false, liveTask: false, inRunningClaim: false };
  const items = [
    { alternatives: [{ topic: "x", captionIdea: "y" }] },
    {},
    { alternatives: [] },
    { alternatives: [{ topic: "x", captionIdea: "y" }] },
  ];
  it("draft card lists every item with alternatives; legacy items are safe", () => {
    expect(swappableIndexes(items, null)).toEqual([0, 3]);
  });
  it("saved card excludes locked slots", () => {
    expect(swappableIndexes(items, [free, free, free, { ...free, hasVersion: true }])).toEqual([0]);
    expect(swappableIndexes(items, [free])).toEqual([0]);
  });
});
