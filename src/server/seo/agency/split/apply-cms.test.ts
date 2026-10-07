import type { GscSplitTest } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: loadApplyReady false iken hiçbir sorgu ve öneri
// yok; TITLE_META dışı tür, ikincil bağ ve 60 sayfadan büyük kol reddedilir;
// her test sayfası için sırayla öneri açılır; atlanan nedenler (başlık yok,
// çok uzun, reddedildi, kapsam dışı); öneri hiç açılamazsa test taslak kalır;
// syncCmsChanges sınıflandırır, tüm doğrulananlarda allVerifiedAt verir ve
// eksik tabloyu tolere eder.

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  propose: vi.fn(),
  crawled: vi.fn(),
  scope: vi.fn(),
  link: vi.fn(),
  assigned: vi.fn(),
  pages: vi.fn(),
  update: vi.fn(),
  changes: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: { findUnique: mocks.link },
    gscSplitTestPage: { findMany: mocks.assigned },
    gscPage: { findMany: mocks.pages },
    gscSplitTest: { updateMany: mocks.update },
    seoChange: { findMany: mocks.changes },
  },
}));
vi.mock("@/server/seo/apply/offers", () => ({ loadApplyReady: mocks.ready }));
vi.mock("@/server/seo/apply/propose", () => ({ proposeSeoChange: mocks.propose }));
vi.mock("@/server/seo/actions/page-check", () => ({ readCrawledPage: mocks.crawled }));
vi.mock("./population", () => ({ splitSiteScope: mocks.scope }));

const { proposeSplitChanges, syncCmsChanges, splitCmsReady } = await import("./apply-cms");

const NOW = new Date("2026-09-10T12:00:00.000Z");

function test(over: Partial<GscSplitTest> = {}): GscSplitTest {
  return {
    id: "split-1",
    projectId: "project-1",
    linkId: "link-1",
    changeKind: "TITLE_META",
    status: "DRAFT",
    testPages: 3,
    change: { titlePattern: "{title} | {site}", metaPattern: null },
    cmsChanges: null,
    ...over,
  } as unknown as GscSplitTest;
}

function crawledTitle(title: string | null) {
  return { snapshot: { title, h1: null, metaDescription: null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ready.mockResolvedValue(true);
  mocks.link.mockResolvedValue({ isPrimary: true, isSecondary: false });
  mocks.scope.mockResolvedValue({ siteId: "site-1", hosts: ["www.example.com", "example.com"] });
  mocks.assigned.mockResolvedValue([{ pageId: "a" }, { pageId: "b" }, { pageId: "c" }]);
  mocks.pages.mockResolvedValue([
    { id: "a", url: "https://www.example.com/a" },
    { id: "b", url: "https://www.example.com/b" },
    { id: "c", url: "https://www.example.com/c" },
  ]);
  mocks.crawled.mockResolvedValue(crawledTitle("Widgets"));
  mocks.propose.mockImplementation(({ url }: { url: string }) =>
    Promise.resolve({ ok: true, changeId: `chg-${url.slice(-1)}`, status: "PROPOSED", created: true }),
  );
  mocks.update.mockResolvedValue({ count: 1 });
});

describe("proposeSplitChanges", () => {
  it("is inert and query-free when the CMS path is not ready", async () => {
    mocks.ready.mockResolvedValue(false);
    const result = await proposeSplitChanges({ projectId: "project-1", userId: "u", test: test(), now: NOW });
    expect(result).toEqual({ proposed: 0, skipped: 0, items: [] });
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.assigned).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(await splitCmsReady("project-1")).toBe(false);
  });

  it("opens one proposal per test page and marks the test applied", async () => {
    const result = await proposeSplitChanges({ projectId: "project-1", userId: "u", test: test(), now: NOW });
    expect(result.proposed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(mocks.propose).toHaveBeenCalledTimes(3);
    expect(mocks.propose.mock.calls[0]?.[0]).toMatchObject({
      projectId: "project-1",
      userId: "u",
      kind: "TITLE_META",
      url: "https://www.example.com/a",
      title: "Widgets | example.com",
    });
    const update = mocks.update.mock.calls[0]?.[0];
    expect(update.where).toEqual({ id: "split-1", status: "DRAFT" });
    expect(update.data).toMatchObject({ appliedVia: "CMS", status: "APPLIED", appliedAt: NOW });
    expect(update.data.cmsChanges.items).toHaveLength(3);
  });

  it("refuses other kinds, secondary links and oversized arms", async () => {
    const run = (t: GscSplitTest) =>
      proposeSplitChanges({ projectId: "project-1", userId: "u", test: t, now: NOW });
    expect((await run(test({ changeKind: "SCHEMA" }))).proposed).toBe(0);
    expect((await run(test({ testPages: 61 }))).proposed).toBe(0);
    expect((await run(test({ status: "APPLIED" }))).proposed).toBe(0);
    expect((await run(test({ change: { titlePattern: null, metaPattern: null } }))).proposed).toBe(0);
    mocks.link.mockResolvedValue({ isPrimary: false, isSecondary: true });
    expect((await run(test())).proposed).toBe(0);
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("accepts an arm of exactly 60 pages", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => ({ pageId: `p${index}` }));
    mocks.assigned.mockResolvedValue(ids);
    mocks.pages.mockResolvedValue(ids.map((row) => ({ id: row.pageId, url: `https://example.com/${row.pageId}` })));
    const result = await proposeSplitChanges({
      projectId: "project-1",
      userId: "u",
      test: test({ testPages: 60 }),
      now: NOW,
    });
    expect(result.proposed).toBe(60);
  });

  it("skips pages with no title, a too-long result, a refusal or an out-of-scope URL", async () => {
    mocks.pages.mockResolvedValue([
      { id: "a", url: "https://www.example.com/a" },
      { id: "b", url: "https://www.example.com/b" },
      { id: "c", url: "https://evil.example.org/c" },
    ]);
    mocks.crawled.mockImplementation((_site: string, url: string) =>
      Promise.resolve(crawledTitle(url.endsWith("a") ? null : "x".repeat(80))),
    );
    const result = await proposeSplitChanges({ projectId: "project-1", userId: "u", test: test(), now: NOW });
    const byId = new Map(result.items.map((item) => [item.pageId, item.skipped]));
    expect(byId.get("a")).toBe("NO_TITLE");
    expect(byId.get("b")).toBe("TOO_LONG");
    expect(byId.get("c")).toBe("OUT_OF_SCOPE");
    expect(result.proposed).toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("records a refusal or a thrown error as REFUSED and never throws", async () => {
    mocks.propose
      .mockResolvedValueOnce({ ok: false, code: "not_allowed_here", message: "x" })
      .mockRejectedValueOnce(new Error("wp down"))
      .mockResolvedValueOnce({ ok: true, changeId: "chg-ok" });
    const result = await proposeSplitChanges({ projectId: "project-1", userId: "u", test: test(), now: NOW });
    expect(result.items.map((item) => item.skipped)).toEqual(["REFUSED", "REFUSED", null]);
    expect(result.proposed).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("treats everything as out of scope when the site has no scope", async () => {
    mocks.scope.mockResolvedValue(null);
    const result = await proposeSplitChanges({ projectId: "project-1", userId: "u", test: test(), now: NOW });
    expect(result.items.every((item) => item.skipped === "OUT_OF_SCOPE")).toBe(true);
    expect(mocks.propose).not.toHaveBeenCalled();
  });
});

describe("syncCmsChanges", () => {
  const cms = {
    v: 1,
    items: [
      { pageId: "a", changeId: "c1", skipped: null },
      { pageId: "b", changeId: "c2", skipped: null },
      { pageId: "c", changeId: null, skipped: "TOO_LONG" },
    ],
  };

  it("classifies the changes and takes the latest verification time", async () => {
    mocks.changes.mockResolvedValue([
      { id: "c1", status: "VERIFIED", verifiedAt: new Date("2026-09-02T00:00:00.000Z") },
      { id: "c2", status: "VERIFIED", verifiedAt: new Date("2026-09-04T00:00:00.000Z") },
    ]);
    const result = await syncCmsChanges(test({ cmsChanges: cms as never }), NOW);
    expect(result).toEqual({
      total: 2,
      verified: 2,
      failed: 0,
      waiting: 0,
      failedIds: [],
      allVerifiedAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(mocks.changes.mock.calls[0]?.[0].where).toEqual({ id: { in: ["c1", "c2"] }, projectId: "project-1" });
  });

  it("counts failed and waiting changes and gives no allVerifiedAt", async () => {
    mocks.changes.mockResolvedValue([{ id: "c1", status: "REJECTED", verifiedAt: null }]);
    const result = await syncCmsChanges(test({ cmsChanges: cms as never }), NOW);
    expect(result).toMatchObject({
      total: 2,
      verified: 0,
      failed: 2,
      waiting: 0,
      failedIds: ["c1", "c2"],
      allVerifiedAt: null,
    });
    mocks.changes.mockResolvedValue([
      { id: "c1", status: "APPLIED", verifiedAt: null },
      { id: "c2", status: "PROPOSED", verifiedAt: null },
    ]);
    expect(await syncCmsChanges(test({ cmsChanges: cms as never }), NOW)).toMatchObject({
      verified: 0,
      failed: 0,
      waiting: 2,
    });
  });

  it("tolerates a missing table", async () => {
    mocks.changes.mockRejectedValue(new Error("relation does not exist"));
    expect(await syncCmsChanges(test({ cmsChanges: cms as never }), NOW)).toEqual({
      total: 2,
      verified: 0,
      failed: 0,
      waiting: 2,
      failedIds: [],
      allVerifiedAt: null,
    });
  });

  it("gives the latest verification time once nothing is waiting, even if one change failed", async () => {
    mocks.changes.mockResolvedValue([
      { id: "c1", status: "VERIFIED", verifiedAt: new Date("2026-09-02T00:00:00.000Z") },
      { id: "c2", status: "FAILED", verifiedAt: null },
    ]);
    const result = await syncCmsChanges(test({ cmsChanges: cms as never }), NOW);
    expect(result).toMatchObject({
      verified: 1,
      failed: 1,
      waiting: 0,
      failedIds: ["c2"],
      allVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
    });
  });

  it("returns zeros without stored changes and does not query", async () => {
    expect(await syncCmsChanges(test(), NOW)).toEqual({
      total: 0,
      verified: 0,
      failed: 0,
      waiting: 0,
      failedIds: [],
      allVerifiedAt: null,
    });
    expect(mocks.changes).not.toHaveBeenCalled();
  });
});
