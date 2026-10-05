import { describe, expect, it } from "vitest";

import { postGroupsOf } from "./post-groups";

const item = (topic: string, channel: string, extra: object = {}) => ({
  date: "2026-10-08",
  time: "10:00",
  topic,
  captionIdea: `${topic} idea`,
  channel,
  ...extra,
});

describe("postGroupsOf", () => {
  it("makes one post of the channel pieces of one idea at one time", () => {
    expect(
      postGroupsOf([
        item("A", "instagram"),
        item("A", "instagram", { formatKey: "instagram.story" }),
        item("A", "facebook"),
        item("B", "instagram"),
      ]),
    ).toEqual([[0, 1, 2], [3]]);
  });

  it("keeps the same idea at another time a post of its own", () => {
    expect(
      postGroupsOf([item("A", "instagram"), item("A", "facebook", { time: "18:00" })]),
    ).toEqual([[0], [1]]);
  });

  it("never lets a removed item join a live post", () => {
    expect(
      postGroupsOf([item("A", "instagram", { removed: true }), item("A", "facebook")]),
    ).toEqual([[0], [1]]);
  });
});
