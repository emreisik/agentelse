import { describe, expect, it } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

import { foldPlanPosts } from "./plan-posts";

const plan = (id: string, ids: string[]) => ({
  commandId: id,
  card: {
    kind: "content-plan-draft",
    title: "p",
    timezone: "UTC",
    state: "saved",
    items: [],
    savedCreativeIds: ids,
  } as IdeaEventCardData,
});
const ready = (commandId: string, creativeId: string, extra: object = {}) => ({
  commandId,
  card: {
    kind: "creative-ready",
    title: "t",
    creativeId,
    status: "IN_REVIEW",
    ...extra,
  } as IdeaEventCardData,
});

describe("foldPlanPosts", () => {
  it("moves a plan's pieces into the plan card, newest card first-class", () => {
    const out = foldPlanPosts(
      [
        plan("plan", ["a", "b"]),
        ready("r1", "a", { status: "ARCHIVED" }),
        ready("r2", "a", { caption: "new" }),
        ready("r3", "b", { planId: "plan" }),
        ready("r4", "other"),
        {
          commandId: "l1",
          card: { kind: "creative-loading", taskId: "t1", title: "x" },
        },
        {
          commandId: "l2",
          card: { kind: "creative-loading", taskId: "t2", title: "x" },
        },
      ],
      new Map([["t1", "plan"]]),
    );
    expect(out.map((t) => t.commandId)).toEqual(["plan", "r4", "l2"]);
    const card = out[0]!.card;
    expect(card?.kind === "content-plan-draft" && card.posts).toEqual([
      expect.objectContaining({ creativeId: "a", caption: "new" }),
      expect.objectContaining({ creativeId: "b" }),
    ]);
  });

  it("leaves the chat as it is without a saved plan", () => {
    const turns = [ready("r1", "a", { planId: "gone" })];
    expect(foldPlanPosts(turns, new Map())).toEqual(turns);
  });
});
