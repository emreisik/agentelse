import { describe, expect, it } from "vitest";

import { barColorCandidates } from "./bar-color-candidates";

describe("barColorCandidates", () => {
  it("orders accent, then primary, then secondary", () => {
    const hexes = barColorCandidates({
      accentColors: [{ hex: "#aa0000" }],
      primaryColors: [{ hex: "#00aa00" }],
      secondaryColors: [{ hex: "#0000aa" }],
    }).map((color) => color.hex);
    expect(hexes).toEqual(["#aa0000", "#00aa00", "#0000aa"]);
  });

  it("uses the primary colour when the brand has no accent colour", () => {
    expect(
      barColorCandidates({
        accentColors: [],
        primaryColors: [{ hex: "#00aa00" }],
        secondaryColors: [],
      })[0]?.hex,
    ).toBe("#00aa00");
  });

  it("is empty without a visual identity, leaving the legacy colours to apply", () => {
    expect(barColorCandidates(null)).toEqual([]);
    expect(barColorCandidates(undefined)).toEqual([]);
  });
});
