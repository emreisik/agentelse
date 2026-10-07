import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageSnapshot } from "@/lib/seo/actions/types";

// Hedef sayfa okuyucuları: ambar mı kendi tarayıcımız mı, getirme başarısız
// olunca tarayıcı kaydına düşme ve modele giden sorgu özetinin sınırı. Prisma,
// ambar okuyucuları ve sayfa denetimi sahte.

const mocks = vi.hoisted(() => ({
  primaryGscLink: vi.fn(),
  gscDataThrough: vi.fn(),
  readTopPages: vi.fn(),
  pageCheckSite: vi.fn(),
  checkPage: vi.fn(),
  readCrawledPage: vi.fn(),
  seoPageFindMany: vi.fn(),
  gscPageFindUnique: vi.fn(),
  groupBy: vi.fn(),
  gscQueryFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoPage: { findMany: mocks.seoPageFindMany },
    gscPage: { findUnique: mocks.gscPageFindUnique },
    gscWeeklyQueryPage: { groupBy: mocks.groupBy },
    gscQuery: { findMany: mocks.gscQueryFindMany },
  },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
  gscDataThrough: mocks.gscDataThrough,
  readTopPages: mocks.readTopPages,
}));
vi.mock("@/server/seo/actions/page-check", () => ({
  pageCheckSite: mocks.pageCheckSite,
  checkPage: mocks.checkPage,
  readCrawledPage: mocks.readCrawledPage,
}));

import {
  listTargetPages,
  pageQueriesForPrompt,
  readTarget,
} from "./target";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const PROJECT = "p1";

const SNAPSHOT: PageSnapshot = {
  url: "https://example.com/shoes",
  status: 200,
  title: "Running shoes",
  metaDescription: "All about running shoes.",
  h1: "Running shoes",
  h2: ["Cushioning", "Sizing"],
  canonical: "https://example.com/shoes",
  noindex: false,
  indexable: true,
  wordCount: 800,
  textHash: "abc",
  schemaTypes: [],
  schemaErrors: 0,
  fetchedAt: NOW.toISOString(),
  source: "FETCH",
};

const SITE = {
  siteId: "site1",
  projectId: PROJECT,
  origin: "https://example.com",
};

const originalSync = process.env.GSC_SYNC;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GSC_SYNC = "true";
  mocks.primaryGscLink.mockResolvedValue({ id: "link1" });
  mocks.gscDataThrough.mockResolvedValue({
    through: "2026-10-04",
    finalThrough: "2026-10-04",
    earliest: "2026-01-01",
  });
  mocks.pageCheckSite.mockResolvedValue(SITE);
  mocks.groupBy.mockResolvedValue([]);
  mocks.gscQueryFindMany.mockResolvedValue([]);
  mocks.gscPageFindUnique.mockResolvedValue({ id: "gp1" });
});

afterEach(() => {
  if (originalSync === undefined) delete process.env.GSC_SYNC;
  else process.env.GSC_SYNC = originalSync;
});

describe("listTargetPages", () => {
  it("ambar varsa sayfaları ambardan listeler ve maskelenenleri atlar", async () => {
    mocks.readTopPages.mockResolvedValue([
      {
        id: "g1",
        label: "/shoes",
        url: "https://example.com/shoes",
        isBrand: false,
        clicks: 40,
        impressions: 900,
        positionWeighted: 0,
      },
      {
        id: "g2",
        label: "/u/[id]",
        url: "https://example.com/u/[id]",
        isBrand: false,
        clicks: 9,
        impressions: 100,
        positionWeighted: 0,
      },
      {
        id: "g3",
        label: "/contact/jane.doe@example.com",
        url: "https://example.com/contact/jane.doe@example.com",
        isBrand: false,
        clicks: 5,
        impressions: 80,
        positionWeighted: 0,
      },
    ]);

    const pages = await listTargetPages(PROJECT, NOW);
    expect(pages).toEqual([
      {
        url: "https://example.com/shoes",
        path: "/shoes",
        clicks: 40,
        impressions: 900,
        source: "SEARCH",
      },
    ]);
    expect(mocks.seoPageFindMany).not.toHaveBeenCalled();
  });

  it("ambar boşsa kendi tarayıcımızın sayfalarına düşer", async () => {
    mocks.readTopPages.mockResolvedValue([]);
    mocks.seoPageFindMany.mockResolvedValue([
      { url: "https://example.com/", path: "/" },
      { url: "https://example.com/about", path: "/about" },
      { url: "https://example.com/p/[slug]", path: "/p/[slug]" },
    ]);

    const pages = await listTargetPages(PROJECT, NOW);
    expect(pages.map((page) => page.path)).toEqual(["/", "/about"]);
    expect(pages.every((page) => page.source === "SITE")).toBe(true);
    expect(pages[0]).toMatchObject({ clicks: null, impressions: null });
  });

  it("ambar bayrağı kapalıyken ambara bakmaz", async () => {
    delete process.env.GSC_SYNC;
    mocks.seoPageFindMany.mockResolvedValue([
      { url: "https://example.com/", path: "/" },
    ]);
    const pages = await listTargetPages(PROJECT, NOW);
    expect(mocks.readTopPages).not.toHaveBeenCalled();
    expect(pages).toHaveLength(1);
  });

  it("ambar okuması hata verirse tarayıcı sayfalarıyla sürer", async () => {
    mocks.readTopPages.mockRejectedValue(new Error("db down"));
    mocks.seoPageFindMany.mockResolvedValue([
      { url: "https://example.com/", path: "/" },
    ]);
    expect(await listTargetPages(PROJECT, NOW)).toHaveLength(1);
  });
});

describe("readTarget", () => {
  it("sayfayı okur, hedefi ve başlangıç görüntüsünü döndürür", async () => {
    mocks.checkPage.mockResolvedValue({
      ok: true,
      page: { ...SNAPSHOT, finalUrl: SNAPSHOT.url, hops: 0, fetchError: null, robotsBlocked: false, links: [] },
      text: "Page text",
    });
    mocks.groupBy.mockResolvedValue([
      { queryId: "q1", _sum: { clicks: 3, impressions: 90, positionWeighted: 450 } },
      { queryId: "q2", _sum: { clicks: 1, impressions: 30, positionWeighted: 240 } },
    ]);
    mocks.gscQueryFindMany.mockResolvedValue([
      { id: "q1", text: "running shoes" },
      { id: "q2", text: "best trainers" },
    ]);

    const result = await readTarget(PROJECT, SNAPSHOT.url, { textChars: 6000, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.checkPage).toHaveBeenCalledWith(
      SITE,
      SNAPSHOT.url,
      expect.objectContaining({ textChars: 6000 }),
    );
    expect(result.target).toMatchObject({
      url: SNAPSHOT.url,
      path: "/shoes",
      title: "Running shoes",
      h2: ["Cushioning", "Sizing"],
      queryCount: 2,
    });
    expect(result.baseline).toMatchObject({ source: "FETCH", title: "Running shoes" });
    // Sayfa gövdesine özgü alanlar başlangıç görüntüsüne sızmaz.
    expect(result.baseline).not.toHaveProperty("links");
    expect(result.text).toBe("Page text");
    // Sorgu metni hedefte yok, yalnız sayı.
    expect(JSON.stringify(result.target)).not.toContain("running shoes\"");
  });

  it("getirme başarısızsa tarayıcının kaydına düşer (metin yok)", async () => {
    mocks.checkPage.mockResolvedValue({ ok: false, reason: "FETCH_FAILED", page: null });
    mocks.readCrawledPage.mockResolvedValue({
      snapshot: { ...SNAPSHOT, source: "CRAWL" },
      crawled: { titleChanged: false, contentChanged: false, lastChangedAt: null },
      firstSeenAt: NOW,
    });

    const result = await readTarget(PROJECT, SNAPSHOT.url);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.source).toBe("CRAWL");
    expect(result.text).toBeNull();
  });

  it("getirme başarısız ve kayıt da yoksa nedenini söyler", async () => {
    mocks.checkPage.mockResolvedValue({ ok: false, reason: "FETCH_FAILED", page: null });
    mocks.readCrawledPage.mockResolvedValue(null);
    const result = await readTarget(PROJECT, SNAPSHOT.url);
    expect(result).toEqual({
      ok: false,
      message: "Couldn't read that page. Try again in a moment.",
    });
  });

  it("kapsam dışı adresi ve robots engelini ayrı ayrı bildirir", async () => {
    mocks.checkPage.mockResolvedValueOnce({ ok: false, reason: "OUT_OF_SCOPE", page: null });
    expect(await readTarget(PROJECT, "https://other.com/x")).toEqual({
      ok: false,
      message: "That address isn't on your verified site.",
    });
    mocks.checkPage.mockResolvedValueOnce({ ok: false, reason: "ROBOTS", page: null });
    const robots = await readTarget(PROJECT, SNAPSHOT.url);
    expect(robots.ok).toBe(false);
    expect(mocks.readCrawledPage).not.toHaveBeenCalled();
  });

  it("site yoksa ya da adres geçersizse sayfayı denemez", async () => {
    mocks.pageCheckSite.mockResolvedValue(null);
    expect((await readTarget(PROJECT, SNAPSHOT.url)).ok).toBe(false);
    expect((await readTarget(PROJECT, "not a url")).ok).toBe(false);
    expect(mocks.checkPage).not.toHaveBeenCalled();
  });
});

describe("pageQueriesForPrompt", () => {
  it("en çok 10 maskelenmiş sorgu döndürür", async () => {
    const ids = Array.from({ length: 15 }, (_, index) => `q${index}`);
    mocks.groupBy.mockResolvedValue(
      ids.map((queryId, index) => ({
        queryId,
        _sum: { clicks: 1, impressions: 100 - index, positionWeighted: (100 - index) * 6 },
      })),
    );
    mocks.gscQueryFindMany.mockResolvedValue(
      ids.map((id, index) =>
        index === 0
          ? { id, text: "mail me at jane.doe@example.com" }
          : { id, text: `query ${index}` },
      ),
    );

    const rows = await pageQueriesForPrompt(PROJECT, "https://example.com/shoes", NOW);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.text).toBe("mail me at [email]");
    expect(rows[0]).toMatchObject({ impressions: 100, clicks: 1, position: 6 });
    expect(rows.map((row) => row.text).join(" ")).not.toContain("@");
  });

  it("bağ ya da sayfa yoksa boş döner ve sorgu atmaz", async () => {
    mocks.primaryGscLink.mockResolvedValue(null);
    expect(await pageQueriesForPrompt(PROJECT, "https://example.com/x")).toEqual([]);
    mocks.primaryGscLink.mockResolvedValue({ id: "link1" });
    mocks.gscPageFindUnique.mockResolvedValue(null);
    expect(await pageQueriesForPrompt(PROJECT, "https://example.com/x")).toEqual([]);
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
});
