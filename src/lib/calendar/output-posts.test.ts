import { describe, expect, it } from "vitest";

import { EMPTY_OUTPUT_FILTER, type OutputFilter } from "@/lib/outputs/panel";

import {
  applyDecision,
  assetsOf,
  countOutputEntries,
  decisionOf,
  filterOutputEntries,
  groupOutputs,
  postPhaseOf,
  sortOutputEntries,
  type OutputDelivery,
} from "./output-posts";
import { sourceOf } from "./source";

function delivery(overrides: Partial<OutputDelivery> = {}): OutputDelivery {
  return {
    id: "c1",
    postId: "post-1",
    title: "Autumn launch",
    preview: "New season, new colours",
    text: "New season, new colours",
    status: "IN_REVIEW",
    phase: "review",
    kind: "post",
    label: "Instagram · Post",
    source: sourceOf("instagram", null),
    assetId: "a1",
    version: 1,
    approvalId: "ap1",
    createdAt: "2026-10-04T08:00:00.000Z",
    updatedAt: "2026-10-04T08:00:00.000Z",
    scheduledFor: null,
    scheduledLocal: null,
    ...overrides,
  };
}

// One idea, one post, delivered to three channels (made in plan order).
const igPost = delivery();
const igStory = delivery({
  id: "c2",
  kind: "story",
  label: "Instagram · Story",
  assetId: "a2",
  approvalId: "ap2",
  createdAt: "2026-10-04T08:00:00.001Z",
});
const fbPost = delivery({
  id: "c3",
  label: "Facebook · Post",
  source: sourceOf("facebook", null),
  assetId: "a3",
  approvalId: "ap3",
  createdAt: "2026-10-04T08:00:00.002Z",
  updatedAt: "2026-10-04T09:30:00.000Z",
});
// A piece made before posts existed: a card of its own.
const legacy = delivery({
  id: "c9",
  postId: null,
  title: "Spring teaser",
  kind: "reel",
  label: "TikTok · Video",
  source: sourceOf("tiktok", null),
  assetId: null,
  approvalId: "ap9",
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
});

// The server lists newest first.
const listed = [fbPost, igStory, igPost, legacy];

function filter(overrides: Partial<OutputFilter>): OutputFilter {
  return { ...EMPTY_OUTPUT_FILTER, ...overrides };
}

describe("groupOutputs", () => {
  it("makes one card of a post's three channels, its first-made channel leading", () => {
    const entries = groupOutputs(listed);
    expect(entries.map((entry) => entry.id)).toEqual(["c1", "c9"]);

    const [post] = entries;
    expect(post?.deliveries.map((d) => d.id)).toEqual(["c1", "c2", "c3"]);
    expect(post?.label).toBe("Instagram · Post +2");
    expect(post?.phase).toBe("review");
    expect(post?.approvalId).toBe("ap1");
    // The post changed when any of its channels did.
    expect(post?.updatedAt).toBe("2026-10-04T09:30:00.000Z");
    expect(entries[1]?.deliveries).toEqual([legacy]);
  });

  it("shows the post's picture even when its first channel is text only", () => {
    const [post] = groupOutputs([
      igStory,
      delivery({ assetId: null, kind: "text", label: "Instagram · Text" }),
    ]);
    expect(post?.assetId).toBe("a2");
  });

  it("has nothing to approve while a channel still needs its content", () => {
    const draftStory = {
      ...igStory,
      status: "DRAFT" as const,
      phase: "draft" as const,
      approvalId: null,
    };
    const [post] = groupOutputs([fbPost, draftStory, igPost]);
    expect(post?.phase).toBe("draft");
    expect(post?.approvalId).toBeNull();
    expect(post && decisionOf(post, "APPROVED")).toBeNull();
  });
});

describe("postPhaseOf", () => {
  it("shows the channel furthest behind", () => {
    expect(postPhaseOf(["published", "review", "scheduled"])).toBe("review");
    expect(postPhaseOf(["review", "rejected"])).toBe("rejected");
    expect(postPhaseOf(["approved", "draft"])).toBe("draft");
    expect(postPhaseOf(["scheduled", "published"])).toBe("scheduled");
    expect(postPhaseOf([])).toBe("draft");
  });
});

describe("filters and counts", () => {
  const entries = groupOutputs(listed);

  it("shows a post when any of its channels matches", () => {
    const ids = (f: OutputFilter) =>
      filterOutputEntries(entries, f).map((entry) => entry.id);
    expect(ids(filter({ sources: new Set(["facebook"]) }))).toEqual(["c1"]);
    expect(ids(filter({ kinds: new Set(["story"]) }))).toEqual(["c1"]);
    expect(ids(filter({ query: "facebook" }))).toEqual(["c1"]);
    expect(ids(filter({ phases: new Set(["review"]) }))).toEqual(["c1", "c9"]);
  });

  it("counts a post once per value, whatever its number of channels", () => {
    const sources = countOutputEntries(
      entries,
      EMPTY_OUTPUT_FILTER,
      "sources",
      (d) => d.source.key,
    );
    expect(Object.fromEntries(sources)).toEqual({
      instagram: 1,
      facebook: 1,
      tiktok: 1,
    });
    const kinds = countOutputEntries(
      entries,
      EMPTY_OUTPUT_FILTER,
      "kinds",
      (d) => d.kind,
    );
    expect(Object.fromEntries(kinds)).toEqual({ post: 1, story: 1, reel: 1 });
  });

  it("counts a strip against every filter but its own", () => {
    const onFacebook = filter({ sources: new Set(["facebook"]) });
    const sources = countOutputEntries(
      entries,
      onFacebook,
      "sources",
      (d) => d.source.key,
    );
    expect(sources.get("tiktok")).toBe(1);
    const phases = countOutputEntries(
      entries,
      onFacebook,
      "phases",
      (d) => d.phase,
    );
    expect(Object.fromEntries(phases)).toEqual({ review: 1 });
  });

  it("sorts cards, not channels", () => {
    const oldest = sortOutputEntries(entries, "oldest");
    expect(oldest.map((entry) => entry.id)).toEqual(["c9", "c1"]);
    expect(oldest[1]?.deliveries).toHaveLength(3);
    const changed = sortOutputEntries(entries, "updated");
    expect(changed.map((entry) => entry.id)).toEqual(["c1", "c9"]);
  });
});

describe("assetsOf", () => {
  it("downloads every channel's own picture once", () => {
    const [post] = groupOutputs([
      ...listed,
      delivery({ id: "c4", assetId: "a1", createdAt: "2026-10-04T08:00:01Z" }),
    ]);
    expect(post && assetsOf(post)).toEqual(["a1", "a2", "a3"]);
    const [, single] = groupOutputs(listed);
    expect(single && assetsOf(single)).toEqual([]);
  });
});

describe("decisionOf", () => {
  const [post, single] = groupOutputs(listed);

  it("approves a post as a whole and a piece without a post on its own", () => {
    expect(post && decisionOf(post, "APPROVED")).toEqual({
      kind: "approve-post",
      postId: "post-1",
    });
    expect(single && decisionOf(single, "APPROVED")).toEqual({
      kind: "approve",
      approvalId: "ap9",
    });
  });

  it("declines one channel at a time", () => {
    expect(post && decisionOf(post, "REJECTED")).toBeNull();
    expect(single && decisionOf(single, "REJECTED")).toEqual({
      kind: "reject",
      approvalId: "ap9",
    });
    const [oneChannel] = groupOutputs([igPost]);
    expect(oneChannel && decisionOf(oneChannel, "REJECTED")).toEqual({
      kind: "reject",
      approvalId: "ap1",
    });
  });
});

describe("applyDecision", () => {
  it("moves every waiting channel of the post on, and nothing else", () => {
    const scheduledFb = { ...fbPost, scheduledFor: "2026-10-07T07:00:00.000Z" };
    const items = [scheduledFb, igStory, igPost, legacy];
    const [post] = groupOutputs(items);
    const next = post ? applyDecision(items, post, "APPROVED") : items;
    expect(
      next.map((item) => [item.id, item.status, item.phase, item.approvalId]),
    ).toEqual([
      ["c3", "APPROVED", "scheduled", null],
      ["c2", "APPROVED", "approved", null],
      ["c1", "APPROVED", "approved", null],
      ["c9", "IN_REVIEW", "review", "ap9"],
    ]);
  });
});
