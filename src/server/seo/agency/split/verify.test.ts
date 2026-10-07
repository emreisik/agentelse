import type { GscSplitTest } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: yalnız APPLIED test doğrulanır; tarayıcı yolu
// yalnız crawlerVerifiable testlerde ve yalnız kapsam içi adreslerde
// getirir (en çok 5 test + 3 kontrol); kapsam dışı, ikincil site, SeoSite
// yok ve diğer türler kullanıcı beyanıyla hemen ölçüme geçer; görülmeyen
// değişiklik 24 saat sonra yeniden denenir, 14. günde sorulur, 45. günde
// süresi dolar; süre bitince getirme yapılmaz; CMS yolu SeoChange durumuna
// bakar (hepsi doğrulandı / hata / bekliyor).

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  link: vi.fn(),
  pages: vi.fn(),
  scope: vi.fn(),
  site: vi.fn(),
  check: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSplitTest: { findUnique: mocks.findUnique, updateMany: mocks.update },
    gscSiteLink: { findUnique: mocks.link },
    gscPage: { findMany: mocks.pages },
  },
}));
vi.mock("./population", () => ({ splitSiteScope: mocks.scope }));
vi.mock("./apply-cms", () => ({ syncCmsChanges: mocks.sync }));
vi.mock("@/server/seo/actions/page-check", () => ({
  pageCheckSite: mocks.site,
  checkPage: mocks.check,
}));

const { verifySplitTest, isCrawlerVerifiable, parseBaseline } = await import("./verify");

const NOW = new Date("2026-09-10T12:00:00.000Z");
const APPLIED_AT = new Date("2026-09-08T12:00:00.000Z");

const BASELINE = {
  v: 1,
  test: ["t1", "t2", "t3"].map((id) => ({
    pageId: id,
    title: `Old ${id}`,
    metaDescription: null,
    schemaTypes: [],
  })),
  control: ["c1", "c2"].map((id) => ({
    pageId: id,
    title: `Ctl ${id}`,
    metaDescription: null,
    schemaTypes: [],
  })),
};

function row(over: Partial<GscSplitTest> = {}): GscSplitTest {
  return {
    id: "split-1",
    projectId: "project-1",
    linkId: "link-1",
    changeKind: "TITLE_META",
    status: "APPLIED",
    appliedVia: "MANUAL",
    appliedAt: APPLIED_AT,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    askedAt: null,
    change: { titlePattern: "{title} | Brand" },
    baseline: BASELINE,
    verification: null,
    cmsChanges: null,
    ...over,
  } as unknown as GscSplitTest;
}

function observed(title: string, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    page: {
      url: "https://example.com/x",
      status: 200,
      title,
      metaDescription: null,
      schemaTypes: [],
      fetchError: null,
      robotsBlocked: false,
      ...over,
    },
  };
}

// Hiçbir şey değişmemiş: sayfalar tabandaki hâliyle döner.
function unchangedPages(_site: unknown, url: string) {
  const id = url.slice(-2);
  return Promise.resolve(observed(url.includes("/t") ? `Old ${id}` : `Ctl ${id}`));
}

function lastUpdate() {
  return mocks.update.mock.calls.at(-1)?.[0] as { where: unknown; data: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(row());
  mocks.link.mockResolvedValue({ isPrimary: true, isSecondary: false });
  mocks.scope.mockResolvedValue({ siteId: "site-1", hosts: ["example.com"] });
  mocks.site.mockResolvedValue({ siteId: "site-1" });
  mocks.pages.mockResolvedValue(
    ["t1", "t2", "t3", "c1", "c2"].map((id) => ({ id, url: `https://example.com/${id}` })),
  );
  mocks.check.mockImplementation((_site: unknown, url: string) =>
    Promise.resolve(
      url.includes("/t")
        ? observed(`Old ${url.slice(-2)} | Brand`)
        : observed(`Ctl ${url.slice(-2)}`),
    ),
  );
  mocks.update.mockResolvedValue({ count: 1 });
});

describe("verifySplitTest crawler path", () => {
  it("verifies by crawler and starts measuring", async () => {
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    expect(mocks.check).toHaveBeenCalledTimes(5);
    const { where, data } = lastUpdate();
    expect(where).toEqual({ id: "split-1", status: "APPLIED" });
    expect(data.status).toBe("EVALUATING");
    expect(data.measureFrom).toEqual(APPLIED_AT);
    expect((data.verification as { method: string }).method).toBe("CRAWLER");
    expect(data.evaluateAfter).toEqual(new Date(APPLIED_AT.getTime() + 28 * 86_400_000));
  });

  it("only fetches in-scope sample pages", async () => {
    mocks.pages.mockResolvedValue([
      { id: "t1", url: "https://example.com/t1" },
      { id: "t2", url: "https://evil.example.org/t2" },
      { id: "t3", url: "https://example.com/t3" },
      { id: "c1", url: "https://example.com/c1" },
      { id: "c2", url: "https://elsewhere.net/c2" },
    ]);
    await verifySplitTest("split-1", NOW);
    const urls = mocks.check.mock.calls.map((call) => call[1]);
    expect(urls).toHaveLength(3);
    expect(urls.some((url: string) => url.includes("evil") || url.includes("elsewhere"))).toBe(false);
  });

  it("falls back to the user's word when no sample page is in scope", async () => {
    mocks.pages.mockResolvedValue([{ id: "t1", url: "https://other.org/t1" }]);
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    expect(mocks.check).not.toHaveBeenCalled();
    expect((lastUpdate().data.verification as { method: string }).method).toBe("USER");
  });

  it("retries a change that is not seen after a day", async () => {
    mocks.check.mockImplementation(unchangedPages);
    expect(await verifySplitTest("split-1", NOW)).toBe("pending");
    const { data } = lastUpdate();
    expect(data.nextCheckAt).toEqual(new Date(NOW.getTime() + 86_400_000));
    expect(data.status).toBeUndefined();
    expect((data.verification as { reason: string }).reason).toBe("NOT_SEEN");
  });

  it("asks the user on day 14 and expires on day 45", async () => {
    mocks.check.mockImplementation(unchangedPages);
    mocks.findUnique.mockResolvedValue(
      row({ appliedAt: new Date(NOW.getTime() - 15 * 86_400_000) }),
    );
    expect(await verifySplitTest("split-1", NOW)).toBe("asked");
    expect(lastUpdate().data.askedAt).toEqual(NOW);
    mocks.findUnique.mockResolvedValue(
      row({ appliedAt: new Date(NOW.getTime() - 46 * 86_400_000) }),
    );
    expect(await verifySplitTest("split-1", NOW)).toBe("expired");
    expect(lastUpdate().data.status).toBe("EXPIRED");
  });

  it("stops fetching when the time budget is gone", async () => {
    expect(await verifySplitTest("split-1", NOW, { remaining: () => 500 })).toBe("deadline");
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("uses the user's word when the site cannot be checked", async () => {
    mocks.site.mockResolvedValue(null);
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    const verification = lastUpdate().data.verification as { method: string; reason: string };
    expect(verification).toMatchObject({ method: "USER", reason: "NO_SITE" });
  });
});

describe("verifySplitTest user path", () => {
  it("never fetches a secondary site", async () => {
    mocks.link.mockResolvedValue({ isPrimary: false, isSecondary: true });
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    expect(mocks.site).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
    expect((lastUpdate().data.verification as { method: string }).method).toBe("USER");
  });

  it("verifies kinds the crawler cannot see", async () => {
    mocks.findUnique.mockResolvedValue(row({ changeKind: "CONTENT_BLOCK" }));
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    expect(mocks.check).not.toHaveBeenCalled();
    expect(lastUpdate().data.evaluateAfter).toEqual(new Date(APPLIED_AT.getTime() + 56 * 86_400_000));
  });

  it("verifies when the project has no site scope", async () => {
    mocks.scope.mockResolvedValue(null);
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("ignores tests that are not applied", async () => {
    mocks.findUnique.mockResolvedValue(row({ status: "EVALUATING" }));
    expect(await verifySplitTest("split-1", NOW)).toBe("pending");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reports pending when another worker already moved the test", async () => {
    mocks.findUnique.mockResolvedValue(row({ changeKind: "OTHER" }));
    mocks.update.mockResolvedValue({ count: 0 });
    expect(await verifySplitTest("split-1", NOW)).toBe("pending");
  });
});

describe("verifySplitTest CMS path", () => {
  const cmsRow = () => row({ appliedVia: "CMS" });

  it("measures from the last verified change when every change is verified", async () => {
    mocks.findUnique.mockResolvedValue(cmsRow());
    const verifiedAt = new Date("2026-09-09T08:00:00.000Z");
    mocks.sync.mockResolvedValue({ total: 3, verified: 3, failed: 0, waiting: 0, failedIds: [], allVerifiedAt: verifiedAt });
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    const { data } = lastUpdate();
    expect(data.measureFrom).toEqual(verifiedAt);
    expect((data.verification as { method: string }).method).toBe("CMS");
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("starts measuring on the verified subset once nothing is waiting and marks failed pages", async () => {
    mocks.findUnique.mockResolvedValue({
      ...cmsRow(),
      cmsChanges: {
        v: 1,
        items: [
          { pageId: "p1", changeId: "c1", skipped: null },
          { pageId: "p2", changeId: "c2", skipped: null },
          { pageId: "p3", changeId: null, skipped: "TOO_LONG" },
        ],
      },
    });
    const verifiedAt = new Date("2026-09-09T08:00:00.000Z");
    mocks.sync.mockResolvedValue({ total: 2, verified: 1, failed: 1, waiting: 0, failedIds: ["c2"], allVerifiedAt: verifiedAt });
    expect(await verifySplitTest("split-1", NOW)).toBe("verified");
    const { data } = lastUpdate();
    expect(data.status).toBe("EVALUATING");
    expect(data.measureFrom).toEqual(verifiedAt);
    expect((data.verification as { reason: unknown }).reason).toBeNull();
    expect(data.cmsChanges).toEqual({
      v: 1,
      items: [
        { pageId: "p1", changeId: "c1", skipped: null },
        { pageId: "p2", changeId: null, skipped: "FAILED" },
        { pageId: "p3", changeId: null, skipped: "TOO_LONG" },
      ],
    });
  });

  it("does not start measuring when every change failed", async () => {
    mocks.findUnique.mockResolvedValue(cmsRow());
    mocks.sync.mockResolvedValue({ total: 2, verified: 0, failed: 2, waiting: 0, failedIds: ["c1", "c2"], allVerifiedAt: null });
    expect(await verifySplitTest("split-1", NOW)).toBe("pending");
    expect(lastUpdate().data.status).toBeUndefined();
  });

  it("stays applied with a reason when a change failed", async () => {
    mocks.findUnique.mockResolvedValue(cmsRow());
    mocks.sync.mockResolvedValue({ total: 3, verified: 1, failed: 1, waiting: 1, failedIds: ["c2"], allVerifiedAt: null });
    expect(await verifySplitTest("split-1", NOW)).toBe("pending");
    const { data } = lastUpdate();
    expect(data.status).toBeUndefined();
    expect((data.verification as { reason: string }).reason).toBe("CMS_CHANGE_FAILED");
  });

  it("waits while changes are still waiting", async () => {
    mocks.findUnique.mockResolvedValue(cmsRow());
    mocks.sync.mockResolvedValue({ total: 3, verified: 1, failed: 0, waiting: 2, failedIds: [], allVerifiedAt: null });
    expect(await verifySplitTest("split-1", NOW)).toBe("pending");
    expect((lastUpdate().data.verification as { reason: unknown }).reason).toBeNull();
  });
});

describe("helpers", () => {
  it("decides crawlerVerifiable from kind, link, site and baseline", () => {
    const base = {
      kind: "TITLE_META" as const,
      change: { titlePattern: null, metaPattern: null, schemaType: null, note: null },
      baseline: parseBaseline(BASELINE),
      linkPrimary: true,
      hasSite: true,
    };
    expect(isCrawlerVerifiable(base)).toBe(true);
    expect(isCrawlerVerifiable({ ...base, baseline: null })).toBe(false);
    expect(isCrawlerVerifiable({ ...base, linkPrimary: false })).toBe(false);
    expect(isCrawlerVerifiable({ ...base, hasSite: false })).toBe(false);
    expect(isCrawlerVerifiable({ ...base, kind: "OTHER" })).toBe(false);
    expect(isCrawlerVerifiable({ ...base, kind: "SCHEMA", baseline: null })).toBe(false);
    expect(
      isCrawlerVerifiable({
        ...base,
        kind: "SCHEMA",
        baseline: null,
        change: { ...base.change, schemaType: "FAQPage" },
      }),
    ).toBe(true);
  });

  it("parses a baseline leniently", () => {
    expect(parseBaseline(null)).toBeNull();
    expect(parseBaseline({ test: [] })).toBeNull();
    expect(parseBaseline({ test: [{ pageId: "a" }, "x"], control: "no" })).toEqual({
      test: [{ pageId: "a", title: null, metaDescription: null, schemaTypes: [] }],
      control: [],
    });
  });
});
