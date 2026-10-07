import { describe, expect, it } from "vitest";

import { refreshDiff } from "./refresh-diff";
import type { SeoArticle, SeoTarget } from "./state";

const TARGET: SeoTarget = {
  url: "https://example.com/p",
  path: "/p",
  title: "Running shoes",
  metaDescription: "Old meta.",
  h1: "Running shoes",
  h2: ["Fit", "Çok Önemli", "Care"],
  wordCount: 100,
  textHash: null,
  fetchedAt: "2026-10-05T09:00:00.000Z",
  queryCount: 0,
};

function article(markdown: string, extra: Partial<SeoArticle> = {}): SeoArticle {
  return {
    title: "Running shoes",
    metaDescription: "Old meta.",
    markdown,
    writtenAt: "2026-10-05T10:00:00.000Z",
    rewrites: 0,
    ...extra,
  };
}

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

describe("refreshDiff", () => {
  it("lists headings added, removed and kept, ignoring case and accents", () => {
    const diff = refreshDiff({
      target: TARGET,
      article: article(
        `${words(10)}\n\n## fit\n\ntext\n\n## COK ONEMLI\n\ntext\n\n## FAQ\n\ntext`,
      ),
      outline: [],
    });
    expect(diff.headingsKept).toBe(2);
    expect(diff.headingsAdded).toEqual(["FAQ"]);
    expect(diff.headingsRemoved).toEqual(["Care"]);
  });

  it("falls back to the plan outline when the article has no H2", () => {
    const diff = refreshDiff({
      target: TARGET,
      article: article(words(5)),
      outline: [
        { h2: "Fit", points: [] },
        { h2: "Sizing", points: [] },
      ],
    });
    expect(diff.headingsAdded).toEqual(["Sizing"]);
    expect(diff.headingsKept).toBe(1);
    expect(diff.headingsRemoved).toEqual(["Çok Önemli", "Care"]);
  });

  it("reports the word change in percent", () => {
    const grown = refreshDiff({
      target: TARGET,
      article: article(words(125)),
      outline: [],
    });
    expect(grown).toMatchObject({
      wordsBefore: 100,
      wordsAfter: 125,
      wordsChangePct: 25,
    });
    const shrunk = refreshDiff({
      target: { ...TARGET, wordCount: 200 },
      article: article(words(150)),
      outline: [],
    });
    expect(shrunk.wordsChangePct).toBe(-25);
    const unknown = refreshDiff({
      target: { ...TARGET, wordCount: null },
      article: article(words(50)),
      outline: [],
    });
    expect(unknown.wordsChangePct).toBeNull();
    expect(unknown.wordsBefore).toBeNull();
    expect(
      refreshDiff({
        target: { ...TARGET, wordCount: 0 },
        article: article(words(5)),
        outline: [],
      }).wordsChangePct,
    ).toBeNull();
  });

  it("flags a changed title or meta and ignores formatting-only differences", () => {
    const same = refreshDiff({
      target: TARGET,
      article: article(words(5), {
        title: "  running   SHOES ",
        metaDescription: "old meta.",
      }),
      outline: [],
    });
    expect(same.titleChanged).toBe(false);
    expect(same.metaChanged).toBe(false);
    const changed = refreshDiff({
      target: TARGET,
      article: article(words(5), {
        title: "Best running shoes",
        metaDescription: "New meta.",
      }),
      outline: [],
    });
    expect(changed.titleChanged).toBe(true);
    expect(changed.metaChanged).toBe(true);
    expect(
      refreshDiff({
        target: { ...TARGET, title: null },
        article: article(words(5)),
        outline: [],
      }).titleChanged,
    ).toBe(true);
  });
});
