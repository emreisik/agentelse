import { describe, expect, it } from "vitest";

import {
  APPLY_LIMITS,
  clampDailyLimit,
  normalizeAppPassword,
  normalizeUsername,
  titleForPost,
  validateArticle,
  validateTitleMeta,
} from "./validate";

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(" ");
}

describe("validateTitleMeta", () => {
  it("sanitizes: control characters, angle brackets and extra spaces", () => {
    const result = validateTitleMeta({
      title: "  Pricing \n for\t<b>teams</b>  ",
      metaDescription: "A   short\u0000 text",
    });
    expect(result).toEqual({
      ok: true,
      title: "Pricing for bteams/b",
      metaDescription: "A short text",
    });
  });

  it("accepts one field and nulls the other", () => {
    expect(validateTitleMeta({ title: "Only a title" })).toEqual({
      ok: true,
      title: "Only a title",
      metaDescription: null,
    });
    expect(validateTitleMeta({ metaDescription: "Only a description", title: "  " })).toEqual({
      ok: true,
      title: null,
      metaDescription: "Only a description",
    });
  });

  it("needs at least one field", () => {
    expect(validateTitleMeta({}).ok).toBe(false);
    expect(validateTitleMeta({ title: " ", metaDescription: "" }).ok).toBe(false);
    expect(validateTitleMeta({ title: 5 }).ok).toBe(false);
  });

  it("enforces the length limits at the boundary", () => {
    expect(validateTitleMeta({ title: "a".repeat(APPLY_LIMITS.titleMax) }).ok).toBe(true);
    expect(validateTitleMeta({ title: "a".repeat(APPLY_LIMITS.titleMax + 1) }).ok).toBe(false);
    expect(validateTitleMeta({ metaDescription: "a".repeat(APPLY_LIMITS.metaMax) }).ok).toBe(true);
    expect(validateTitleMeta({ metaDescription: "a".repeat(APPLY_LIMITS.metaMax + 1) }).ok).toBe(false);
  });
});

describe("validateArticle", () => {
  it("accepts an article of at least 150 words", () => {
    const result = validateArticle({
      title: "A good title",
      metaDescription: "A description",
      markdown: `## Heading\n\n${words(150)}`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.words).toBeGreaterThanOrEqual(150);
  });

  it("refuses under 150 words, over the size cap, and missing parts", () => {
    expect(validateArticle({ title: "T", metaDescription: "", markdown: words(149) }).ok).toBe(false);
    expect(
      validateArticle({ title: "T", metaDescription: "", markdown: "word ".repeat(APPLY_LIMITS.markdownMax) }).ok,
    ).toBe(false);
    expect(validateArticle({ title: "", metaDescription: "", markdown: words(200) }).ok).toBe(false);
    expect(validateArticle({ title: 3, metaDescription: "", markdown: words(200) }).ok).toBe(false);
    expect(validateArticle({ title: "T", metaDescription: 3, markdown: words(200) }).ok).toBe(false);
  });

  it("limits the title to 70 and the description to 170", () => {
    const body = words(200);
    expect(validateArticle({ title: "a".repeat(71), metaDescription: "", markdown: body }).ok).toBe(false);
    expect(validateArticle({ title: "a", metaDescription: "b".repeat(171), markdown: body }).ok).toBe(false);
  });

  it("keeps line breaks in the markdown and drops control characters", () => {
    const result = validateArticle({
      title: "T",
      metaDescription: null,
      markdown: `Line one\r\n\r\nLine\u0000 two ${words(160)}`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown.startsWith("Line one\n\nLine two")).toBe(true);
      expect(result.metaDescription).toBe("");
    }
  });
});

describe("titleForPost", () => {
  it("cuts at 120 characters", () => {
    expect(titleForPost("a".repeat(150))).toHaveLength(120);
    expect(titleForPost("  Short <title>  ")).toBe("Short title");
  });
});

describe("clampDailyLimit", () => {
  it("clamps to 1..25 and defaults to 10", () => {
    expect(clampDailyLimit(0)).toBe(1);
    expect(clampDailyLimit(1)).toBe(1);
    expect(clampDailyLimit(25)).toBe(25);
    expect(clampDailyLimit(99)).toBe(25);
    expect(clampDailyLimit(7.9)).toBe(7);
    expect(clampDailyLimit("12")).toBe(12);
    expect(clampDailyLimit("")).toBe(10);
    expect(clampDailyLimit("abc")).toBe(10);
    expect(clampDailyLimit(undefined)).toBe(10);
    expect(clampDailyLimit(Number.NaN)).toBe(10);
  });
});

describe("normalizeAppPassword", () => {
  it("accepts the display form with spaces", () => {
    expect(normalizeAppPassword("abcd EFGH ijkl MNOP qrst UVWX")).toBe("abcdEFGHijklMNOPqrstUVWX");
    expect(normalizeAppPassword("abcdEFGHijklMNOPqrstUVWX")).toBe("abcdEFGHijklMNOPqrstUVWX");
  });

  it("refuses wrong lengths, symbols and non-strings", () => {
    expect(normalizeAppPassword("abcd EFGH")).toBeNull();
    expect(normalizeAppPassword("abcdEFGHijklMNOPqrstUVW!")).toBeNull();
    expect(normalizeAppPassword(123)).toBeNull();
    expect(normalizeAppPassword("")).toBeNull();
  });
});

describe("normalizeUsername", () => {
  it("trims and bounds the username", () => {
    expect(normalizeUsername("  editor.bot ")).toBe("editor.bot");
    expect(normalizeUsername("")).toBeNull();
    expect(normalizeUsername("a".repeat(61))).toBeNull();
    expect(normalizeUsername("a".repeat(60))).toBe("a".repeat(60));
  });

  it("refuses colons and control characters", () => {
    expect(normalizeUsername("user:name")).toBeNull();
    expect(normalizeUsername("user\nname")).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
  });
});
