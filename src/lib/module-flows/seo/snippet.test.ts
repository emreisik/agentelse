import { describe, expect, it } from "vitest";

import {
  SNIPPET_LIMITS,
  cleanSnippetVariants,
  serpMeta,
  serpTitle,
  snippetChecks,
} from "./snippet";

const CURRENT = { title: "Running shoes", metaDescription: "Old meta." };

function variant(title: string, metaDescription = "A fine description.") {
  return { title, metaDescription, angle: "Benefit" };
}

describe("cleanSnippetVariants", () => {
  it("cuts a long title at a word boundary, not in the middle of a word", () => {
    const long = `${"kelime ".repeat(14)}ayakkabılarımız`;
    const [first] = cleanSnippetVariants([variant(long)], CURRENT);
    expect(Array.from(first!.title).length).toBeLessThanOrEqual(
      SNIPPET_LIMITS.titleMax,
    );
    expect(first!.title.endsWith("kelime")).toBe(true);
    expect(long.startsWith(first!.title)).toBe(true);
  });

  it("counts code points, so an emoji or a non-Latin letter is never split", () => {
    const text = "😀".repeat(80);
    const [first] = cleanSnippetVariants([variant(text)], CURRENT);
    expect(Array.from(first!.title)).toHaveLength(SNIPPET_LIMITS.titleMax);
    expect(first!.title).not.toContain("�");
    const cyrillic = `${"слово ".repeat(20)}`;
    const [second] = cleanSnippetVariants([variant(cyrillic)], CURRENT);
    expect(second!.title.endsWith("слово")).toBe(true);
  });

  it("clamps the meta description at its own limit", () => {
    const meta = "word ".repeat(60);
    const [first] = cleanSnippetVariants([variant("A title", meta)], CURRENT);
    expect(Array.from(first!.metaDescription).length).toBeLessThanOrEqual(
      SNIPPET_LIMITS.metaMax,
    );
  });

  it("dedupes by title, ignoring case and accents", () => {
    const out = cleanSnippetVariants(
      [variant("Koşu Ayakkabısı"), variant("kosu ayakkabisi"), variant("Other")],
      CURRENT,
    );
    expect(out.map((item) => item.title)).toEqual(["Koşu Ayakkabısı", "Other"]);
  });

  it("drops a variant that keeps the current title", () => {
    const out = cleanSnippetVariants(
      [variant("RUNNING SHOES"), variant("Best running shoes")],
      CURRENT,
    );
    expect(out.map((item) => item.title)).toEqual(["Best running shoes"]);
  });

  it("drops empty variants, strips markers and quotes, keeps at most three", () => {
    const out = cleanSnippetVariants(
      [
        variant(""),
        variant("T0", ""),
        variant('"Quoted one"'),
        variant("**Bold two**"),
        variant("Three"),
        variant("Four"),
      ],
      CURRENT,
    );
    expect(out.map((item) => item.title)).toEqual([
      "Quoted one",
      "Bold two",
      "Three",
    ]);
  });

  it("names a missing angle", () => {
    const out = cleanSnippetVariants(
      [{ title: "One", metaDescription: "m", angle: "" }],
      { title: null, metaDescription: null },
    );
    expect(out[0]?.angle).toBe("Option 1");
  });
});

describe("snippetChecks", () => {
  it("checks both lengths and the keyword", () => {
    const ok = snippetChecks(
      { title: "Best running shoes", metaDescription: "Short and fine." },
      "running shoes",
    );
    expect(ok).toEqual([
      { id: "title_length", ok: true },
      { id: "meta_length", ok: true },
      { id: "keyword_in_title", ok: true },
    ]);
    const bad = snippetChecks(
      { title: "x".repeat(61), metaDescription: "y".repeat(156) },
      "running shoes",
    );
    expect(bad.map((check) => check.ok)).toEqual([false, false, false]);
  });

  it("omits the keyword check without a keyword", () => {
    expect(
      snippetChecks({ title: "T", metaDescription: "M" }, null).map(
        (check) => check.id,
      ),
    ).toEqual(["title_length", "meta_length"]);
    expect(
      snippetChecks({ title: "T", metaDescription: "M" }, "  ").length,
    ).toBe(2);
  });
});

describe("SERP truncation", () => {
  it("leaves a fitting title alone and ends a long one with an ellipsis", () => {
    expect(serpTitle("  Short title ")).toBe("Short title");
    const out = serpTitle("alpha beta gamma delta ".repeat(5));
    expect(out.endsWith("…")).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(SNIPPET_LIMITS.title);
    expect(out).not.toMatch(/\s…$/);
  });

  it("does the same for the description at 155", () => {
    expect(serpMeta("fine")).toBe("fine");
    const out = serpMeta("lorem ipsum dolor ".repeat(20));
    expect(out.endsWith("…")).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(SNIPPET_LIMITS.meta);
  });
});
