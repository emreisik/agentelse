import { describe, expect, it } from "vitest";

import { assetReadiness, parseAssetItems } from "./brand-assets";

describe("parseAssetItems", () => {
  it("reads a plain string list", () => {
    expect(parseAssetItems([" Cafes ", "", "Hotels"])).toEqual([
      { title: "Cafes" },
      { title: "Hotels" },
    ]);
  });

  it("reads label/description objects", () => {
    expect(
      parseAssetItems([{ label: "Owners", description: "Small shop owners" }]),
    ).toEqual([{ title: "Owners", detail: "Small shop owners" }]);
  });

  it("returns an empty list for null and a single string", () => {
    expect(parseAssetItems(null)).toEqual([]);
    expect(parseAssetItems("Turkey")).toEqual([{ title: "Turkey" }]);
  });

  it("returns null for shapes it cannot read, so raw JSON stays visible", () => {
    expect(parseAssetItems([{ foo: 1 }])).toBeNull();
    expect(parseAssetItems([["nested"]])).toBeNull();
    expect(parseAssetItems([3])).toBeNull();
  });
});

describe("assetReadiness", () => {
  it("marks what is filled", () => {
    const result = assetReadiness({
      hasLogo: true,
      positioning: "  ",
      toneOfVoice: "Warm",
      colorCount: 2,
      fontCount: 0,
      audienceCount: 1,
    });
    expect(result.filter((r) => r.done).map((r) => r.key)).toEqual([
      "logo",
      "tone",
      "colors",
      "audience",
    ]);
  });
});
