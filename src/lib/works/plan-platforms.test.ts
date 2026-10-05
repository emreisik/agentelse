import { describe, expect, it } from "vitest";

import {
  deliveriesOfPlan,
  expandForPlatforms,
  groupPosts,
  nextSkipFormats,
  piecesOfPlan,
  postKeyOf,
  withInstagramStories,
  withSkipFormats,
  type PlanLikeItem,
} from "./plan-platforms";

// A draft's general post: one idea on one day, drawn for Instagram.
function post(over: Partial<PlanLikeItem> = {}): PlanLikeItem {
  return {
    date: "2026-10-05",
    time: "12:00",
    channel: "instagram",
    formatKey: "instagram.post",
    topic: "Launch day",
    captionIdea: "Show the product in use.",
    ...over,
  };
}

// "channel:format" of each piece, in order.
const shape = (items: readonly PlanLikeItem[]) =>
  items.map((item) => `${item.channel}:${item.formatKey}`);

// Instagram + Facebook with the Story switch on: three deliveries per post.
const PLAN = { platforms: ["instagram", "facebook"], instagramStory: true };

describe("piecesOfPlan: a post's deliveries, less what it leaves out", () => {
  it("makes every delivery of a post when nothing is left out", () => {
    expect(shape(piecesOfPlan({ ...PLAN, items: [post()] }))).toEqual([
      "instagram:instagram.post",
      "instagram:instagram.story",
      "facebook:facebook.post",
    ]);
  });

  it("never makes a delivery whose format the post leaves out", () => {
    expect(
      shape(
        piecesOfPlan({
          ...PLAN,
          items: [post({ skipFormats: ["instagram.story"] })],
        }),
      ),
    ).toEqual(["instagram:instagram.post", "facebook:facebook.post"]);
    expect(
      shape(
        piecesOfPlan({
          ...PLAN,
          items: [post({ skipFormats: ["facebook.post"] })],
        }),
      ),
    ).toEqual(["instagram:instagram.post", "instagram:instagram.story"]);
  });

  it("the skip list travels with the general item into each platform's copy and its Story", () => {
    const general = post({ skipFormats: ["facebook.post"] });
    const copies = expandForPlatforms([general], ["instagram", "facebook"]);
    expect(copies.map((copy) => copy.skipFormats)).toEqual([
      ["facebook.post"],
      ["facebook.post"],
    ]);
    expect(withInstagramStories([general])[1]).toMatchObject({
      formatKey: "instagram.story",
      skipFormats: ["facebook.post"],
    });
  });

  it("a post can leave its Instagram post out and keep the Story made from its picture", () => {
    expect(
      shape(
        piecesOfPlan({
          ...PLAN,
          items: [post({ skipFormats: ["instagram.post"] })],
        }),
      ),
    ).toEqual(["instagram:instagram.story", "facebook:facebook.post"]);
  });

  it("leaves the plan's other posts as they are", () => {
    const items = [
      post({ skipFormats: ["facebook.post"] }),
      post({ date: "2026-10-07", topic: "Second post" }),
    ];
    expect(shape(piecesOfPlan({ ...PLAN, items }))).toEqual([
      "instagram:instagram.post",
      "instagram:instagram.story",
      "instagram:instagram.post",
      "instagram:instagram.story",
      "facebook:facebook.post",
    ]);
  });

  it("without a platform choice each item keeps its channel and can still be left out", () => {
    const items = [
      post({ skipFormats: ["linkedin.post"] }),
      post({
        channel: "linkedin",
        formatKey: "linkedin.post",
        skipFormats: ["linkedin.post"],
      }),
    ];
    expect(shape(piecesOfPlan({ items }))).toEqual([
      "instagram:instagram.post",
    ]);
  });

  it("a list that would leave a post with nothing is not in force", () => {
    // Facebook was unticked after the Instagram post was left out.
    const items = [post({ skipFormats: ["instagram.post"] })];
    expect(shape(piecesOfPlan({ platforms: ["instagram"], items }))).toEqual([
      "instagram:instagram.post",
    ]);
  });
});

describe("deliveriesOfPlan: what saving could make, the left-out ones marked", () => {
  it("marks each delivery the post leaves out (the draft shows it faded)", () => {
    const deliveries = deliveriesOfPlan({
      ...PLAN,
      items: [post({ skipFormats: ["instagram.story"] })],
    });
    expect(
      deliveries.map((delivery) => [delivery.item.formatKey, delivery.skipped]),
    ).toEqual([
      ["instagram.post", false],
      ["instagram.story", true],
      ["facebook.post", false],
    ]);
  });

  it("marks nothing of a post whose list would leave it empty", () => {
    const deliveries = deliveriesOfPlan({
      platforms: ["instagram"],
      instagramStory: true,
      items: [post({ skipFormats: ["instagram.post", "instagram.story"] })],
    });
    expect(deliveries.map((delivery) => delivery.skipped)).toEqual([
      false,
      false,
    ]);
  });
});

describe("nextSkipFormats: a draft post's channel left out or taken back in", () => {
  it("adds the format to the list every item of the post carries", () => {
    expect(nextSkipFormats([post()], PLAN, "facebook.post", true)).toEqual({
      ok: true,
      skipFormats: ["facebook.post"],
    });
  });

  it("takes a format back in, the rest in catalog order", () => {
    const items = [post({ skipFormats: ["facebook.post", "instagram.story"] })];
    expect(nextSkipFormats(items, PLAN, "instagram.story", false)).toEqual({
      ok: true,
      skipFormats: ["facebook.post"],
    });
    expect(nextSkipFormats(items, PLAN, "facebook.post", false)).toEqual({
      ok: true,
      skipFormats: ["instagram.story"],
    });
  });

  it("a post keeps at least one delivery", () => {
    const items = [post({ skipFormats: ["instagram.story", "facebook.post"] })];
    expect(nextSkipFormats(items, PLAN, "instagram.post", true)).toEqual({
      ok: false,
      reason: "LAST",
    });
    expect(
      nextSkipFormats(
        [post()],
        { platforms: ["instagram"] },
        "instagram.post",
        true,
      ),
    ).toEqual({ ok: false, reason: "LAST" });
  });

  it("refuses a format the post is not made in", () => {
    expect(nextSkipFormats([post()], PLAN, "linkedin.post", true)).toEqual({
      ok: false,
      reason: "UNKNOWN",
    });
    // No Story without the switch.
    expect(
      nextSkipFormats(
        [post()],
        { platforms: ["instagram", "facebook"] },
        "instagram.story",
        true,
      ),
    ).toEqual({ ok: false, reason: "UNKNOWN" });
  });

  it("keeps a format the post is not made in right now, for when its platform comes back", () => {
    const items = [post({ skipFormats: ["facebook.post"] })];
    expect(
      nextSkipFormats(
        items,
        { platforms: ["instagram"], instagramStory: true },
        "instagram.story",
        true,
      ),
    ).toEqual({ ok: true, skipFormats: ["instagram.story", "facebook.post"] });
  });

  it("a list that is not in force counts as empty", () => {
    const items = [
      post({ skipFormats: ["instagram.post", "instagram.story"] }),
    ];
    expect(
      nextSkipFormats(
        items,
        { platforms: ["instagram"], instagramStory: true },
        "instagram.story",
        true,
      ),
    ).toEqual({ ok: true, skipFormats: ["instagram.story"] });
  });
});

describe("withSkipFormats", () => {
  it("sets the list, and drops the field once it is empty", () => {
    const plain = post();
    expect(withSkipFormats(plain, ["facebook.post"]).skipFormats).toEqual([
      "facebook.post",
    ]);
    const listed = post({ skipFormats: ["facebook.post"] });
    expect("skipFormats" in withSkipFormats(listed, [])).toBe(false);
    // Nothing to drop: the same item.
    expect(withSkipFormats(plain, [])).toBe(plain);
  });
});

describe("groupPosts: one card per post", () => {
  it("a draft's items that share a day, a time and an idea are one post", () => {
    const items = [
      post(),
      post({ channel: "facebook", formatKey: "facebook.post" }),
      post({ date: "2026-10-07", topic: "Second post" }),
      post({ date: "2026-10-08", topic: "Removed", removed: true }),
    ];
    const posts = groupPosts(items);
    expect(posts.map((entry) => [entry.key, entry.indices])).toEqual([
      [postKeyOf(items[0]!), [0, 1]],
      [postKeyOf(items[2]!), [2]],
    ]);
    expect(posts[0]?.postId).toBeUndefined();
  });

  it("a saved plan's deliveries of one Post are one post whatever day a channel says", () => {
    const items = [
      post(),
      post({
        channel: "facebook",
        formatKey: "facebook.post",
        date: "2026-10-06",
      }),
      post({ date: "2026-10-07", topic: "Older plan" }),
    ];
    const postIds = ["p1", "p1", undefined];
    const posts = groupPosts(items, (index) => postIds[index]);
    expect(
      posts.map((entry) => [entry.key, entry.postId, entry.indices]),
    ).toEqual([
      ["p1", "p1", [0, 1]],
      // Saved before posts existed: named by its day, time and idea.
      [postKeyOf(items[2]!), undefined, [2]],
    ]);
  });
});
