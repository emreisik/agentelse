import { describe, expect, it } from "vitest";

import {
  CARDS_THAT_KEEP_TEXT,
  cardKinds,
  type IdeaEventCardData,
} from "@/types/idea-event-card";

import { appendStreamText, cardTextHidden, pendingCard } from "./card-text";

const ofKind = (kind: string) => ({ kind }) as unknown as IdeaEventCardData;

type Via = "idea" | "master" | "suggestion" | "brief" | "generate" | "options";

const plan = (via?: Via) =>
  ({
    kind: "content-plan-draft",
    title: "Week plan",
    timezone: "UTC",
    state: "draft",
    items: [],
    ...(via ? { via } : {}),
  }) as IdeaEventCardData;

describe("cardTextHidden", () => {
  it("is the old rule for every kind when not in a Work", () => {
    for (const kind of cardKinds()) {
      expect(cardTextHidden(ofKind(kind), false)).toBe(
        !CARDS_THAT_KEEP_TEXT.has(kind),
      );
    }
    // A plan with via keeps its text outside a Work.
    expect(cardTextHidden(plan("idea"), false)).toBe(false);
    expect(cardTextHidden(undefined, false)).toBe(false);
  });

  it("is the old rule for every kind but a plan with via in a Work", () => {
    for (const kind of cardKinds()) {
      if (kind === "content-plan-draft") continue;
      expect(cardTextHidden(ofKind(kind), true)).toBe(
        !CARDS_THAT_KEEP_TEXT.has(kind),
      );
    }
    expect(cardTextHidden(undefined, true)).toBe(false);
  });

  it("hides a plan that carries via in a Work, whatever the via", () => {
    for (const via of [
      "idea",
      "master",
      "suggestion",
      "brief",
      "generate",
      "options",
    ] as const) {
      expect(cardTextHidden(plan(via), true)).toBe(true);
    }
  });

  it("keeps the text of a plan without via in a Work (propose_content_plan)", () => {
    expect(cardTextHidden(plan(), true)).toBe(false);
  });

  it("keeps the text of every keep-text kind in a Work unless it is a plan with via", () => {
    for (const kind of CARDS_THAT_KEEP_TEXT) {
      expect(cardTextHidden(ofKind(kind), true)).toBe(false);
    }
  });
});

describe("pendingCard", () => {
  it("is null once the turn has a card or text", () => {
    expect(pendingCard({ text: "", card: ofKind("idea") })).toBeNull();
    expect(pendingCard({ text: "Working on it" })).toBeNull();
    expect(pendingCard({ text: "   ", card: ofKind("idea") })).toBeNull();
  });

  it("picks the skeleton from the person's request", () => {
    expect(pendingCard({ text: "" })).toBe("generic");
    expect(pendingCard({ text: "", request: "[Plan brief]\nx" })).toBe("plan");
    expect(pendingCard({ text: "", request: "Give me content ideas" })).toBe(
      "ideas",
    );
    expect(pendingCard({ text: "", request: "hello" })).toBe("generic");
  });
});

describe("appendStreamText", () => {
  it("appends as usual without a Work or without a hiding card", () => {
    expect(appendStreamText("a", "b", undefined, true)).toBe("ab");
    expect(appendStreamText("a", "b", ofKind("idea"), false)).toBe("ab");
    expect(appendStreamText("a", "b", plan(), true)).toBe("ab");
  });

  it("drops text after a card that replaces the reply, only in a Work", () => {
    expect(appendStreamText("a", "b", ofKind("idea"), true)).toBe("a");
    expect(appendStreamText("a", "b", plan("options"), true)).toBe("a");
  });
});
