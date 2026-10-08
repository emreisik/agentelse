import { describe, expect, it } from "vitest";

import {
  CURATED_FONTS,
  curatedFont,
  googleFontsStylesheetUrl,
  isFamilyName,
  withHeadlineFont,
} from "./google-fonts";

describe("the curated list", () => {
  it("has only well-formed, unique family names", () => {
    const names = CURATED_FONTS.map((font) => font.family.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const font of CURATED_FONTS) expect(isFamilyName(font.family)).toBe(true);
  });

  it("has a real choice in every mood", () => {
    const moods = new Set(CURATED_FONTS.map((font) => font.mood));
    expect(moods.size).toBe(5);
  });

  it("finds a font however it is written", () => {
    expect(curatedFont("  montserrat ")?.family).toBe("Montserrat");
    expect(curatedFont("Comic Neue")).toBeUndefined();
  });
});

describe("googleFontsStylesheetUrl", () => {
  it("is one request for many families, spaces as plus signs", () => {
    const url = googleFontsStylesheetUrl(["Playfair Display", "Inter"]);
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;700&display=swap",
    );
  });

  it("leaves out names that could break the URL", () => {
    expect(googleFontsStylesheetUrl(["Inter", "x&evil=1", "../../a"])).not.toContain(
      "evil",
    );
  });
});

describe("withHeadlineFont", () => {
  it("puts the choice first and keeps the others once", () => {
    expect(withHeadlineFont(["Inter", "Lora", "Roboto"], "lora")).toEqual([
      "lora",
      "Inter",
      "Roboto",
    ]);
    expect(withHeadlineFont([], "Lora")).toEqual(["Lora"]);
  });

  it("keeps at most three", () => {
    expect(withHeadlineFont(["A", "B", "C", "D"], "Z")).toEqual(["Z", "A", "B"]);
  });
});
