import { describe, expect, it } from "vitest";

import {
  foldForMatch,
  foldedTokensWithRange,
  tokenizeFolded,
} from "@/lib/text-fold";

describe("foldForMatch", () => {
  it("makes the Turkish dotted and dotless i the same letter", () => {
    expect(foldForMatch("İNDİRİM")).toBe("indirim");
    expect(foldForMatch("indirim")).toBe("indirim");
    expect(foldForMatch("INDIRIM")).toBe("indirim");
  });

  it("folds the dotless i and keeps ASCII brand names intact", () => {
    expect(foldForMatch("ışık")).toBe("isik");
    expect(foldForMatch("Instagram")).toBe("instagram");
  });

  it("strips diacritics", () => {
    expect(foldForMatch("Görsel çocuğu şeker")).toBe("gorsel cocugu seker");
    expect(foldForMatch("café")).toBe("cafe");
  });
});

describe("tokenizeFolded", () => {
  it("splits on anything that is not a letter or digit", () => {
    expect(tokenizeFolded("Botoks'u %40 İNDİRİM!")).toEqual([
      "botoks",
      "u",
      "40",
      "indirim",
    ]);
  });

  it("keeps Cyrillic, Greek and Arabic words", () => {
    expect(tokenizeFolded("Скидка 20% сегодня")).toEqual([
      "скидка",
      "20",
      "сегодня",
    ]);
    expect(tokenizeFolded("Έκπτωση σήμερα")).toEqual(["εκπτωση", "σημερα"]);
    expect(tokenizeFolded("خصم كبير")).toEqual(["خصم", "كبير"]);
  });

  it("returns nothing for punctuation only", () => {
    expect(tokenizeFolded("... !!")).toEqual([]);
  });
});

describe("foldedTokensWithRange", () => {
  it("returns the same tokens with ranges in the original text", () => {
    const text = "Kesin GARANTİ!";
    const tokens = foldedTokensWithRange(text);
    expect(tokens.map((t) => t.token)).toEqual(tokenizeFolded(text));
    expect(text.slice(tokens[1]?.start, tokens[1]?.end)).toBe("GARANTİ");
  });

  it("does not split a decomposed letter", () => {
    const decomposed = "çocuk";
    expect(foldedTokensWithRange(decomposed).map((t) => t.token)).toEqual([
      "cocuk",
    ]);
  });
});
