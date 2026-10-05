import { describe, expect, it } from "vitest";

import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import {
  deliveryNameOf,
  foldPlanPosts,
  leaveOutOf,
  postPrimaryOf,
  postWhenOf,
  readyPostCount,
  slidePictureOf,
  slidePostsOf,
} from "./plan-posts";

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

// ---- a saved plan's posts ----------------------------------------------------

type Plan = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type Slot = NonNullable<NonNullable<Plan["slots"]>[number]>;

// Instagram post + Story + Facebook: three deliveries of every post.
const CHANNELS_OF_POST = [
  { channel: "instagram", formatKey: "instagram.post" },
  { channel: "instagram", formatKey: "instagram.story" },
  { channel: "facebook", formatKey: "facebook.post" },
] as const;

function savedPlan(
  posts: number,
  slotOf: (post: number, at: number) => Partial<Slot> | null = () => ({}),
  over: Partial<Plan> = {},
): Plan {
  const items: Plan["items"] = [];
  const ids: string[] = [];
  const slots: Plan["slots"] = [];
  for (let post = 0; post < posts; post += 1) {
    CHANNELS_OF_POST.forEach((target, at) => {
      const id = `c${post}${at}`;
      items.push({
        date: `2026-10-0${8 + post}`,
        time: "10:00",
        ...target,
        topic: `Idea ${post}`,
        captionIdea: `Caption ${post}`,
      });
      ids.push(id);
      const slot = slotOf(post, at);
      slots.push(
        slot === null
          ? null
          : { id, stage: "PLANNED", postId: `post${post}`, ...slot },
      );
    });
  }
  return {
    kind: "content-plan-draft",
    title: "October",
    timezone: "Europe/Istanbul",
    state: "saved",
    items,
    savedCreativeIds: ids,
    slots,
    ...over,
  };
}

const readyCard = (
  creativeId: string,
  over: Partial<Extract<CreativeCardData, { kind: "creative-ready" }>> = {},
): Extract<CreativeCardData, { kind: "creative-ready" }> => ({
  kind: "creative-ready",
  title: "t",
  creativeId,
  status: "IN_REVIEW",
  ...over,
});

describe("slidePostsOf", () => {
  it("makes one slide per post, its channels as tabs, in plan order", () => {
    const posts = slidePostsOf(savedPlan(3));
    expect(posts.map((post) => post.postId)).toEqual([
      "post0",
      "post1",
      "post2",
    ]);
    for (const post of posts) {
      expect(post.deliveries.map((d) => d.label)).toEqual([
        "Post",
        "Story",
        "Facebook",
      ]);
      expect(post.stages).toEqual(["PLANNED", "PLANNED", "PLANNED"]);
    }
    expect(posts[1]?.deliveries.map((d) => d.id)).toEqual([
      "c10",
      "c11",
      "c12",
    ]);
  });

  it("groups a plan saved before posts by day, time and idea", () => {
    const posts = slidePostsOf(
      savedPlan(2, () => ({ postId: undefined })),
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]?.postId).toBeUndefined();
    expect(posts[0]?.key).toBe("2026-10-08|10:00|Idea 0");
    expect(posts[0]?.deliveries).toHaveLength(3);
  });

  it("skips removed items and gone pieces, keeps a left-out channel as a tab", () => {
    const plan = savedPlan(2, (post, at) =>
      post === 0 && at === 2
        ? null
        : post === 1 && at === 1
          ? { excluded: true }
          : {},
    );
    plan.items[0] = { ...plan.items[0]!, removed: true };
    const posts = slidePostsOf(plan);
    // Its only tab left: the channel's name (no Instagram twin beside it).
    expect(posts[0]?.deliveries.map((d) => d.label)).toEqual(["Instagram"]);
    expect(posts[1]?.deliveries.map((d) => d.excluded)).toEqual([
      false,
      true,
      false,
    ]);
    // A left-out channel is not part of the post's stages.
    expect(posts[1]?.stages).toHaveLength(2);
  });

  it("reads where each delivery stands: live run first, then its card, then the plan", () => {
    const plan = savedPlan(1, (_post, at) =>
      at === 2 ? { stage: "FAILED" } : {},
    );
    plan.posts = [readyCard("c00", { status: "APPROVED", postId: "post0" })];
    const posts = slidePostsOf(plan, {
      c01: { state: "pending" },
      c02: { state: "done", card: readyCard("c02") },
    });
    expect(posts[0]?.stages).toEqual(["APPROVED", "PRODUCING", "IN_REVIEW"]);
    expect(posts[0]?.deliveries[1]?.making).toEqual({ state: "pending" });
    expect(posts[0]?.deliveries[2]?.card?.creativeId).toBe("c02");
  });

  it("counts ready posts: every channel left in has content", () => {
    const plan = savedPlan(3, (post, at) =>
      post === 0
        ? { stage: "IN_REVIEW" }
        : post === 1
          ? at === 1
            ? { stage: "PLANNED", excluded: true }
            : { stage: "APPROVED" }
          : at === 0
            ? { stage: "PUBLISHED" }
            : {},
    );
    expect(readyPostCount(slidePostsOf(plan))).toBe(2);
  });
});

describe("postPrimaryOf", () => {
  it("offers one main button per state", () => {
    expect(postPrimaryOf(["PLANNED", "PLANNED"])).toEqual({
      kind: "make",
      retry: false,
    });
    expect(postPrimaryOf(["IN_REVIEW", "FAILED"])).toEqual({
      kind: "make",
      retry: true,
    });
    expect(postPrimaryOf(["PRODUCING", "PLANNED"])).toEqual({
      kind: "making",
    });
    expect(postPrimaryOf(["IN_REVIEW", "APPROVED"])).toEqual({
      kind: "approve",
    });
    expect(postPrimaryOf(["APPROVED", "PUBLISHED"])).toBeNull();
    expect(postPrimaryOf(["REJECTED", "IN_REVIEW"])).toBeNull();
    expect(postPrimaryOf([])).toBeNull();
  });
});

describe("leaveOutOf", () => {
  const post = { postId: "p", stages: ["IN_REVIEW", "PLANNED"] as const };

  it("leaves a channel out or takes it back in", () => {
    expect(leaveOutOf({ stage: "PLANNED", excluded: false }, post)).toEqual({
      kind: "leave",
    });
    expect(leaveOutOf({ stage: "PLANNED", excluded: true }, post)).toEqual({
      kind: "include",
    });
  });

  it("blocks a posted channel, one being made and the last one left in", () => {
    expect(leaveOutOf({ stage: "PUBLISHED", excluded: false }, post)).toEqual({
      kind: "leave",
      blocked: "posted",
    });
    expect(
      leaveOutOf({ stage: "PRODUCING", excluded: false }, post)?.blocked,
    ).toBe("making");
    expect(
      leaveOutOf(
        { stage: "IN_REVIEW", excluded: false },
        { postId: "p", stages: ["IN_REVIEW"] },
      )?.blocked,
    ).toBe("last");
  });

  it("offers nothing on a plan saved before posts", () => {
    expect(
      leaveOutOf({ stage: "PLANNED", excluded: false }, { stages: [] }),
    ).toBeNull();
  });
});

describe("slidePictureOf", () => {
  const [post] = slidePostsOf(savedPlan(1));
  const [feed, story] = post!.deliveries;

  it("shows a made picture at its own size", () => {
    expect(
      slidePictureOf({
        ...feed!,
        card: readyCard("c00", {
          assetId: "a1",
          mimeType: "image/png",
          assetWidth: 1080,
          assetHeight: 1440,
        }),
      }),
    ).toEqual({ assetId: "a1", width: 1080, height: 1440 });
  });

  it("frames a picture still to make in its format's shape", () => {
    const frame = slidePictureOf(story!);
    expect(frame?.assetId).toBeUndefined();
    expect((frame?.height ?? 0) / (frame?.width ?? 1)).toBeCloseTo(16 / 9);
  });

  it("has no picture for a written delivery", () => {
    const [written] = slidePostsOf(
      savedPlan(1, () => ({}), {
        items: [
          {
            date: "2026-10-08",
            time: "10:00",
            channel: "linkedin",
            formatKey: "linkedin.post",
            topic: "Idea",
            captionIdea: "c",
          },
        ],
        savedCreativeIds: ["l1"],
        slots: [{ id: "l1", stage: "PLANNED", postId: "pl" }],
      }),
    );
    expect(slidePictureOf(written!.deliveries[0]!)).toBeNull();
    // A made Reel is its script: no empty frame.
    expect(
      slidePictureOf({
        ...feed!,
        card: readyCard("c00", { caption: "Script", assetId: undefined }),
      }),
    ).toBeNull();
  });
});

describe("postWhenOf / deliveryNameOf", () => {
  it("reads the post's time from its first channel left in, live time first", () => {
    const [post] = slidePostsOf(
      savedPlan(1, (_post, at) =>
        at === 0 ? { excluded: true } : { when: "2026-10-09T18:30" },
      ),
    );
    expect(postWhenOf(post!.deliveries)).toBe("Fri 9 Oct, 18:30");
    expect(postWhenOf([])).toBe("");
  });

  it("names a delivery in full", () => {
    const [post] = slidePostsOf(savedPlan(1));
    expect(post!.deliveries.map(deliveryNameOf)).toEqual([
      "Instagram Post",
      "Instagram Story",
      "Facebook",
    ]);
  });
});
