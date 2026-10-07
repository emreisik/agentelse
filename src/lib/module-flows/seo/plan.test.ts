import { describe, expect, it } from "vitest";

import {
  SEO_BRIEF_MESSAGES,
  cleanLine,
  normalizeSiteUrl,
  siteLabel,
  validateSeoBrief,
} from "./brief";
import {
  SEO_EDIT_MESSAGES,
  applyPlanEdits,
  chosenTitle,
  normalizeArticleMarkdown,
  planFromResearch,
  withKeyword,
  withPlannedKeyword,
  type SeoResearchAnswer,
} from "./plan";
import type { SeoPlan } from "./state";

const NOW = new Date("2026-10-05T10:00:00.000Z");

describe("brief", () => {
  it("normalizes a website address in any usual shape", () => {
    expect(normalizeSiteUrl("example.com")).toBe("https://example.com");
    expect(normalizeSiteUrl("https://www.Example.com/blog/")).toBe(
      "https://www.example.com/blog",
    );
    expect(normalizeSiteUrl("sc-domain:example.mk")).toBe("https://example.mk");
    expect(normalizeSiteUrl("http://example.com/?utm=1#x")).toBe(
      "http://example.com",
    );
    for (const bad of [
      "",
      "not a site",
      "localhost",
      "ftp://example.com",
      "https://user:pw@example.com",
      "javascript:alert(1)",
    ]) {
      expect(normalizeSiteUrl(bad)).toBeNull();
    }
    expect(siteLabel("https://www.example.com/blog")).toBe("example.com/blog");
  });

  it("validates the brief: topic, site and language", () => {
    expect(
      validateSeoBrief({
        topic: "  Running   shoes\nfor beginners ",
        siteUrl: "example.com",
        language: "tr",
        audience: " first-time runners ",
      }),
    ).toEqual({
      ok: true,
      brief: {
        topic: "Running shoes for beginners",
        siteUrl: "https://example.com",
        language: "tr",
        audience: "first-time runners",
      },
    });
    expect(validateSeoBrief({ topic: "ab", language: "en" })).toMatchObject({
      ok: false,
      field: "topic",
      message: SEO_BRIEF_MESSAGES.topic,
    });
    expect(
      validateSeoBrief({ topic: "Shoes", siteUrl: "no site", language: "en" }),
    ).toMatchObject({ ok: false, field: "siteUrl" });
    expect(validateSeoBrief({ topic: "Shoes", language: "xx" })).toMatchObject({
      ok: false,
      field: "language",
    });
    expect(validateSeoBrief({ topic: "Shoes", language: "en" })).toMatchObject({
      ok: true,
      brief: { siteUrl: "", audience: "" },
    });
    expect(validateSeoBrief(null)).toMatchObject({ ok: false, field: "topic" });
  });

  it("cleans one line of the person's text and clips by code point", () => {
    expect(cleanLine("a\u0000b\u200bc\n d", 10)).toBe("a b c d");
    expect(cleanLine("👟👟👟", 2)).toBe("👟👟");
    expect(cleanLine(7, 10)).toBe("");
  });
});

const ANSWER: SeoResearchAnswer = {
  primaryKeyword: '"Running Shoes."',
  secondaryKeywords: [
    "best running shoes",
    "Best Running Shoes",
    "running shoes",
    "  ",
    "trail shoes",
  ],
  searchIntent: "Commercial investigation",
  intentNote: "People compare pairs before they buy.",
  titleOptions: [
    "Shoes",
    "# Running shoes: how to choose your first pair",
    "Running shoes: how to choose your first pair",
    "The complete running shoes guide",
    "A fourth title",
  ],
  metaDescription: "Choose running shoes that fit.",
  outline: [
    { h2: "## What running shoes do", points: ["- cushioning", "drop"] },
    { h2: "H2: How to choose", points: [] },
    { h2: "How to choose", points: ["duplicate"] },
    { h2: "", points: [] },
    { h2: "Where to buy", points: ["shops", "online"] },
  ],
};

const QUICK = { state: "not-connected" } as const;

describe("planFromResearch", () => {
  it("cleans the answer into a plan", () => {
    const plan = planFromResearch(ANSWER, QUICK, NOW);
    expect(plan).toEqual({
      primaryKeyword: "Running Shoes",
      secondaryKeywords: ["best running shoes", "trail shoes"],
      searchIntent: "commercial",
      intentNote: "People compare pairs before they buy.",
      titleOptions: [
        "Shoes",
        "Running shoes: how to choose your first pair",
        "The complete running shoes guide",
      ],
      // "Shoes" is too short and has no keyword: the first title that passes
      // the title checks is picked.
      titleIndex: 1,
      metaDescription: "Choose running shoes that fit.",
      outline: [
        { h2: "What running shoes do", points: ["cushioning", "drop"] },
        { h2: "How to choose", points: [] },
        { h2: "Where to buy", points: ["shops", "online"] },
      ],
      quickWins: QUICK,
      researchedAt: NOW.toISOString(),
    });
    expect(chosenTitle(plan!)).toBe(
      "Running shoes: how to choose your first pair",
    );
  });

  it("refuses an answer too thin to work from", () => {
    expect(
      planFromResearch({ ...ANSWER, primaryKeyword: " " }, QUICK, NOW),
    ).toBeNull();
    expect(
      planFromResearch({ ...ANSWER, titleOptions: [] }, QUICK, NOW),
    ).toBeNull();
    expect(
      planFromResearch(
        { ...ANSWER, outline: ANSWER.outline.slice(0, 2) },
        QUICK,
        NOW,
      ),
    ).toBeNull();
  });
});

const PLAN: SeoPlan = {
  primaryKeyword: "running shoes",
  secondaryKeywords: ["best running shoes"],
  searchIntent: "commercial",
  intentNote: "",
  titleOptions: ["One", "Two"],
  titleIndex: 0,
  metaDescription: "Meta.",
  outline: [
    { h2: "A", points: ["a"] },
    { h2: "B", points: [] },
    { h2: "C", points: [] },
  ],
  quickWins: { state: "failed" },
  researchedAt: NOW.toISOString(),
};

const edits = (over: Record<string, unknown> = {}) => ({
  titleIndex: 1,
  metaDescription: "  A new meta  ",
  secondaryKeywords: ["best running shoes", "Running Shoes", "trail shoes"],
  outline: [
    { h2: "C", points: [] },
    { h2: " A ", points: ["a", " "] },
    { h2: "New one", points: [] },
  ],
  ...over,
});

describe("applyPlanEdits", () => {
  it("takes the person's title, meta, keywords and outline", () => {
    const result = applyPlanEdits(PLAN, edits());
    expect(result).toEqual({
      ok: true,
      plan: {
        ...PLAN,
        titleIndex: 1,
        metaDescription: "A new meta",
        secondaryKeywords: ["best running shoes", "trail shoes"],
        outline: [
          { h2: "C", points: [] },
          { h2: "A", points: ["a"] },
          { h2: "New one", points: [] },
        ],
      },
    });
  });

  it("explains what blocks writing", () => {
    expect(applyPlanEdits(PLAN, edits({ metaDescription: " " }))).toEqual({
      ok: false,
      message: SEO_EDIT_MESSAGES.meta,
    });
    expect(
      applyPlanEdits(
        PLAN,
        edits({ outline: [...edits().outline, { h2: " ", points: [] }] }),
      ),
    ).toEqual({ ok: false, message: SEO_EDIT_MESSAGES.heading });
    expect(
      applyPlanEdits(PLAN, edits({ outline: edits().outline.slice(0, 2) })),
    ).toEqual({ ok: false, message: SEO_EDIT_MESSAGES.tooFew });
    expect(
      applyPlanEdits(
        PLAN,
        edits({
          outline: Array.from({ length: 11 }, (_, i) => ({
            h2: `S${i}`,
            points: [],
          })),
        }),
      ),
    ).toEqual({ ok: false, message: SEO_EDIT_MESSAGES.tooMany });
    expect(applyPlanEdits(PLAN, edits({ titleIndex: 2 }))).toEqual({
      ok: false,
      message: SEO_EDIT_MESSAGES.invalid,
    });
    expect(applyPlanEdits(PLAN, "nope")).toMatchObject({ ok: false });
  });
});

describe("withKeyword", () => {
  it("adds a keyword once, never the primary one", () => {
    expect(withKeyword(["a b"], "c d", "x")).toEqual(["a b", "c d"]);
    expect(withKeyword(["a b"], "A B", "x")).toEqual(["a b"]);
    expect(withKeyword(["a b"], "X", "x")).toEqual(["a b"]);
    expect(withKeyword([], "  ", "x")).toEqual([]);
  });
});

// SC-F7: aylık plandan açılan makalenin hedef kelimesi planın sorgusudur.
describe("withPlannedKeyword", () => {
  it("makes the planned query primary and keeps the model's keyword as secondary", () => {
    const plan = planFromResearch(ANSWER, QUICK, NOW)!;
    const next = withPlannedKeyword(plan, "trail running shoes");
    expect(next.primaryKeyword).toBe("trail running shoes");
    expect(next.secondaryKeywords).toContain("Running Shoes");
    expect(next.titleOptions).toEqual(plan.titleOptions);
  });

  it("leaves the plan alone for the same keyword or an empty one", () => {
    const plan = planFromResearch(ANSWER, QUICK, NOW)!;
    expect(withPlannedKeyword(plan, "running shoes")).toBe(plan);
    expect(withPlannedKeyword(plan, "  ")).toBe(plan);
  });

  it("never lists the planned keyword twice", () => {
    const plan = planFromResearch(ANSWER, QUICK, NOW)!;
    const next = withPlannedKeyword(plan, "best running shoes");
    expect(
      next.secondaryKeywords.filter((k) => k.toLowerCase() === "best running shoes"),
    ).toEqual([]);
  });
});

describe("normalizeArticleMarkdown", () => {
  it("drops a wrapping fence and a first-line H1, keeps the rest", () => {
    expect(
      normalizeArticleMarkdown(
        "```markdown\n# The title\n\nIntro.\n\n## Section\n\n# Stray H1\n```",
      ),
    ).toBe("Intro.\n\n## Section\n\n# Stray H1");
    expect(normalizeArticleMarkdown("Intro.\r\n\r\n## A")).toBe(
      "Intro.\n\n## A",
    );
  });
});
