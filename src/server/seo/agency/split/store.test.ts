import type { GscSplitTest } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SplitCandidate } from "@/lib/seo/agency/split/assign";

// Bu dosyanın kanıtladığı: bayrak kapalıyken hiçbir giriş noktası veritabanına
// gitmez; create doğrulama kodlarını (NOT_ALLOWED, NO_LINK, INVALID, LIMIT,
// NOT_ELIGIBLE) ve her grup için 100 sayfa tabanını uygular, açık testlerin
// sayfalarını nüfustan çıkarır, atamayı test kimliğiyle yapıp 1000'lik
// parçalarla yazar, taban örneğini yalnız birincil bağda alır; liste
// görünümü ikincil sitede CMS ve tarayıcı doğrulamasını kapatır ve BigInt/Date
// sızdırmaz; markApplied tarih kurallarını uygular ve doğrulanamayan testleri
// hemen EVALUATING yapar; cancel, checkNow (10 dk sınırı), runDue (kira, süre,
// dev koruması, 30 günlük taslak süre aşımı).

const mocks = vi.hoisted(() => ({
  linkFindFirst: vi.fn(),
  linkFindUnique: vi.fn(),
  linkFindMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  pages: vi.fn(),
  audit: vi.fn(),
  listGroups: vi.fn(),
  readPopulation: vi.fn(),
  openPageIds: vi.fn(),
  scope: vi.fn(),
  cmsReady: vi.fn(),
  cmsSync: vi.fn(),
  cmsPropose: vi.fn(),
  evaluate: vi.fn(),
  verify: vi.fn(),
  crawled: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: {
      findFirst: mocks.linkFindFirst,
      findUnique: mocks.linkFindUnique,
      findMany: mocks.linkFindMany,
    },
    gscSplitTest: {
      count: mocks.count,
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      updateMany: mocks.update,
    },
    gscPage: { findMany: mocks.pages },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        gscSplitTest: { create: mocks.create },
        gscSplitTestPage: { createMany: mocks.createMany },
      }),
  },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));
vi.mock("@/server/seo/agency/page-groups", () => ({
  GscPageGroups: { listGroups: mocks.listGroups },
}));
vi.mock("./population", () => ({
  readPopulation: mocks.readPopulation,
  openPageIds: mocks.openPageIds,
  splitSiteScope: mocks.scope,
}));
vi.mock("./apply-cms", () => ({
  splitCmsReady: mocks.cmsReady,
  syncCmsChanges: mocks.cmsSync,
  proposeSplitChanges: mocks.cmsPropose,
}));
vi.mock("./evaluate", () => ({ evaluateSplitTest: mocks.evaluate }));
vi.mock("./verify", async (original) => ({
  ...(await original<typeof import("./verify")>()),
  verifySplitTest: mocks.verify,
}));
vi.mock("@/server/seo/actions/page-check", () => ({
  readCrawledPage: mocks.crawled,
  checkPage: vi.fn(),
  pageCheckSite: vi.fn(),
}));

const { GscSplitTests } = await import("./store");

const NOW = new Date("2026-09-10T12:00:00.000Z");

function pool(groups: readonly string[], per = 120): SplitCandidate[] {
  return groups.flatMap((group) =>
    Array.from({ length: per }, (_, index) => ({
      pageId: `${group.slice(1)}-${index}`,
      group,
      preClicks: Math.max(1, 200 - index),
      preImpressions: 1000,
    })),
  );
}

function population(groups: readonly string[] = ["/a"], per = 120) {
  const candidates = pool(groups, per);
  return { candidates, coveredWeeks: 8, totalPages: candidates.length, capped: false };
}

type CreateInput = Parameters<typeof GscSplitTests.create>[0];

const BASE_CREATE: CreateInput = {
  projectId: "project-1",
  linkId: "link-1",
  userId: "user-1",
  name: "Title test",
  changeKind: "TITLE_META",
  description: null,
  pageGroups: ["/a"],
  change: { titlePattern: "{title} | {site}", metaPattern: null, schemaType: null, note: null },
  now: NOW,
};

function row(over: Partial<GscSplitTest> = {}): GscSplitTest {
  return {
    id: "split-1",
    workspaceId: "ws-1",
    projectId: "project-1",
    linkId: "link-1",
    isMock: false,
    name: "Title test",
    changeKind: "TITLE_META",
    description: null,
    status: "DRAFT",
    population: { v: 1, pageGroups: ["/a"], capped: false, preWeeks: [] },
    seed: "split-1",
    testPages: 60,
    controlPages: 60,
    balance: {
      testClicks: 1000,
      controlClicks: 990,
      ratio: 0.99,
      recommended: false,
      perGroup: [{ group: "/a", test: 60, control: 60 }],
    },
    change: { titlePattern: "{title} | {site}", metaPattern: null, schemaType: null, note: null },
    appliedVia: null,
    appliedAt: null,
    appliedByUserId: null,
    cmsChanges: null,
    baseline: {
      v: 1,
      test: [{ pageId: "a-1", title: "Old", metaDescription: null, schemaTypes: [] }],
      control: [],
    },
    verification: null,
    verifyAttempts: 0,
    askedAt: null,
    measureFrom: null,
    windowDays: 28,
    evaluateAfter: null,
    nextCheckAt: null,
    evaluation: null,
    outcome: null,
    confidence: null,
    evaluatedAt: null,
    leaseUntil: null,
    leaseOwner: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-09-09T00:00:00.000Z"),
    updatedAt: NOW,
    ...over,
  } as unknown as GscSplitTest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  mocks.linkFindFirst.mockResolvedValue({
    id: "link-1",
    workspaceId: "ws-1",
    isPrimary: true,
    isSecondary: false,
  });
  mocks.linkFindUnique.mockResolvedValue({ isPrimary: true, isSecondary: false });
  mocks.linkFindMany.mockResolvedValue([{ id: "link-1", isPrimary: true, isSecondary: false }]);
  mocks.count.mockResolvedValue(0);
  mocks.listGroups.mockResolvedValue([
    { group: "/a", pages: 500 },
    { group: "/b", pages: 500 },
    { group: "/c", pages: 500 },
  ]);
  mocks.openPageIds.mockResolvedValue(new Set<string>());
  mocks.readPopulation.mockResolvedValue(population());
  mocks.scope.mockResolvedValue({ siteId: "site-1", hosts: ["example.com"] });
  mocks.cmsReady.mockResolvedValue(true);
  mocks.cmsSync.mockResolvedValue({ total: 0, verified: 0, failed: 0, waiting: 0, allVerifiedAt: null });
  mocks.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve(row({ ...(data as Partial<GscSplitTest>), createdAt: NOW })),
  );
  mocks.createMany.mockResolvedValue({ count: 0 });
  mocks.pages.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
    Promise.resolve(where.id.in.map((id) => ({ id, url: `https://example.com/${id}` }))),
  );
  mocks.crawled.mockResolvedValue({
    snapshot: { title: "Old title", metaDescription: "Old meta", schemaTypes: [] },
  });
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.audit.mockResolvedValue({});
  mocks.verify.mockResolvedValue("pending");
  mocks.evaluate.mockResolvedValue("evaluated");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("flag off", () => {
  it("never reaches the database", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    expect(await GscSplitTests.list("project-1")).toEqual([]);
    expect(await GscSplitTests.get("project-1", "split-1")).toBeNull();
    expect(await GscSplitTests.runDue(5, NOW)).toBe(0);
    expect(await GscSplitTests.checkNow("project-1", "split-1", NOW)).toBe("not_found");
    expect(await GscSplitTests.create(BASE_CREATE)).toMatchObject({ ok: false, code: "NOT_ALLOWED" });
    expect(await GscSplitTests.populationPreview(BASE_CREATE)).toMatchObject({ ok: false });
    expect(await GscSplitTests.markApplied({ projectId: "p", testId: "t", userId: "u", appliedOn: "2026-09-09", now: NOW })).toMatchObject({ ok: false });
    expect(await GscSplitTests.cancel({ projectId: "p", testId: "t", userId: "u" })).toMatchObject({ ok: false });
    expect(await GscSplitTests.applyViaCms({ projectId: "p", testId: "t", userId: "u" })).toMatchObject({ ok: false });
    for (const fn of [mocks.linkFindFirst, mocks.findMany, mocks.findFirst, mocks.update, mocks.count]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("is also off without GSC_SYNC", async () => {
    vi.stubEnv("GSC_SYNC", "");
    expect(await GscSplitTests.runDue(5, NOW)).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("create", () => {
  it("creates a test with arms assigned from the test id", async () => {
    const result = await GscSplitTests.create(BASE_CREATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = mocks.create.mock.calls[0]?.[0].data;
    expect(data.seed).toBe(data.id);
    expect(data.testPages + data.controlPages).toBe(120);
    expect(data.windowDays).toBe(28);
    expect(data.status).toBe("DRAFT");
    const rows = mocks.createMany.mock.calls.flatMap((call) => call[0].data);
    expect(rows).toHaveLength(120);
    expect(rows.every((r: { pageGroup: string; testId: string }) => r.pageGroup === "/a" && r.testId === data.id)).toBe(true);
    expect(new Set(rows.map((r: { pageId: string }) => r.pageId)).size).toBe(120);
    expect(result.test.canApplyViaCms).toBe(true);
    expect(result.test.crawlerVerifiable).toBe(true);
    expect(result.test.pageGroups).toEqual(["/a"]);
    expect(JSON.stringify(result.test)).not.toContain("BigInt");
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "gsc_split_test.created",
      entityId: expect.any(String),
    });
  });

  it("writes the assignment in chunks of 1000", async () => {
    mocks.readPopulation.mockResolvedValue(population(["/a", "/b", "/c"], 1200));
    await GscSplitTests.create({ ...BASE_CREATE, pageGroups: ["/a", "/b", "/c"] });
    expect(mocks.createMany).toHaveBeenCalledTimes(4);
    expect(mocks.createMany.mock.calls[0]?.[0].data).toHaveLength(1000);
  });

  it("passes the pages of open tests as exclusions", async () => {
    mocks.openPageIds.mockResolvedValue(new Set(["x1", "x2"]));
    await GscSplitTests.create(BASE_CREATE);
    expect(mocks.readPopulation.mock.calls[0]?.[0].excludePageIds).toEqual(new Set(["x1", "x2"]));
    expect(mocks.openPageIds).toHaveBeenCalledWith({ projectId: "project-1", linkId: "link-1", isMock: false });
  });

  it("refuses a link that is not the project's", async () => {
    mocks.linkFindFirst.mockResolvedValue(null);
    expect(await GscSplitTests.create(BASE_CREATE)).toMatchObject({ ok: false, code: "NO_LINK" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("validates the input", async () => {
    const code = async (over: Partial<CreateInput>) => {
      const result = await GscSplitTests.create({ ...BASE_CREATE, ...over });
      return result.ok ? "OK" : result.code;
    };
    expect(await code({ name: "   " })).toBe("INVALID");
    expect(await code({ name: "x".repeat(81) })).toBe("INVALID");
    expect(await code({ description: "x".repeat(301) })).toBe("INVALID");
    expect(await code({ pageGroups: [] })).toBe("INVALID");
    expect(await code({ pageGroups: ["/a", "/b", "/c", "/d", "/e", "/f"] })).toBe("INVALID");
    expect(await code({ pageGroups: ["/missing"] })).toBe("INVALID");
    expect(await code({ change: { ...BASE_CREATE.change, titlePattern: "{bogus}" } })).toBe("INVALID");
    expect(await code({ change: { ...BASE_CREATE.change, metaPattern: "{title" } })).toBe("INVALID");
    expect(await code({ change: { ...BASE_CREATE.change, schemaType: "FAQ Page!" } })).toBe("INVALID");
    expect(await code({ changeKind: "SCHEMA", change: { ...BASE_CREATE.change, titlePattern: null } })).toBe("INVALID");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("accepts a schema test and a test with no patterns", async () => {
    const schema = await GscSplitTests.create({
      ...BASE_CREATE,
      changeKind: "SCHEMA",
      change: { titlePattern: null, metaPattern: null, schemaType: "FAQPage", note: null },
    });
    expect(schema.ok).toBe(true);
    const other = await GscSplitTests.create({
      ...BASE_CREATE,
      changeKind: "OTHER",
      change: { titlePattern: "{title}", metaPattern: null, schemaType: null, note: "Moved the CTA" },
    });
    expect(other.ok).toBe(true);
    const stored = mocks.create.mock.calls[1]?.[0].data.change;
    expect(stored).toEqual({ titlePattern: null, metaPattern: null, schemaType: null, note: "Moved the CTA" });
  });

  it("limits a site to three open tests", async () => {
    mocks.count.mockResolvedValue(3);
    expect(await GscSplitTests.create(BASE_CREATE)).toMatchObject({ ok: false, code: "LIMIT" });
    expect(mocks.readPopulation).not.toHaveBeenCalled();
  });

  it("refuses a group below 100 pages per group", async () => {
    mocks.readPopulation.mockResolvedValue(population(["/a", "/b"], 99));
    const result = await GscSplitTests.create({ ...BASE_CREATE, pageGroups: ["/a", "/b"] });
    expect(result).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
      message: "Each page group needs at least 100 pages with search traffic.",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses without enough history", async () => {
    mocks.readPopulation.mockResolvedValue({ ...population(), coveredWeeks: 2 });
    expect(await GscSplitTests.create(BASE_CREATE)).toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
      message: "We need at least four weeks of page data before a test can start.",
    });
  });

  it("takes no baseline and offers no CMS or crawler on a secondary site", async () => {
    mocks.linkFindFirst.mockResolvedValue({ id: "link-1", workspaceId: "ws-1", isPrimary: false, isSecondary: true });
    mocks.linkFindMany.mockResolvedValue([{ id: "link-1", isPrimary: false, isSecondary: true }]);
    const result = await GscSplitTests.create(BASE_CREATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.crawled).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0]?.[0].data.baseline).toBeUndefined();
    expect(result.test.isSecondarySite).toBe(true);
    expect(result.test.canApplyViaCms).toBe(false);
    expect(result.test.crawlerVerifiable).toBe(false);
  });

  it("samples a baseline only for in-scope pages of the primary site", async () => {
    mocks.pages.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(
        where.id.in.map((id) => ({
          id,
          url: id.endsWith("1") || id.endsWith("3") ? `https://evil.example.org/${id}` : `https://example.com/${id}`,
        })),
      ),
    );
    await GscSplitTests.create(BASE_CREATE);
    const urls = mocks.crawled.mock.calls.map((call) => call[1] as string);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith("https://example.com/"))).toBe(true);
    expect(mocks.create.mock.calls[0]?.[0].data.baseline).toMatchObject({ v: 1 });
  });

  it("takes no baseline for kinds the crawler cannot verify", async () => {
    await GscSplitTests.create({ ...BASE_CREATE, changeKind: "CONTENT_BLOCK" });
    expect(mocks.crawled).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0]?.[0].data.baseline).toBeUndefined();
  });
});

describe("populationPreview", () => {
  it("returns eligibility, page count and per-group counts", async () => {
    mocks.readPopulation.mockResolvedValue(population(["/a", "/b"], 110));
    const result = await GscSplitTests.populationPreview({
      projectId: "project-1",
      linkId: "link-1",
      pageGroups: ["/a", "/b"],
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, pages: 220, capped: false });
    if (!result.ok) return;
    expect(result.groups).toEqual([
      { group: "/a", pages: 110 },
      { group: "/b", pages: 110 },
    ]);
    expect(result.eligibility.ok).toBe(true);
  });

  it("refuses an empty or oversized group list and a foreign link", async () => {
    expect(await GscSplitTests.populationPreview({ projectId: "project-1", linkId: "link-1", pageGroups: [] })).toMatchObject({ ok: false });
    mocks.linkFindFirst.mockResolvedValue(null);
    expect(await GscSplitTests.populationPreview({ projectId: "project-1", linkId: "link-x", pageGroups: ["/a"] })).toMatchObject({ ok: false });
  });
});

describe("list", () => {
  it("serialises a test without Dates, BigInt or raw Json", async () => {
    mocks.findMany.mockResolvedValue([row()]);
    const [view] = await GscSplitTests.list("project-1");
    expect(view?.createdAt).toBe("2026-09-09T00:00:00.000Z");
    expect(view?.arms).toEqual({ test: 60, control: 60 });
    expect(view?.perGroup).toEqual([{ group: "/a", test: 60, control: 60 }]);
    expect(view?.change.titlePattern).toBe("{title} | {site}");
    expect(view?.canApplyViaCms).toBe(true);
    expect(view?.crawlerVerifiable).toBe(true);
    expect(() => JSON.stringify(view)).not.toThrow();
    expect(mocks.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 50, orderBy: { createdAt: "desc" } });
  });

  it("asks whether the CMS path is ready once per list", async () => {
    mocks.findMany.mockResolvedValue([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    await GscSplitTests.list("project-1");
    expect(mocks.cmsReady).toHaveBeenCalledTimes(1);
  });

  it("offers the CMS only for small title tests that are still drafts", async () => {
    mocks.findMany.mockResolvedValue([
      row({ id: "big", testPages: 61 }),
      row({ id: "schema", changeKind: "SCHEMA" }),
      row({ id: "applied", status: "APPLIED" }),
      row({ id: "nopattern", change: { titlePattern: null, metaPattern: null } as never }),
    ]);
    const views = await GscSplitTests.list("project-1");
    expect(views.map((view) => view.canApplyViaCms)).toEqual([false, false, false, false]);
    mocks.cmsReady.mockResolvedValue(false);
    mocks.findMany.mockResolvedValue([row()]);
    expect((await GscSplitTests.list("project-1"))[0]?.canApplyViaCms).toBe(false);
  });

  it("reads CMS progress for applied CMS tests", async () => {
    mocks.findMany.mockResolvedValue([row({ status: "APPLIED", appliedVia: "CMS" })]);
    mocks.cmsSync.mockResolvedValue({ total: 4, verified: 2, failed: 1, waiting: 1, allVerifiedAt: null });
    const [view] = await GscSplitTests.list("project-1");
    expect(view?.cms).toEqual({ total: 4, verified: 2, failed: 1, waiting: 1 });
  });

  it("filters by site and mode", async () => {
    mocks.findMany.mockResolvedValue([]);
    await GscSplitTests.list("project-1", "link-9");
    expect(mocks.findMany.mock.calls[0]?.[0].where).toEqual({ projectId: "project-1", isMock: false, linkId: "link-9" });
  });

  it("returns a single test or null", async () => {
    mocks.findFirst.mockResolvedValue(row());
    expect((await GscSplitTests.get("project-1", "split-1"))?.id).toBe("split-1");
    mocks.findFirst.mockResolvedValue(null);
    expect(await GscSplitTests.get("project-1", "nope")).toBeNull();
  });
});

describe("markApplied", () => {
  const input = { projectId: "project-1", testId: "split-1", userId: "user-1", now: NOW };

  beforeEach(() => {
    mocks.findFirst.mockResolvedValue(row());
  });

  it("sends a crawler-verifiable test to the crawler", async () => {
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "2026-09-09" })).toEqual({ ok: true });
    const { where, data } = mocks.update.mock.calls[0]?.[0];
    expect(where).toEqual({ id: "split-1", status: "DRAFT" });
    expect(data).toMatchObject({ status: "APPLIED", appliedVia: "MANUAL", nextCheckAt: NOW });
    expect(data.appliedAt).toEqual(new Date("2026-09-09T12:00:00.000Z"));
    expect(mocks.audit.mock.calls[0]?.[0].action).toBe("gsc_split_test.applied");
  });

  it("rejects a future day, a day older than 60 days and a bad format", async () => {
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "2026-09-11" })).toEqual({ ok: false, message: "That day is in the future." });
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "2026-07-01" })).toEqual({ ok: false, message: "That was more than 60 days ago." });
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "yesterday" })).toMatchObject({ ok: false });
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "2026-09-10" })).toEqual({ ok: true });
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "2026-07-12" })).toEqual({ ok: true });
  });

  it("starts measuring at once for kinds the crawler cannot see", async () => {
    mocks.findFirst.mockResolvedValue(row({ changeKind: "TEMPLATE_CHANGE" }));
    await GscSplitTests.markApplied({ ...input, appliedOn: "2026-07-16" });
    const { data } = mocks.update.mock.calls[0]?.[0];
    const appliedAt = new Date("2026-07-16T12:00:00.000Z");
    expect(data.status).toBe("EVALUATING");
    expect(data.measureFrom).toEqual(appliedAt);
    expect(data.evaluateAfter).toEqual(new Date(appliedAt.getTime() + 28 * 86_400_000));
    expect(data.verification.method).toBe("USER");
  });

  it("starts measuring at once on a secondary site and without a SeoSite", async () => {
    mocks.linkFindUnique.mockResolvedValue({ isPrimary: false, isSecondary: true });
    await GscSplitTests.markApplied({ ...input, appliedOn: "2026-09-09" });
    expect(mocks.update.mock.calls[0]?.[0].data.status).toBe("EVALUATING");
    mocks.linkFindUnique.mockResolvedValue({ isPrimary: true, isSecondary: false });
    mocks.scope.mockResolvedValue(null);
    await GscSplitTests.markApplied({ ...input, appliedOn: "2026-09-09" });
    expect(mocks.update.mock.calls[1]?.[0].data.status).toBe("EVALUATING");
  });

  it("refuses a test that is not a draft", async () => {
    mocks.findFirst.mockResolvedValue(row({ status: "APPLIED" }));
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "2026-09-09" })).toMatchObject({ ok: false });
    mocks.findFirst.mockResolvedValue(row());
    mocks.update.mockResolvedValue({ count: 0 });
    expect(await GscSplitTests.markApplied({ ...input, appliedOn: "2026-09-09" })).toMatchObject({ ok: false });
  });
});

describe("applyViaCms", () => {
  it("proposes through apply-cms and reports the counts", async () => {
    mocks.findFirst.mockResolvedValue(row());
    mocks.cmsPropose.mockResolvedValue({ proposed: 5, skipped: 1, items: [] });
    expect(await GscSplitTests.applyViaCms({ projectId: "project-1", testId: "split-1", userId: "u", now: NOW })).toEqual({
      ok: true,
      proposed: 5,
      skipped: 1,
    });
    expect(mocks.cmsPropose.mock.calls[0]?.[0]).toMatchObject({ projectId: "project-1", userId: "u", now: NOW });
  });

  it("explains when nothing could be proposed", async () => {
    mocks.findFirst.mockResolvedValue(row());
    mocks.cmsPropose.mockResolvedValue({ proposed: 0, skipped: 4, items: [] });
    const result = await GscSplitTests.applyViaCms({ projectId: "project-1", testId: "split-1", userId: "u" });
    expect(result.ok).toBe(false);
    mocks.cmsPropose.mockResolvedValue({ proposed: 0, skipped: 0, items: [] });
    expect(await GscSplitTests.applyViaCms({ projectId: "project-1", testId: "split-1", userId: "u" })).toMatchObject({ ok: false });
  });

  it("refuses a missing or non-draft test", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await GscSplitTests.applyViaCms({ projectId: "project-1", testId: "x", userId: "u" })).toMatchObject({ ok: false });
    mocks.findFirst.mockResolvedValue(row({ status: "EVALUATING" }));
    expect(await GscSplitTests.applyViaCms({ projectId: "project-1", testId: "x", userId: "u" })).toMatchObject({ ok: false });
    expect(mocks.cmsPropose).not.toHaveBeenCalled();
  });
});

describe("cancel", () => {
  it("cancels an open test and audits it", async () => {
    mocks.findFirst.mockResolvedValue(row({ status: "EVALUATING" }));
    expect(await GscSplitTests.cancel({ projectId: "project-1", testId: "split-1", userId: "u" })).toEqual({ ok: true });
    expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "split-1", status: { in: ["DRAFT", "APPLIED", "EVALUATING"] } },
      data: { status: "CANCELLED", nextCheckAt: null },
    });
    expect(mocks.audit.mock.calls[0]?.[0].action).toBe("gsc_split_test.cancelled");
  });

  it("refuses a finished or unknown test", async () => {
    mocks.findFirst.mockResolvedValue(row({ status: "WORKED" }));
    mocks.update.mockResolvedValue({ count: 0 });
    expect(await GscSplitTests.cancel({ projectId: "project-1", testId: "split-1", userId: "u" })).toMatchObject({ ok: false });
    mocks.findFirst.mockResolvedValue(null);
    expect(await GscSplitTests.cancel({ projectId: "project-1", testId: "x", userId: "u" })).toMatchObject({ ok: false });
  });
});

describe("checkNow", () => {
  it("queues a check and throttles to once per ten minutes", async () => {
    mocks.findFirst.mockResolvedValue(row({ status: "APPLIED" }));
    expect(await GscSplitTests.checkNow("project-1", "split-1", NOW)).toBe("queued");
    expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({ data: { nextCheckAt: NOW } });
    mocks.findFirst.mockResolvedValue(
      row({
        status: "APPLIED",
        verification: { v: 1, attempts: 1, lastCheckedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), checks: [], method: null, reason: null },
      }),
    );
    expect(await GscSplitTests.checkNow("project-1", "split-1", NOW)).toBe("too_soon");
  });

  it("is not found for drafts, finished and unknown tests", async () => {
    mocks.findFirst.mockResolvedValue(row({ status: "DRAFT" }));
    expect(await GscSplitTests.checkNow("project-1", "split-1", NOW)).toBe("not_found");
    mocks.findFirst.mockResolvedValue(null);
    expect(await GscSplitTests.checkNow("project-1", "x", NOW)).toBe("not_found");
  });
});

describe("runDue", () => {
  const due = [
    { id: "a1", projectId: "project-1", status: "APPLIED" },
    { id: "e1", projectId: "project-1", status: "EVALUATING" },
    { id: "a2", projectId: "project-1", status: "APPLIED" },
  ];

  beforeEach(() => {
    mocks.findMany.mockResolvedValue(due);
  });

  it("verifies applied tests, evaluates measuring ones and releases each lease", async () => {
    expect(await GscSplitTests.runDue(5, NOW)).toBe(3);
    expect(mocks.verify.mock.calls.map((call) => call[0])).toEqual(["a1", "a2"]);
    expect(mocks.evaluate.mock.calls.map((call) => call[0])).toEqual(["e1"]);
    const releases = mocks.update.mock.calls.filter((call) => call[0].data.leaseOwner === null);
    expect(releases).toHaveLength(3);
  });

  it("expires drafts older than 30 days first", async () => {
    await GscSplitTests.runDue(5, NOW);
    const sweep = mocks.update.mock.calls[0]?.[0];
    expect(sweep.where.status).toBe("DRAFT");
    expect(sweep.where.createdAt.lt).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
    expect(sweep.data.status).toBe("EXPIRED");
  });

  it("respects the limit", async () => {
    expect(await GscSplitTests.runDue(2, NOW)).toBe(2);
    expect(mocks.verify.mock.calls.length + mocks.evaluate.mock.calls.length).toBe(2);
  });

  it("skips a test whose lease another worker holds", async () => {
    mocks.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ count: data.leaseOwner === undefined || data.leaseOwner === null ? 1 : 0 }),
    );
    expect(await GscSplitTests.runDue(5, NOW)).toBe(0);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("does not start a test once the deadline has passed", async () => {
    expect(await GscSplitTests.runDue(5, NOW, Date.now() - 1)).toBe(0);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("keeps going and releases the lease when a test throws", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await GscSplitTests.runDue(5, NOW)).toBe(3);
    warn.mockRestore();
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
  });

  it("does nothing in a dev process with an empty allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com:5432/live");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
    expect(await GscSplitTests.runDue(5, NOW)).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("limits a dev process to the allow-listed projects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com:5432/live");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "project-1");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
    mocks.findMany.mockResolvedValue([{ id: "a1", projectId: "project-1", status: "APPLIED" }, { id: "z9", projectId: "project-9", status: "APPLIED" }]);
    await GscSplitTests.runDue(5, NOW);
    expect(mocks.findMany.mock.calls[0]?.[0].where.projectId).toEqual({ in: ["project-1"] });
    expect(mocks.verify.mock.calls.map((call) => call[0])).toEqual(["a1"]);
  });
});
