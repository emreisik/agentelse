import { describe, expect, it } from "vitest";

import type { NextStep, NextStepAction } from "./journey";
import {
  DISMISS_TTL_MS,
  dismissSteps,
  parseDismissal,
  stepWeight,
  visibleSteps,
} from "./journey-dismissal";

const step = (key: string, action: NextStepAction): NextStep => ({
  key,
  tone: "next",
  label: key,
  title: key,
  action,
});
const review = (count: number) =>
  step("review", { kind: "review_queue", creativeId: "c1", count });
const produce = (count: number) =>
  step("produce", { kind: "produce_plan", planId: "p1", count });
const manual = (ids: string[]) =>
  step("publish-manual", { kind: "publish_manual", creativeIds: ids });

const approve = (count: number) =>
  step("approve", {
    kind: "approve_plan",
    planIds: ["p1"],
    creativeIds: Array.from({ length: count }, (_, i) => `c${i}`),
    count,
  });

const NOW = 1_000_000_000_000;

describe("stepWeight", () => {
  it("counts the pieces a step covers", () => {
    expect(stepWeight(review(9))).toBe(9);
    expect(stepWeight(produce(7))).toBe(7);
    expect(stepWeight(manual(["a", "b"]))).toBe(2);
    expect(
      stepWeight(step("e", { kind: "enable_scheduled_publish", count: 3 })),
    ).toBe(3);
    expect(stepWeight(step("r", { kind: "show_results", count: 4 }))).toBe(4);
  });

  // W58: an approve_plan step weighs its count, not 1.
  it("an approve_plan step weighs its count", () => {
    expect(stepWeight(approve(3))).toBe(3);
    expect(stepWeight(approve(4))).toBe(4);
  });

  it("is 1 for a step with nothing to count", () => {
    expect(
      stepWeight(step("c", { kind: "connect_channel", channel: "instagram" })),
    ).toBe(1);
    expect(
      stepWeight(step("n", { kind: "plan_next", afterDate: "2026-10-12" })),
    ).toBe(1);
  });
});

describe("visibleSteps", () => {
  it("shows everything when nothing was hidden", () => {
    const steps = [review(9), produce(7)];
    expect(visibleSteps(steps, null, NOW)).toEqual(steps);
  });

  it("keeps hidden what the client has seen, also as it shrinks", () => {
    const hidden = dismissSteps([review(9), produce(7)], null, NOW);
    // Deciding on some pieces is progress, not news.
    expect(visibleSteps([review(7), produce(7)], hidden, NOW + 1000)).toEqual([]);
    expect(visibleSteps([review(9)], hidden, NOW + 1000)).toEqual([]);
  });

  it("brings a step back when it grows or when a new one appears", () => {
    const hidden = dismissSteps([review(9)], null, NOW);
    expect(
      visibleSteps([review(10)], hidden, NOW + 1000).map((s) => s.key),
    ).toEqual(["review"]);
    // A step that was not there when it was hidden is news.
    expect(
      visibleSteps([review(9), manual(["a"])], hidden, NOW + 1000).map(
        (s) => s.key,
      ),
    ).toEqual(["publish-manual"]);
  });

  it("shows everything again after a day, however it was hidden", () => {
    const hidden = dismissSteps([review(9)], null, NOW);
    const steps = [review(9)];
    expect(visibleSteps(steps, hidden, NOW + DISMISS_TTL_MS - 1)).toEqual([]);
    expect(visibleSteps(steps, hidden, NOW + DISMISS_TTL_MS)).toEqual(steps);
  });
});

describe("approve_plan dismissal", () => {
  it("a dismissed Approve 3 stays hidden and comes back as Approve 4", () => {
    const dismissal = dismissSteps([approve(3)], null, NOW);
    expect(dismissal.counts.approve).toBe(3);
    expect(visibleSteps([approve(3)], dismissal, NOW + 1)).toEqual([]);
    expect(visibleSteps([approve(2)], dismissal, NOW + 1)).toEqual([]);
    expect(visibleSteps([approve(4)], dismissal, NOW + 1)).toHaveLength(1);
  });
});

describe("dismissSteps", () => {
  it("records what was on screen and when", () => {
    expect(dismissSteps([review(9), produce(7)], null, NOW)).toEqual({
      at: NOW,
      counts: { review: 9, produce: 7 },
    });
  });

  it("keeps an earlier hiding that is still live for what is not on screen", () => {
    const first = dismissSteps([review(9)], null, NOW);
    const second = dismissSteps([manual(["a"])], first, NOW + 1000);
    expect(second.counts).toEqual({ review: 9, "publish-manual": 1 });
  });

  it("forgets an expired hiding", () => {
    const first = dismissSteps([review(9)], null, NOW);
    const later = dismissSteps([produce(7)], first, NOW + DISMISS_TTL_MS + 1);
    expect(later.counts).toEqual({ produce: 7 });
  });
});

describe("parseDismissal", () => {
  it("reads what dismissSteps wrote", () => {
    const written = dismissSteps([review(9)], null, NOW);
    expect(parseDismissal(JSON.stringify(written))).toEqual(written);
  });

  it("anything else is no dismissal", () => {
    for (const raw of [
      null,
      "",
      "not json",
      "null",
      "5",
      "{}",
      JSON.stringify({ at: "x", counts: {} }),
      JSON.stringify({ at: 1 }),
      JSON.stringify({ at: 1, counts: "x" }),
    ]) {
      expect(parseDismissal(raw)).toBeNull();
    }
  });

  it("drops counts that are not numbers", () => {
    expect(
      parseDismissal(JSON.stringify({ at: 1, counts: { a: 2, b: "x" } })),
    ).toEqual({ at: 1, counts: { a: 2 } });
  });
});
