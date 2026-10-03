import { describe, expect, it } from "vitest";

import {
  PIECE_TEXT_MAX,
  normalizePieceText,
  pieceTextField,
  pieceTextOf,
} from "./piece-text";

describe("pieceTextOf", () => {
  it("a picture post keeps its words in the caption, a written piece in the copy", () => {
    expect(pieceTextField({ assetId: "a1" })).toBe("caption");
    expect(pieceTextField({ assetId: null })).toBe("copy");
    expect(pieceTextOf({ assetId: "a1", caption: " Hi ", copy: "headline" })).toBe("Hi");
    expect(pieceTextOf({ assetId: null, caption: "x", copy: "A script" })).toBe("A script");
  });

  it("falls back to the other field when its own is empty", () => {
    expect(pieceTextOf({ assetId: "a1", caption: "  ", copy: "On image" })).toBe("On image");
    expect(pieceTextOf({ assetId: null, copy: null, caption: "Only caption" })).toBe(
      "Only caption",
    );
  });

  it("is undefined without any text", () => {
    expect(pieceTextOf(null)).toBeUndefined();
    expect(pieceTextOf({ assetId: "a1", caption: " ", copy: null })).toBeUndefined();
  });
});

describe("normalizePieceText", () => {
  it("keeps line breaks, trims, and allows at most one blank line in a row", () => {
    expect(normalizePieceText("  Line one \r\n\r\n\r\n\r\nLine two  ")).toBe(
      "Line one\n\nLine two",
    );
  });

  it("drops control characters", () => {
    expect(normalizePieceText("a\u0000b\u0007c\td")).toBe("abc\td");
  });

  it("refuses an empty text, a non-string and one that is too long", () => {
    expect(normalizePieceText("   ")).toBeNull();
    expect(normalizePieceText(42)).toBeNull();
    expect(normalizePieceText("x".repeat(PIECE_TEXT_MAX + 1))).toBeNull();
    expect(normalizePieceText("x".repeat(PIECE_TEXT_MAX))).toHaveLength(PIECE_TEXT_MAX);
  });
});
