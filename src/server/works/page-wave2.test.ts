import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { JourneyItem, JourneySnapshot, NextStep } from "@/lib/journey";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import {
  approvalIdOfCard,
  briefFactsFor,
  dayStartIso,
  nextStepCostNoteFor,
  variantCreativeIds,
} from "./page-wave2";

function ready(
  creativeId: string,
  extra: Record<string, unknown> = {},
): IdeaEventCardData {
  return {
    kind: "creative-ready",
    creativeId,
    status: "IN_REVIEW",
    title: creativeId,
    ...extra,
  } as unknown as IdeaEventCardData;
}

const ALT = [{ assetId: "a1" }];

describe("variantCreativeIds", () => {
  it("collects only creative-ready cards that carry alternatives", () => {
    const ids = variantCreativeIds([
      ready("c1", { alternatives: ALT }),
      ready("c2"),
      ready("c3", { alternatives: [] }),
      { kind: "creative-failed", taskId: "t", title: "x" },
      undefined,
    ]);
    expect([...ids]).toEqual(["c1"]);
  });

  it("ignores an archived (older) card", () => {
    expect(
      variantCreativeIds([
        ready("c1", { alternatives: ALT, status: "ARCHIVED" }),
      ]).size,
    ).toBe(0);
  });
});

function item(
  id: string,
  planId: string,
  channel: JourneyItem["channel"],
  stage: JourneyItem["stage"] = "PLANNED",
  date = "2026-10-01",
): JourneyItem {
  return { id, planId, stage, channel, publish: "manual", date, title: id };
}

function journey(items: JourneyItem[]): JourneySnapshot {
  return {
    today: "2026-10-01",
    items,
    connections: {},
    publishScheduleEnabled: false,
    results: [],
  };
}

function produce(planId: string, count: number): NextStep {
  return {
    key: `produce-${planId}`,
    tone: "next",
    label: `Produce ${count}`,
    title: `${count} pieces are waiting to be made.`,
    action: { kind: "produce_plan", planId, count },
  };
}

describe("nextStepCostNoteFor", () => {
  it("counts the Instagram pieces of the right plan", () => {
    const snap = journey([
      item("a", "p1", "instagram"),
      item("b", "p1", "instagram"),
      item("c", "p1", "instagram"),
      item("d", "p2", "instagram"),
    ]);
    expect(nextStepCostNoteFor(snap, [produce("p1", 3)])).toBe("about $0.24");
  });

  it("only prices the first `count` pieces and skips already made ones", () => {
    const snap = journey([
      item("a", "p1", "instagram", "PLANNED", "2026-10-01"),
      item("b", "p1", "instagram", "IN_REVIEW", "2026-10-02"),
      item("c", "p1", "instagram", "FAILED", "2026-10-03"),
    ]);
    expect(nextStepCostNoteFor(snap, [produce("p1", 1)])).toBe("about $0.08");
  });

  it("is undefined for a text-only plan", () => {
    const snap = journey([item("a", "p1", "linkedin"), item("b", "p1", "seo")]);
    expect(nextStepCostNoteFor(snap, [produce("p1", 2)])).toBeUndefined();
  });

  it("is undefined when the top step does not produce, or without a journey", () => {
    const snap = journey([item("a", "p1", "instagram")]);
    const review: NextStep = {
      key: "r",
      tone: "next",
      label: "Review",
      title: "t",
      action: { kind: "review_queue", creativeId: "c", count: 1 },
    };
    expect(
      nextStepCostNoteFor(snap, [review, produce("p1", 1)]),
    ).toBeUndefined();
    expect(nextStepCostNoteFor(null, [produce("p1", 1)])).toBeUndefined();
    expect(nextStepCostNoteFor(snap, [])).toBeUndefined();
  });
});

describe("briefFactsFor", () => {
  const base = {
    projectId: "p1",
    today: "2026-10-01",
    timezone: "Europe/Istanbul",
    now: new Date("2026-10-01T09:30:00Z"),
    connections: {},
    hasAnalytics: true,
    extras: {
      todayItems: [],
      yesterdayPublished: 1,
      yesterdayFailed: 0,
      shortlistedIdeas: 2,
    },
    channelsWithoutWork: [] as never[],
  };

  it("carries the project-timezone clock and the project-wide journey's cost", () => {
    const snap = journey([item("a", "p1", "instagram")]);
    const facts = briefFactsFor({
      ...base,
      journey: snap,
      nextSteps: [produce("p1", 1)],
      goalTitle: "Patient enquiries",
    });
    // 09:30Z is 12:30 in Istanbul (UTC+3).
    expect(facts.nowLocalTime).toBe("12:30");
    expect(facts.nextStepCostNote).toBe("about $0.08");
    expect(facts.goalTitle).toBe("Patient enquiries");
    expect(facts.yesterdayPublished).toBe(1);
    expect(facts.shortlistedIdeas).toBe(2);
  });

  it("leaves a quiet step out of Next and omits empty optionals", () => {
    const quiet: NextStep = { ...produce("p1", 1), quiet: true };
    const facts = briefFactsFor({
      ...base,
      journey: null,
      nextSteps: [quiet],
    });
    expect(facts.nextSteps).toEqual([]);
    expect("nextStepCostNote" in facts).toBe(false);
    expect("goalTitle" in facts).toBe(false);
  });

  it("falls back to an empty clock for an unreadable zone", () => {
    const facts = briefFactsFor({
      ...base,
      timezone: "Not/AZone",
      journey: null,
      nextSteps: [],
    });
    expect(facts.nowLocalTime).toBe("");
  });
});

describe("dayStartIso", () => {
  it("is local midnight of the project's day", () => {
    expect(dayStartIso("2026-10-01", "Europe/Istanbul")).toBe(
      "2026-09-30T21:00:00.000Z",
    );
  });
});

describe("approvalIdOfCard", () => {
  it("reads the approval a card already offers", () => {
    expect(approvalIdOfCard(ready("c1", { approvalId: "ap1" }))).toBe("ap1");
    expect(approvalIdOfCard(ready("c1"))).toBeUndefined();
    expect(approvalIdOfCard(undefined)).toBeUndefined();
  });

  it("reads the proposal of the ads card", () => {
    const card = {
      kind: "ads-insight",
      state: "ok",
      chips: [],
      proposal: { approvalId: "ap9", taskId: "t9" },
    } as unknown as IdeaEventCardData;
    expect(approvalIdOfCard(card)).toBe("ap9");
  });
});
