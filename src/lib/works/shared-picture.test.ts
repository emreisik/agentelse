import { describe, expect, it } from "vitest";

import {
  groupPosts,
  INSTAGRAM_STORY,
  piecesOfPlan,
  withInstagramStories,
} from "./plan-platforms";
import { pictureSources, wholePosts, type PictureSlot } from "./shared-picture";

const post = (
  topic: string,
  channel = "instagram",
  formatKey = "instagram.post",
) => ({
  date: "2026-10-08",
  time: "10:00",
  topic,
  captionIdea: `${topic} idea`,
  channel,
  formatKey,
});

describe("Instagram Story switch", () => {
  it("adds one Story right after each Instagram post", () => {
    const items = withInstagramStories([
      post("A"),
      post("A", "facebook", "facebook.post"),
      post("B"),
    ]);
    expect(items.map((item) => `${item.topic}:${item.formatKey}`)).toEqual([
      "A:instagram.post",
      `A:${INSTAGRAM_STORY}`,
      "A:facebook.post",
      "B:instagram.post",
      `B:${INSTAGRAM_STORY}`,
    ]);
  });

  it("keeps the Story inside its post and never doubles one", () => {
    const items = withInstagramStories([
      post("A"),
      post("A", "instagram", INSTAGRAM_STORY),
    ]);
    expect(items).toHaveLength(2);
    expect(groupPosts(items)).toHaveLength(1);
  });

  it("skips removed posts, reels and other channels", () => {
    const items = withInstagramStories([
      { ...post("A"), removed: true },
      post("B", "instagram", "instagram.reel"),
      post("C", "linkedin", "linkedin.post"),
    ]);
    expect(items).toHaveLength(3);
  });

  it("is part of what a plan saves only when it is on", () => {
    const card = { items: [post("A")], platforms: ["instagram", "facebook"] };
    expect(piecesOfPlan(card)).toHaveLength(2);
    expect(piecesOfPlan({ ...card, instagramStory: true })).toHaveLength(3);
  });
});

const slot = (
  id: string,
  postKey: string,
  extra: Partial<PictureSlot> = {},
): PictureSlot => ({
  id,
  post: postKey,
  image: true,
  producible: true,
  producing: false,
  ...extra,
});

describe("one post, one picture", () => {
  it("lets the post's first image piece render and the others wait for it", () => {
    const slots = [slot("ig", "A"), slot("story", "A"), slot("fb", "A")];
    const sources = pictureSources(["ig", "story", "fb"], slots);
    expect(sources.get("ig")).toEqual({ kind: "render" });
    expect(sources.get("story")).toEqual({ kind: "wait", leadId: "ig" });
    expect(sources.get("fb")).toEqual({ kind: "wait", leadId: "ig" });
  });

  it("adapts a picture that is already made", () => {
    const slots = [
      slot("ig", "A", { producible: false, assetId: "asset-1" }),
      slot("fb", "A", { producible: false, producing: false }),
      slot("story", "A"),
    ];
    expect(pictureSources(["story"], slots).get("story")).toEqual({
      kind: "adapt",
      assetId: "asset-1",
    });
  });

  it("waits for the next run while another run makes the post's picture", () => {
    const slots = [
      slot("ig", "A", { producible: false, producing: true }),
      slot("fb", "A"),
    ];
    expect(pictureSources(["fb"], slots).get("fb")).toEqual({ kind: "skip" });
  });

  it("renders text pieces and posts of their own as before", () => {
    const slots = [
      slot("li", "A", { image: false }),
      slot("ig", "A"),
      slot("other", "B"),
    ];
    const sources = pictureSources(["li", "ig", "other"], slots);
    expect(sources.get("li")).toEqual({ kind: "render" });
    expect(sources.get("ig")).toEqual({ kind: "render" });
    expect(sources.get("other")).toEqual({ kind: "render" });
  });

  it("grows a batch to whole posts, only with pieces that can be made", () => {
    const slots = [
      slot("ig", "A"),
      slot("fb", "A"),
      slot("story", "A", { producible: false }),
      slot("next", "B"),
    ];
    expect(wholePosts(["fb"], slots)).toEqual(["fb", "ig"]);
  });
});
