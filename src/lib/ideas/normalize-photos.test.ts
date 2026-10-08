import { describe, expect, it } from "vitest";

import { normalizeSocialIdeas, type RawSocialIdea } from "./normalize";

const ctx = {
  channels: ["instagram"] as const,
  layoutIds: [],
  photoIds: ["photo-a", "photo-b"],
  signals: [],
  today: "2026-10-07",
  timezone: "Europe/Istanbul",
};

function raw(n: number, photoId?: string): RawSocialIdea {
  return {
    hook: ["Sunday brunch on the terrace", "Our chefs cook breakfast at dawn", "Fresh coffee roasted every morning"][n - 1]!,
    headline: `Brunch is back ${n}`,
    visual: `A sunlit table, take ${n * 3}`,
    caption: `Come and eat, number ${n * 5}. Book now.`,
    ...(photoId ? { photoId } : {}),
  };
}

describe("an idea's own photo", () => {
  it("keeps a photo the prompt listed", () => {
    const [idea] = normalizeSocialIdeas([raw(1, "photo-a")], ctx);
    expect(idea?.draft.assetIds).toEqual(["photo-a"]);
  });

  it("drops an id the prompt never listed", () => {
    const [idea] = normalizeSocialIdeas([raw(1, "invented")], ctx);
    expect(idea).toBeDefined();
    expect(idea?.draft.assetIds).toBeUndefined();
  });

  it("gives a photo to one idea of a batch only", () => {
    const ideas = normalizeSocialIdeas(
      [raw(1, "photo-a"), raw(2, "photo-a"), raw(3, "photo-b")],
      ctx,
    );
    expect(ideas.map((idea) => idea.draft.assetIds)).toEqual([
      ["photo-a"],
      undefined,
      ["photo-b"],
    ]);
  });

  it("is absent when the brand has no photos", () => {
    const [idea] = normalizeSocialIdeas([raw(1, "photo-a")], { ...ctx, photoIds: undefined });
    expect(idea?.draft.assetIds).toBeUndefined();
  });
});
