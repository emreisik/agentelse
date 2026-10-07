import { describe, expect, it, vi } from "vitest";

import type { SeoSnippetVariant, SeoTarget } from "@/lib/module-flows/seo/state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/seo-flow-actions", () => ({
  goToSeoStepAction: vi.fn(),
  researchSeoAction: vi.fn(),
  rewriteSeoArticleAction: vi.fn(),
  writeSeoArticleAction: vi.fn(),
}));
vi.mock("@/server/actions/seo-mode-actions", () => ({
  chooseSnippetAction: vi.fn(),
  suggestSnippetAction: vi.fn(),
  researchRefreshAction: vi.fn(),
}));

const { snippetCounters, snippetPreviewRows } = await import("./snippet-step");

const TARGET: SeoTarget = {
  url: "https://www.example.com/blog/running-shoes",
  path: "/blog/running-shoes",
  title: "Running shoes",
  metaDescription: "Our guide.",
  h1: "Running shoes",
  h2: [],
  wordCount: 900,
  textHash: null,
  fetchedAt: "2026-10-07T08:00:00.000Z",
  queryCount: 0,
};

const variant = (
  title: string,
  metaDescription = "A short, clear description of the page.",
  angle = "Benefit",
): SeoSnippetVariant => ({ title, metaDescription, angle });

describe("snippetPreviewRows", () => {
  it("starts with the page as it is today, then one row per option", () => {
    const rows = snippetPreviewRows({
      target: TARGET,
      variants: [variant("Best running shoes for beginners"), variant("B")],
    });
    expect(rows.map((row) => row.id)).toEqual([
      "current",
      "variant-0",
      "variant-1",
    ]);
    expect(rows[0]).toMatchObject({
      label: "Now",
      host: "example.com",
      title: "Running shoes",
      meta: "Our guide.",
      checks: [],
      current: true,
    });
    expect(rows[1]).toMatchObject({
      label: "Option 1",
      angle: "Benefit",
      current: false,
    });
  });

  it("no current row when the page has no title", () => {
    const rows = snippetPreviewRows({
      target: { ...TARGET, title: null },
      variants: [variant("New title")],
    });
    expect(rows.map((row) => row.id)).toEqual(["variant-0"]);
  });

  it("truncates what would not fit in a search result, with an ellipsis", () => {
    const long = "word ".repeat(30).trim();
    const [row] = snippetPreviewRows({
      target: undefined,
      variants: [variant(long, long.repeat(3))],
    });
    expect(row?.host).toBe("your-site.com");
    expect(row?.title.endsWith("…")).toBe(true);
    expect(Array.from(row?.title ?? "").length).toBeLessThanOrEqual(60);
    expect(row?.meta.endsWith("…")).toBe(true);
    expect(Array.from(row?.meta ?? "").length).toBeLessThanOrEqual(155);
  });

  it("a title at the limit is shown whole", () => {
    const title = "a".repeat(60);
    const [row] = snippetPreviewRows({
      target: undefined,
      variants: [variant(title)],
    });
    expect(row?.title).toBe(title);
  });

  it("check chips: length of each text, and the keyword only when one is known", () => {
    const [ok, bad] = snippetPreviewRows({
      target: undefined,
      variants: [
        variant("Running shoes for beginners", "Short and clear."),
        variant("x".repeat(80), "y".repeat(200)),
      ],
      keyword: "running shoes",
    });
    expect(ok?.checks).toEqual([
      { id: "title_length", ok: true, label: "Title fits" },
      { id: "meta_length", ok: true, label: "Description fits" },
      { id: "keyword_in_title", ok: true, label: "Keyword in title" },
    ]);
    expect(bad?.checks.map((check) => [check.id, check.ok, check.label])).toEqual(
      [
        ["title_length", false, "Title is too long"],
        ["meta_length", false, "Description is too long"],
        ["keyword_in_title", false, "Keyword missing from title"],
      ],
    );

    const [noKeyword] = snippetPreviewRows({
      target: undefined,
      variants: [variant("Running shoes")],
    });
    expect(noKeyword?.checks.map((check) => check.id)).toEqual([
      "title_length",
      "meta_length",
    ]);
  });
});

describe("snippetCounters", () => {
  const text = (title: number, meta: number) => ({
    title: "a".repeat(title),
    metaDescription: "b".repeat(meta),
  });

  it("at the target lengths nothing is over", () => {
    const counters = snippetCounters(text(60, 155));
    expect(counters.title).toEqual({ count: 60, limit: 60, over: false });
    expect(counters.meta).toEqual({ count: 155, limit: 155, over: false });
    expect(counters.usable).toBe(true);
    expect(counters.reason).toBeNull();
  });

  it("one over the target is flagged but still usable up to the hard limit", () => {
    const counters = snippetCounters(text(61, 156));
    expect(counters.title.over).toBe(true);
    expect(counters.meta.over).toBe(true);
    expect(counters.usable).toBe(true);
    const edge = snippetCounters(text(70, 170));
    expect(edge.usable).toBe(true);
  });

  it("past the hard limit it cannot be used", () => {
    const long = snippetCounters(text(71, 100));
    expect(long.usable).toBe(false);
    expect(long.reason).toBe("Shorten the title or the description first.");
    expect(snippetCounters(text(50, 171)).usable).toBe(false);
  });

  it("an empty title or description cannot be used", () => {
    expect(snippetCounters(text(0, 100))).toMatchObject({
      usable: false,
      reason: "Both the title and the description need text.",
    });
    expect(snippetCounters({ title: "  ", metaDescription: "x" }).usable).toBe(
      false,
    );
  });

  it("counts code points, not UTF-16 units", () => {
    expect(
      snippetCounters({ title: "🙂".repeat(60), metaDescription: "b" }).title
        .count,
    ).toBe(60);
  });
});
