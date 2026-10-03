import { describe, expect, it } from "vitest";

import {
  DISLIKE_REASONS,
  MAX_RATING_NOTE_CHARS,
  cleanReasons,
  creativeName,
  designDigestOf,
  isDislikeReason,
  ratingInsight,
} from "./creative-rating";

describe("cleanReasons", () => {
  it("keeps known reasons once each, in the list's order", () => {
    expect(cleanReasons(["text", "layout", "text", "product"])).toEqual([
      "layout",
      "product",
      "text",
    ]);
  });

  it("drops anything that is not a reason", () => {
    expect(cleanReasons(["nope", 3, null, undefined, {}, "colors"])).toEqual([
      "colors",
    ]);
    expect(cleanReasons([])).toEqual([]);
  });

  it("knows which keys are reasons", () => {
    for (const reason of DISLIKE_REASONS) {
      expect(isDislikeReason(reason.key)).toBe(true);
    }
    expect(isDislikeReason("anything")).toBe(false);
    expect(isDislikeReason(undefined)).toBe(false);
  });
});

describe("creativeName", () => {
  it("names a post by its title and where it goes", () => {
    expect(
      creativeName({
        title: "  Autumn   sale ",
        formatKey: "instagram.post",
        channel: "instagram",
      }),
    ).toBe('"Autumn sale" (instagram.post)');
    expect(
      creativeName({ title: "Post", formatKey: null, channel: "instagram" }),
    ).toBe('"Post" (instagram)');
    expect(
      creativeName({ title: "Post", formatKey: null, channel: null }),
    ).toBe('"Post"');
  });

  it("has no name without a title", () => {
    expect(
      creativeName({ title: null, formatKey: "x", channel: "y" }),
    ).toBeNull();
    expect(
      creativeName({ title: "   ", formatKey: "x", channel: "y" }),
    ).toBeNull();
  });
});

describe("designDigestOf", () => {
  it("reads the visual line of the brief and the layout name", () => {
    expect(
      designDigestOf({
        brief: "Hook: Big news\nVisual: A phone on a pale blue gradient\nCTA: Buy",
        layoutName: "Product hero",
      }),
    ).toBe("visual: A phone on a pale blue gradient; layout: Product hero");
  });

  it("copes with a brief without a visual line, and with no brief at all", () => {
    expect(designDigestOf({ brief: "Just a caption", layoutName: "Hero" })).toBe(
      "layout: Hero",
    );
    expect(designDigestOf({ brief: null })).toBe("");
  });

  it("keeps the digest short", () => {
    const digest = designDigestOf({
      brief: `Visual: ${"x".repeat(400)}`,
      layoutName: "y".repeat(100),
    });
    expect(digest.length).toBeLessThan(200);
  });
});

describe("ratingInsight", () => {
  const base = {
    name: '"Autumn sale" (instagram.post)',
    digest: "visual: a phone; layout: Hero",
  };

  it("says a like in one sentence with the design digest", () => {
    expect(ratingInsight({ ...base, rating: "LIKE", reasons: [] })).toBe(
      'Client liked "Autumn sale" (instagram.post) (visual: a phone; layout: Hero)',
    );
  });

  it("leaves the digest out when there is none", () => {
    expect(
      ratingInsight({ rating: "LIKE", name: '"Post"', digest: "", reasons: [] }),
    ).toBe('Client liked "Post"');
  });

  it("turns the ticked reasons and the note of a dislike into the lesson", () => {
    const text = ratingInsight({
      ...base,
      rating: "DISLIKE",
      reasons: ["layout", "product"],
      note: "  too   busy ",
    });
    expect(text).toContain('Client did not like "Autumn sale" (instagram.post)');
    expect(text).toContain("the layout does not follow the brand's post design");
    expect(text).toContain("the product is not shown right");
    expect(text.endsWith("too busy")).toBe(true);
  });

  it("is the same sentence for the same complaint, so it counts as seen again", () => {
    const make = () =>
      ratingInsight({ ...base, rating: "DISLIKE", reasons: ["colors"] });
    expect(make()).toBe(make());
  });

  it("is still a verdict with no reason given", () => {
    expect(
      ratingInsight({ rating: "DISLIKE", name: '"Post"', digest: "", reasons: [] }),
    ).toBe('Client did not like "Post"');
  });

  it("cuts a very long note", () => {
    const text = ratingInsight({
      rating: "DISLIKE",
      name: '"Post"',
      digest: "",
      reasons: [],
      note: "n".repeat(MAX_RATING_NOTE_CHARS * 3),
    });
    expect(text.length).toBeLessThan(MAX_RATING_NOTE_CHARS + 60);
  });
});
