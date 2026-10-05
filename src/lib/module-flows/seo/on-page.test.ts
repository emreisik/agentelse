import { describe, expect, it } from "vitest";

import { checkOnPage, containsKeyword, onPageWarnings } from "./on-page";

const KEYWORD = "running shoes";

function words(count: number, word = "comfort"): string {
  return Array.from({ length: count }, () => word).join(" ");
}

// Intro with the keyword, four H2 sections (one with the keyword), each with
// two 100-word paragraphs: 2 + 4 + 8 * 100 + 4 * 2 + 3 words, all checks pass.
function goodArticle(): string {
  return [
    `The right ${KEYWORD} make every run easier.`,
    `## How to choose ${KEYWORD}`,
    words(100),
    words(100),
    "## Fit and size",
    words(100),
    words(100),
    "## Cushioning explained",
    words(100),
    words(100),
    "## Where to buy",
    words(100),
    words(100),
  ].join("\n\n");
}

const GOOD = {
  title: "How to choose running shoes for your first race",
  metaDescription:
    "Pick running shoes that fit: what cushioning, drop and size mean, how to test a pair in the shop, and the mistakes beginners make most often.",
  markdown: goodArticle(),
  primaryKeyword: KEYWORD,
};

const statusOf = (input: typeof GOOD) =>
  Object.fromEntries(
    checkOnPage(input).map((check) => [check.id, check.status]),
  );

describe("checkOnPage", () => {
  it("passes a well-built article on every check", () => {
    const checks = checkOnPage(GOOD);
    expect(checks.map((check) => check.id)).toEqual([
      "title-length",
      "meta-length",
      "keyword-title",
      "keyword-intro",
      "keyword-heading",
      "sections",
      "length",
      "no-h1",
      "paragraphs",
    ]);
    expect(onPageWarnings(checks)).toEqual([]);
    expect(checks.every((check) => check.line.length > 0)).toBe(true);
  });

  it("warns on a title outside 30-60 characters, with one line each", () => {
    const long = checkOnPage({
      ...GOOD,
      title: "Running shoes: the complete guide to choosing your next pairs",
    }).find((check) => check.id === "title-length");
    expect(long).toMatchObject({ status: "warn" });
    expect(long?.line).toMatch(/^61 characters\. Shorten it/);

    const short = checkOnPage({ ...GOOD, title: "Running shoes" }).find(
      (check) => check.id === "title-length",
    );
    expect(short?.line).toMatch(/^13 characters\. Make it longer/);

    const missing = checkOnPage({ ...GOOD, title: " " }).find(
      (check) => check.id === "title-length",
    );
    expect(missing?.line).toBe("Add a title.");
  });

  it("warns on a meta description outside 120-160 characters", () => {
    expect(
      statusOf({ ...GOOD, metaDescription: "Too short." })["meta-length"],
    ).toBe("warn");
    expect(
      statusOf({ ...GOOD, metaDescription: "x".repeat(161) })["meta-length"],
    ).toBe("warn");
    expect(
      checkOnPage({ ...GOOD, metaDescription: "" }).find(
        (check) => check.id === "meta-length",
      )?.line,
    ).toBe("Add a meta description.");
  });

  it("finds the keyword in the title, the first paragraph and an H2", () => {
    const status = statusOf({
      ...GOOD,
      title: "How to pick a pair for your very first race day",
      markdown: goodArticle()
        .replace("The right running shoes", "The right pair")
        .replace("## How to choose running shoes", "## How to choose"),
    });
    expect(status["keyword-title"]).toBe("warn");
    expect(status["keyword-intro"]).toBe("warn");
    expect(status["keyword-heading"]).toBe("warn");
    const line = checkOnPage({
      ...GOOD,
      title: "Something else entirely here",
    }).find((check) => check.id === "keyword-title")?.line;
    expect(line).toBe("Add “running shoes” to the title.");
  });

  it("warns on fewer than 4 sections, under 800 words, an H1 and long paragraphs", () => {
    const status = statusOf({
      ...GOOD,
      markdown: [
        "# Duplicate title",
        `The right ${KEYWORD} matter.`,
        `## About ${KEYWORD}`,
        words(160),
      ].join("\n\n"),
    });
    expect(status.sections).toBe("warn");
    expect(status.length).toBe("warn");
    expect(status["no-h1"]).toBe("warn");
    expect(status.paragraphs).toBe("warn");
    const paragraphs = checkOnPage({
      ...GOOD,
      markdown: `${goodArticle()}\n\n${words(151)}\n\n${words(151)}`,
    }).find((check) => check.id === "paragraphs");
    expect(paragraphs?.line).toBe(
      "2 paragraphs run over 150 words. Split them up.",
    );
  });
});

describe("containsKeyword", () => {
  it("ignores case, accents and dotted/dotless i", () => {
    expect(containsKeyword("İSTANBUL KOŞU REHBERİ", "istanbul koşu")).toBe(
      true,
    );
    expect(containsKeyword("Café guide", "cafe")).toBe(true);
  });

  it("tolerates short endings (plural, Turkish suffixes) but needs the words in order", () => {
    expect(containsKeyword("The best running shoes", "running shoe")).toBe(
      true,
    );
    expect(
      containsKeyword("Koşu ayakkabıları nasıl seçilir", "koşu ayakkabısı"),
    ).toBe(true);
    expect(containsKeyword("shoes for running", "running shoes")).toBe(false);
    expect(containsKeyword("anything", "")).toBe(false);
  });
});
