import { describe, expect, it } from "vitest";

import { catalogOf, overlapScore, rankPhotos, type MatchPhoto } from "./media-match";

function photo(over: Partial<MatchPhoto> & { assetId: string }): MatchPhoto {
  return {
    description: null,
    tags: [],
    subjects: [],
    setting: null,
    quality: 80,
    width: 1600,
    height: 1200,
    useCount: 0,
    lastUsedAt: null,
    ...over,
  };
}

const brunch = photo({
  assetId: "brunch",
  description: "A sunlit brunch table on a terrace",
  tags: ["kahvaltı", "terrace", "brunch"],
});
const kitchen = photo({
  assetId: "kitchen",
  description: "Chefs working in the kitchen",
  tags: ["kitchen", "team"],
});

describe("overlapScore", () => {
  it("counts the idea's words that the photo names, tags first", () => {
    expect(overlapScore({ text: "Weekend brunch on the terrace" }, brunch)).toBeGreaterThanOrEqual(4);
    expect(overlapScore({ text: "Weekend brunch on the terrace" }, kitchen)).toBe(0);
  });

  it("folds Turkish letters", () => {
    expect(overlapScore({ text: "Pazar KAHVALTI keyfi" }, brunch)).toBeGreaterThanOrEqual(2);
    expect(overlapScore({ text: "Pazar kahvalti keyfi" }, brunch)).toBeGreaterThanOrEqual(2);
  });

  it("ignores filler words", () => {
    expect(overlapScore({ text: "the new post for you" }, brunch)).toBe(0);
  });
});

describe("rankPhotos", () => {
  const idea = { text: "Sunday brunch on our terrace" };

  it("leaves out photos with nothing in common", () => {
    expect(rankPhotos(idea, [kitchen, brunch]).map((r) => r.photo.assetId)).toEqual(["brunch"]);
  });

  it("leaves out poor photos and excluded ones", () => {
    expect(rankPhotos(idea, [{ ...brunch, quality: 20 }])).toEqual([]);
    expect(rankPhotos(idea, [brunch], { exclude: new Set(["brunch"]) })).toEqual([]);
  });

  it("prefers the photo used less among equals", () => {
    const worn = { ...brunch, assetId: "worn", useCount: 4 };
    expect(rankPhotos(idea, [worn, brunch])[0]?.photo.assetId).toBe("brunch");
  });

  it("prefers the one that loses less to the crop", () => {
    const wide = { ...brunch, assetId: "wide", width: 3000, height: 1000 };
    const square = { ...brunch, assetId: "square", width: 1500, height: 1500 };
    const ranked = rankPhotos(
      { ...idea, canvas: { width: 1080, height: 1080 } },
      [wide, square],
    );
    expect(ranked[0]?.photo.assetId).toBe("square");
  });

  it("honours the limit", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...brunch, assetId: `b${i}` }));
    expect(rankPhotos(idea, many, { limit: 2 })).toHaveLength(2);
  });
});

describe("catalogOf", () => {
  it("keeps the best and freshest photos within the limit", () => {
    const photos = [
      photo({ assetId: "old", useCount: 5 }),
      photo({ assetId: "fresh" }),
      photo({ assetId: "poor", quality: 10 }),
    ];
    const kept = catalogOf(photos, 2).map((p) => p.assetId);
    expect(kept).toEqual(["fresh", "old"]);
  });

  it("pulls photos that match the focus forward", () => {
    const photos = [photo({ assetId: "a" }), { ...brunch, quality: 70 }];
    expect(catalogOf(photos, 1, "brunch terrace")[0]?.assetId).toBe("brunch");
  });
});
