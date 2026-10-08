import { describe, expect, it } from "vitest";

import { cleanFontList, normalizeFontName } from "./font-names";

describe("normalizeFontName", () => {
  it("turns a next/font family back into the font", () => {
    expect(normalizeFontName("__Montserrat_0e8a88")).toBe("Montserrat");
    expect(normalizeFontName("__Playfair_Display_5ab3c4f1")).toBe("Playfair Display");
  });

  it("drops the metrics-adjusted fallback and CSS variable names", () => {
    expect(normalizeFontName("__Montserrat_Fallback_0e8a88")).toBeNull();
    expect(normalizeFontName("__variable_0e8a88")).toBeNull();
    expect(normalizeFontName("Arial Fallback")).toBeNull();
  });

  it("leaves a real family alone, quotes and spaces aside", () => {
    expect(normalizeFontName("  'Open Sans' ")).toBe("Open Sans");
    expect(normalizeFontName("Inter")).toBe("Inter");
    expect(normalizeFontName("")).toBeNull();
  });
});

describe("cleanFontList", () => {
  it("cleans, drops fallbacks and de-duplicates in order", () => {
    expect(
      cleanFontList([
        "__Montserrat_0e8a88",
        "__Montserrat_Fallback_0e8a88",
        "montserrat",
        "Lora",
      ]),
    ).toEqual(["Montserrat", "Lora"]);
  });
});
