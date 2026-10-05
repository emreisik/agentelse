import { describe, expect, it } from "vitest";

import type { PlanItemStage } from "@/lib/journey";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import {
  FLOW_STEPS,
  flowStatesOf,
  flowStepLabel,
  flowStepsOf,
  isFlowStep,
  socialFlowComplete,
  socialFlowStep,
} from "./flow";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type Slot = NonNullable<NonNullable<PlanCard["slots"]>[number]>;

function plan(over: Partial<PlanCard> = {}): PlanCard {
  return {
    kind: "content-plan-draft",
    title: "Social media plan",
    timezone: "Europe/Istanbul",
    state: "draft",
    items: [
      {
        date: "2026-10-05",
        time: "12:00",
        channel: "instagram",
        formatKey: "instagram.post",
        topic: "How the offer works",
        captionIdea: "Explain it with one example.",
      },
    ],
    ...over,
  };
}

// A saved plan whose pieces stand at these stages; null is a piece that is
// gone, `{ stage, excluded }` a channel left out of its post.
function saved(
  stages: (PlanItemStage | null | { stage: PlanItemStage; excluded: true })[],
): PlanCard {
  return plan({
    state: "saved",
    slots: stages.map((entry, index): Slot | null => {
      if (entry === null) return null;
      return typeof entry === "string"
        ? { id: `c${index}`, stage: entry }
        : { id: `c${index}`, stage: entry.stage, excluded: true };
    }),
  });
}

describe("the standard steps", () => {
  it("are brief, plan, create, review and deliver, in that order", () => {
    expect(FLOW_STEPS).toEqual([
      "brief",
      "plan",
      "create",
      "review",
      "deliver",
    ]);
  });

  it("only the last step's verb differs per module", () => {
    expect(flowStepsOf("social").map((step) => step.label)).toEqual([
      "Brief",
      "Plan",
      "Create",
      "Review",
      "Publish",
    ]);
    expect(flowStepLabel("deliver", "ads")).toBe("Launch");
    expect(flowStepLabel("deliver", "analytics")).toBe("Share");
    expect(flowStepLabel("deliver", "seo")).toBe("Publish");
    expect(flowStepLabel("review", "ads")).toBe("Review");
    expect(flowStepsOf("analytics").map((step) => step.key)).toEqual([
      ...FLOW_STEPS,
    ]);
  });

  it("knows its own step names and nothing else", () => {
    expect(FLOW_STEPS.every(isFlowStep)).toBe(true);
    for (const value of ["content", "publish", "Brief", "", null, 3]) {
      expect(isFlowStep(value)).toBe(false);
    }
  });
});

describe("flowStatesOf", () => {
  it.each([
    ["brief", ["current", "todo", "todo", "todo", "todo"]],
    ["plan", ["done", "current", "todo", "todo", "todo"]],
    ["create", ["done", "done", "current", "todo", "todo"]],
    ["review", ["done", "done", "done", "current", "todo"]],
    ["deliver", ["done", "done", "done", "done", "current"]],
  ] as const)(
    "at %s the steps before are done and the ones after to do",
    (current, states) => {
      const out = flowStatesOf(current);
      expect(FLOW_STEPS.map((step) => out[step])).toEqual(states);
    },
  );

  it("a complete flow is done all the way", () => {
    const out = flowStatesOf("deliver", { complete: true });
    expect(FLOW_STEPS.map((step) => out[step])).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
  });
});

describe("socialFlowStep", () => {
  it("with no plan yet the Work is at its brief", () => {
    expect(socialFlowStep()).toBe("brief");
    expect(socialFlowStep(null)).toBe("brief");
  });

  it("a draft is at the plan step", () => {
    expect(socialFlowStep(plan())).toBe("plan");
  });

  it.each([
    ["nothing made yet", ["PLANNED", "PLANNED"]],
    ["a failed piece to make again", ["FAILED", "APPROVED"]],
    ["pieces being made", ["PRODUCING", "IN_REVIEW"]],
    ["some made, some still to make", ["IN_REVIEW", "PLANNED", "APPROVED"]],
  ] as const)("%s is the create step", (_label, stages) => {
    expect(socialFlowStep(saved([...stages]))).toBe("create");
  });

  it("a saved plan whose pieces are not read yet is the create step", () => {
    expect(socialFlowStep(plan({ state: "saved" }))).toBe("create");
  });

  it.each([
    ["content waiting for a decision", ["IN_REVIEW", "IN_REVIEW"]],
    ["one waiting among approved ones", ["APPROVED", "IN_REVIEW", "PUBLISHED"]],
    ["every piece declined (nothing goes out)", ["REJECTED", "REJECTED"]],
  ] as const)("%s is the review step", (_label, stages) => {
    expect(socialFlowStep(saved([...stages]))).toBe("review");
  });

  it.each([
    ["everything approved", ["APPROVED", "APPROVED"]],
    ["approved and already out", ["APPROVED", "PUBLISHED"]],
    ["approved next to a declined one", ["APPROVED", "REJECTED"]],
    ["approved next to a piece that is gone", ["APPROVED", null]],
  ] as const)("%s is the deliver step", (_label, stages) => {
    expect(socialFlowStep(saved([...stages]))).toBe("deliver");
  });

  it("a channel left out of its post counts for nothing", () => {
    expect(
      socialFlowStep(
        saved(["APPROVED", { stage: "IN_REVIEW", excluded: true }]),
      ),
    ).toBe("deliver");
    expect(
      socialFlowStep(
        saved(["IN_REVIEW", { stage: "PLANNED", excluded: true }]),
      ),
    ).toBe("review");
  });
});

describe("socialFlowComplete", () => {
  it("is complete once every live piece is published", () => {
    expect(socialFlowComplete(saved(["PUBLISHED", "PUBLISHED"]))).toBe(true);
    expect(
      socialFlowComplete(
        saved(["PUBLISHED", null, { stage: "APPROVED", excluded: true }]),
      ),
    ).toBe(true);
  });

  it("is not while anything still waits, nor without a saved plan", () => {
    expect(socialFlowComplete(saved(["PUBLISHED", "APPROVED"]))).toBe(false);
    expect(socialFlowComplete(saved([null]))).toBe(false);
    expect(socialFlowComplete(plan())).toBe(false);
    expect(socialFlowComplete(plan({ state: "saved" }))).toBe(false);
    expect(socialFlowComplete()).toBe(false);
  });
});
