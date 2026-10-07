import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: SEO Manager makalesi (APPROVED + sürüm) ve elle
// yayınlanmış (PUBLISHED) makale yayınlanabilir; sürümsüz SC-F7 DRAFT slotu,
// ARCHIVED ve REJECTED parçalar, seo.article olmayan parçalar, başka projenin
// parçası ve 150 kelimeden kısa makale reddedilir; başlık ve açıklama sürümün
// üst verisinden okunur.

const mocks = vi.hoisted(() => ({
  creativeFindFirst: vi.fn(),
  versionFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findFirst: mocks.creativeFindFirst },
    creativeVersion: { findFirst: mocks.versionFindFirst },
  },
}));
vi.mock("@/server/modules/seo/calendar", () => ({
  SEO_FORMAT_KEY: "seo.article",
}));

const { loadArticleForPublish } = await import("./articles");

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
}

const CREATIVE = {
  id: "cr-1",
  title: "Fallback title",
  formatKey: "seo.article",
  status: "APPROVED",
  currentVersionId: "v-1",
};
const VERSION = {
  id: "v-1",
  copy: `# Heading\n\n${words(200)}`,
  generationMetadata: {
    title: "How to price a plan",
    metaDescription: "A short description.",
    language: "en",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.creativeFindFirst.mockResolvedValue({ ...CREATIVE });
  mocks.versionFindFirst.mockResolvedValue({ ...VERSION });
});

describe("loadArticleForPublish", () => {
  it("loads an APPROVED SEO Manager article with its current version", async () => {
    const result = await loadArticleForPublish("proj-1", "cr-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article).toMatchObject({
      creativeId: "cr-1",
      versionId: "v-1",
      title: "How to price a plan",
      metaDescription: "A short description.",
      language: "en",
    });
    expect(result.article.words).toBeGreaterThanOrEqual(150);
    expect(mocks.creativeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cr-1", projectId: "proj-1" } }),
    );
    expect(mocks.versionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "v-1", creativeId: "cr-1" },
      }),
    );
  });

  it("allows a PUBLISHED article (marked as published by hand)", async () => {
    mocks.creativeFindFirst.mockResolvedValue({
      ...CREATIVE,
      status: "PUBLISHED",
    });
    expect((await loadArticleForPublish("proj-1", "cr-1")).ok).toBe(true);
  });

  it("falls back to the creative title and an empty description", async () => {
    mocks.versionFindFirst.mockResolvedValue({
      ...VERSION,
      generationMetadata: null,
    });
    const result = await loadArticleForPublish("proj-1", "cr-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.article.title).toBe("Fallback title");
    expect(result.article.metaDescription).toBe("");
    expect(result.article.language).toBeNull();
  });

  it("refuses an unknown creative or one from another project", async () => {
    mocks.creativeFindFirst.mockResolvedValue(null);
    expect(await loadArticleForPublish("proj-2", "cr-1")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("refuses a creative that is not a SEO article", async () => {
    mocks.creativeFindFirst.mockResolvedValue({
      ...CREATIVE,
      formatKey: "instagram.carousel",
    });
    expect(await loadArticleForPublish("proj-1", "cr-1")).toEqual({
      ok: false,
      reason: "not_article",
    });
  });

  it("refuses an SC-F7 DRAFT slot that has no version yet", async () => {
    mocks.creativeFindFirst.mockResolvedValue({
      ...CREATIVE,
      status: "DRAFT",
      currentVersionId: null,
    });
    expect(await loadArticleForPublish("proj-1", "cr-1")).toEqual({
      ok: false,
      reason: "not_reviewed",
    });
    expect(mocks.versionFindFirst).not.toHaveBeenCalled();
  });

  it.each(["ARCHIVED", "REJECTED", "DRAFT"])(
    "refuses a %s article",
    async (status) => {
      mocks.creativeFindFirst.mockResolvedValue({ ...CREATIVE, status });
      expect(await loadArticleForPublish("proj-1", "cr-1")).toEqual({
        ok: false,
        reason: "not_reviewed",
      });
    },
  );

  it("refuses an approved article without a current version", async () => {
    mocks.creativeFindFirst.mockResolvedValue({
      ...CREATIVE,
      currentVersionId: null,
    });
    expect(await loadArticleForPublish("proj-1", "cr-1")).toEqual({
      ok: false,
      reason: "no_version",
    });
  });

  it("refuses when the version row or its text is missing", async () => {
    mocks.versionFindFirst.mockResolvedValue({ ...VERSION, copy: null });
    expect(await loadArticleForPublish("proj-1", "cr-1")).toEqual({
      ok: false,
      reason: "no_version",
    });
    mocks.versionFindFirst.mockResolvedValue(null);
    expect(await loadArticleForPublish("proj-1", "cr-1")).toEqual({
      ok: false,
      reason: "no_version",
    });
  });

  it("refuses an article shorter than 150 words and passes the validator message on", async () => {
    mocks.versionFindFirst.mockResolvedValue({
      ...VERSION,
      copy: words(40),
    });
    const result = await loadArticleForPublish("proj-1", "cr-1");
    expect(result).toMatchObject({ ok: false, reason: "too_short" });
    if (result.ok) return;
    expect(result.message).toMatch(/150 words/);
  });
});
