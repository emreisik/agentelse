import { describe, expect, it, vi } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

import {
  MAX_DAYS_AHEAD,
  approachOf,
  canMovePost,
  canOpenStep,
  canPlanPublishing,
  dayNumberOf,
  formatDay,
  formatLineOf,
  moveDayChips,
  movePieces,
  nextSuggestion,
  pieceOf,
  piecesToMove,
  postStateOf,
  progressOf,
  rangeLabel,
  stepOf,
  stepStates,
  weekDays,
  weekdayOf,
  zoneName,
  type PieceView,
} from "./plan-pane";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

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
        formatKey: "instagram.carousel",
        topic: "How the unique offer works",
        captionIdea: "Explain the idea with a simple example.",
      },
    ],
    ...over,
  };
}

const saved = (
  stages: ("PLANNED" | "PRODUCING" | "FAILED" | "IN_REVIEW" | "REJECTED" | "APPROVED" | "PUBLISHED" | null)[],
) =>
  plan({
    state: "saved",
    slots: stages.map((stage, i) => (stage ? { id: `c${i}`, stage } : null)),
  });

describe("progressOf and the three steps", () => {
  it("a draft is at the plan step and nothing else opens", () => {
    const progress = progressOf(plan());
    expect(progress.draft).toBe(true);
    expect(stepOf(progress)).toBe("plan");
    expect(canOpenStep("plan", progress)).toBe(true);
    expect(canOpenStep("content", progress)).toBe(false);
    expect(canOpenStep("publish", progress)).toBe(false);
  });

  it("counts the pieces of a saved plan by what they wait for", () => {
    const progress = progressOf(
      saved(["PLANNED", "FAILED", "PRODUCING", "IN_REVIEW", "APPROVED", "PUBLISHED", null]),
    );
    expect(progress).toEqual({
      draft: false,
      total: 6,
      producible: 2,
      making: 1,
      ready: 1,
      approved: 2,
      allApproved: false,
    });
    expect(stepOf(progress)).toBe("content");
  });

  it("publishing can be planned once something is ready and nothing is being made", () => {
    expect(canPlanPublishing(progressOf(saved(["IN_REVIEW", "PLANNED"])))).toBe(true);
    expect(canPlanPublishing(progressOf(saved(["IN_REVIEW", "PRODUCING"])))).toBe(false);
    expect(canPlanPublishing(progressOf(saved(["PLANNED", "PLANNED"])))).toBe(false);
    expect(canPlanPublishing(progressOf(plan()))).toBe(false);
    const open = progressOf(saved(["IN_REVIEW", "PLANNED"]));
    expect(canOpenStep("content", open)).toBe(true);
    expect(canOpenStep("publish", open)).toBe(true);
    expect(canOpenStep("publish", progressOf(saved(["PLANNED"])))).toBe(false);
  });

  it("everything decided is the last step and all three are done", () => {
    const progress = progressOf(saved(["APPROVED", "PUBLISHED"]));
    expect(progress.allApproved).toBe(true);
    expect(stepOf(progress)).toBe("publish");
    expect(stepStates("publish", progress)).toEqual({
      plan: "done",
      content: "done",
      publish: "done",
    });
    expect(canOpenStep("publish", progress)).toBe(true);
  });

  it("the open step is current, the ones behind the furthest are done", () => {
    const draft = progressOf(plan());
    expect(stepStates("plan", draft)).toEqual({
      plan: "current",
      content: "todo",
      publish: "todo",
    });
    const made = progressOf(saved(["IN_REVIEW"]));
    expect(stepStates("content", made)).toEqual({
      plan: "done",
      content: "current",
      publish: "todo",
    });
    expect(stepStates("publish", made)).toEqual({
      plan: "done",
      content: "done",
      publish: "current",
    });
    // Back to the plan after saving: the plan is open, the rest still ahead.
    expect(stepStates("plan", made)).toEqual({
      plan: "current",
      content: "todo",
      publish: "todo",
    });
  });
});

describe("postStateOf", () => {
  it("a post with no slots is an idea", () => {
    expect(postStateOf([])).toBe("idea");
    expect(postStateOf([undefined, null])).toBe("idea");
  });

  it("shows the piece that needs attention first", () => {
    expect(postStateOf(["IN_REVIEW", "PRODUCING"])).toBe("making");
    expect(postStateOf(["IN_REVIEW", "FAILED"])).toBe("failed");
    expect(postStateOf(["IN_REVIEW", "PLANNED"])).toBe("needs");
    expect(postStateOf(["IN_REVIEW", "REJECTED"])).toBe("declined");
  });

  it("ready, scheduled and published", () => {
    expect(postStateOf(["IN_REVIEW", "APPROVED"])).toBe("ready");
    expect(postStateOf(["APPROVED", "APPROVED"])).toBe("scheduled");
    expect(postStateOf(["APPROVED", "PUBLISHED"])).toBe("scheduled");
    expect(postStateOf(["PUBLISHED", "PUBLISHED"])).toBe("published");
  });
});

describe("pieceOf", () => {
  it("carries the slot of the same position with its text and time", () => {
    const card = plan({
      state: "saved",
      items: [
        plan().items[0]!,
        { ...plan().items[0]!, channel: "linkedin", formatKey: "linkedin.post" },
      ],
      slots: [
        { id: "c0", stage: "IN_REVIEW", assetId: "a1", text: "Hello", when: "2026-10-05T12:00" },
        null,
      ],
    });
    expect(pieceOf(card, card.items[0]!, 0, "instagram")).toEqual({
      index: 0,
      channel: "instagram",
      formatKey: "instagram.carousel",
      creativeId: "c0",
      stage: "IN_REVIEW",
      assetId: "a1",
      text: "Hello",
      when: "2026-10-05T12:00",
    });
    // A gone slot (null) is a piece with nothing behind it.
    expect(pieceOf(card, card.items[1]!, 1, "linkedin")).toEqual({
      index: 1,
      channel: "linkedin",
      formatKey: "linkedin.post",
    });
  });
});

describe("formats in plain words", () => {
  it("names the format and, for a picture or a video, its shape", () => {
    // The catalog's picture standard is 3:4 (Story and video 9:16).
    expect(formatLineOf("instagram", "instagram.carousel")).toBe("Carousel · 3:4");
    expect(formatLineOf("instagram", "instagram.story")).toBe("Story · 9:16");
    expect(formatLineOf("tiktok", "tiktok.video")).toBe("Video · 9:16");
    // Written posts have no shape.
    expect(formatLineOf("linkedin", "linkedin.post")).toBe("Post");
    expect(formatLineOf("x", "x.thread")).toBe("Thread");
  });

  it("falls back to the channel's first format", () => {
    expect(formatLineOf("instagram")).toBe("Post · 3:4");
    expect(formatLineOf("instagram", "instagram.nope")).toBe("Post · 3:4");
  });

  it("says how each format is made, truthfully", () => {
    expect(approachOf("instagram", "instagram.carousel")).toContain("cover picture");
    expect(approachOf("instagram", "instagram.reel")).toContain("script");
    expect(approachOf("x", "x.post")).toContain("280");
    expect(approachOf("linkedin")).toContain("written post");
    // The first format of a channel when none is named.
    expect(approachOf("tiktok")).toContain("2 seconds");
    expect(approachOf("seo", "seo.article")).toBeUndefined();
  });
});

describe("dates", () => {
  it("a range reads as one line", () => {
    expect(rangeLabel(["2026-10-11", "2026-10-05", "2026-10-07"])).toBe("Oct 5 – 11, 2026");
    expect(rangeLabel(["2026-10-29", "2026-11-04"])).toBe("Oct 29 – Nov 4, 2026");
    expect(rangeLabel(["2026-12-30", "2027-01-02"])).toBe("Dec 30, 2026 – Jan 2, 2027");
    expect(rangeLabel(["2026-10-05", "2026-10-05"])).toBe("Oct 5, 2026");
    expect(rangeLabel([])).toBe("");
    expect(rangeLabel(["soon"])).toBe("");
  });

  it("weekday and day number, Monday first", () => {
    expect(weekdayOf("2026-10-05")).toBe("Mon");
    expect(weekdayOf("2026-10-11")).toBe("Sun");
    expect(dayNumberOf("2026-10-05")).toBe("05");
    expect(formatDay("2026-10-05")).toMatch(/^Mon,? 5 Oct$/);
  });

  it("the week of a day, Monday to Sunday", () => {
    expect(weekDays("2026-10-08")).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });

  it("the zone is its city", () => {
    expect(zoneName("Europe/Istanbul")).toBe("Istanbul");
    expect(zoneName("America/New_York")).toBe("New York");
    expect(zoneName(undefined)).toBe("");
  });
});

describe("nextSuggestion: what a tap on New idea does", () => {
  it("shows the first of the post's other ideas, then each one after it", () => {
    expect(nextSuggestion({ pool: 3, current: null, canGenerate: true })).toEqual({
      kind: "show",
      alt: 0,
    });
    expect(nextSuggestion({ pool: 3, current: 0, canGenerate: true })).toEqual({
      kind: "show",
      alt: 1,
    });
    expect(nextSuggestion({ pool: 3, current: 1, canGenerate: false })).toEqual({
      kind: "show",
      alt: 2,
    });
  });

  it("past the last idea it asks for more while that is allowed, else starts over", () => {
    expect(nextSuggestion({ pool: 3, current: 2, canGenerate: true })).toEqual({
      kind: "generate",
      showAlt: 3,
    });
    expect(nextSuggestion({ pool: 3, current: 2, canGenerate: false })).toEqual({
      kind: "show",
      alt: 0,
    });
  });

  it("a post with no other idea asks for some, and shows the first of them", () => {
    expect(nextSuggestion({ pool: 0, current: null, canGenerate: true })).toEqual({
      kind: "generate",
      showAlt: 0,
    });
  });

  it("nothing to show and nothing to ask for is null", () => {
    expect(nextSuggestion({ pool: 0, current: null, canGenerate: false })).toBeNull();
  });
});

describe("moveDayChips: the days offered at the top of the move window", () => {
  it("is the seven days of the post's own week, Monday first, one label each", () => {
    // Today is a Sunday before the plan's week.
    expect(moveDayChips("2026-10-07", "2026-10-04")).toEqual([
      { key: "2026-10-05", label: "Mon 5" },
      { key: "2026-10-06", label: "Tue 6" },
      { key: "2026-10-07", label: "Wed 7" },
      { key: "2026-10-08", label: "Thu 8" },
      { key: "2026-10-09", label: "Fri 9" },
      { key: "2026-10-10", label: "Sat 10" },
      { key: "2026-10-11", label: "Sun 11" },
    ]);
  });

  it("a week that has begun starts today: gone days are not offered", () => {
    const chips = moveDayChips("2026-10-09", "2026-10-07");
    expect(chips.map((chip) => chip.key)).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
    ]);
  });

  it("stops at the plan's horizon", () => {
    const today = "2026-10-04";
    // 60 days ahead is Dec 3, a Thursday: its week is Nov 30 - Dec 6.
    const chips = moveDayChips("2026-12-03", today);
    expect(chips.map((chip) => chip.key)).toEqual([
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
    ]);
    expect(MAX_DAYS_AHEAD).toBe(60);
  });

  it("is empty when no day of the week is left", () => {
    expect(moveDayChips("2027-03-01", "2026-10-04")).toEqual([]);
  });
});

describe("moving a made post", () => {
  const piece = (over: Partial<PieceView> = {}): PieceView => ({
    index: 0,
    channel: "instagram",
    creativeId: "c0",
    stage: "IN_REVIEW",
    when: "2026-10-05T12:00",
    ...over,
  });
  const to = { date: "2026-10-06", time: "18:00" };

  it("a post can move while any piece is waiting, ready, approved or failed", () => {
    for (const stage of ["PLANNED", "IN_REVIEW", "APPROVED", "FAILED"] as const) {
      expect(canMovePost([piece({ stage })]), stage).toBe(true);
    }
  });

  it("not when every piece is being made, out, declined, or has no creative", () => {
    expect(
      canMovePost([
        piece({ stage: "PRODUCING" }),
        piece({ stage: "PUBLISHED" }),
        piece({ stage: "REJECTED" }),
        piece({ creativeId: undefined }),
        undefined,
      ]),
    ).toBe(false);
    expect(canMovePost([])).toBe(false);
  });

  it("one movable piece is enough: the others are left where they are", () => {
    expect(
      canMovePost([piece({ stage: "PUBLISHED" }), piece({ creativeId: "c1" })]),
    ).toBe(true);
    expect(
      piecesToMove(
        [
          piece({ creativeId: "a" }),
          piece({ creativeId: "b", stage: "PUBLISHED" }),
          piece({ creativeId: "c", stage: "PRODUCING" }),
          piece({ creativeId: "d", stage: "APPROVED" }),
        ],
        to,
      ).map((p) => p.creativeId),
    ).toEqual(["a", "d"]);
  });

  it("a piece already at the new day and time is not asked to move", () => {
    const there = piece({ when: "2026-10-06T18:00" });
    expect(piecesToMove([there, piece({ creativeId: "c1" })], to)).toEqual([
      expect.objectContaining({ creativeId: "c1" }),
    ]);
    expect(piecesToMove([there], to)).toEqual([]);
  });

  it("moves the pieces one after the other, each to the new day and time", async () => {
    const order: string[] = [];
    let running = 0;
    const mover = vi.fn(async (id: string) => {
      running += 1;
      expect(running).toBe(1); // never two at once: each rewrites the card
      order.push(id);
      await Promise.resolve();
      running -= 1;
      return { ok: true };
    });

    const result = await movePieces(
      [piece({ creativeId: "a" }), piece({ creativeId: "b" })],
      to,
      mover,
    );

    expect(result).toEqual({ ok: true, moved: 2 });
    expect(order).toEqual(["a", "b"]);
    expect(mover).toHaveBeenNthCalledWith(1, "a", to);
    expect(mover).toHaveBeenNthCalledWith(2, "b", to);
  });

  it("stops at the first piece that fails and says why", async () => {
    const mover = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: "That day has already passed." })
      .mockResolvedValue({ ok: true });

    const result = await movePieces(
      [
        piece({ creativeId: "a" }),
        piece({ creativeId: "b" }),
        piece({ creativeId: "c" }),
      ],
      to,
      mover,
    );

    expect(result).toEqual({
      ok: false,
      moved: 1,
      message: "That day has already passed.",
    });
    expect(mover).toHaveBeenCalledTimes(2);
  });

  it("nothing to move is a success that moved nothing", async () => {
    const mover = vi.fn();
    expect(
      await movePieces([piece({ stage: "PUBLISHED" })], to, mover),
    ).toEqual({ ok: true, moved: 0 });
    expect(mover).not.toHaveBeenCalled();
  });
});
