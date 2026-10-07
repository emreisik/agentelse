import { Prisma, type SeoSite } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: SeoSite projenin yaşam döngüsünü izler. Alan adı
// kalkınca ya da proje PAUSED olunca tarama verisi tek işlemde silinir ve
// zamanlar boşa (null) iner; silinen projenin satırı silinir; sayfa
// görüntülemesi (reset:false) hiçbir zaman sıfırlamaz; yarışta P2002 yeniden
// okur; "Delete audit data" doğrulamayı ve ayarları korur;
// forgetSearchConsoleData yalnız GSC kökenli durumu siler, resetScope ile GSC
// kapsamlı siteyi sıfırlar.

const mocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  projectFindMany: vi.fn(),
  siteFindUnique: vi.fn(),
  siteFindMany: vi.fn(),
  siteUpsert: vi.fn(),
  siteUpdate: vi.fn(),
  siteUpdateMany: vi.fn(),
  siteDeleteMany: vi.fn(),
  linkDeleteMany: vi.fn(),
  pageDeleteMany: vi.fn(),
  crawlDeleteMany: vi.fn(),
  crawlFindMany: vi.fn(),
  crawlUpdate: vi.fn(),
  cwvDeleteMany: vi.fn(),
  geoAuditDeleteMany: vi.fn(),
  gscLinkFindFirst: vi.fn(),
  gscLinkFindMany: vi.fn(),
  transaction: vi.fn(),
  resolve: vi.fn(),
  verify: vi.fn(),
  claimPeriodic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findUnique: mocks.projectFindUnique,
      findMany: mocks.projectFindMany,
    },
    seoSite: {
      findUnique: mocks.siteFindUnique,
      findMany: mocks.siteFindMany,
      upsert: mocks.siteUpsert,
      update: mocks.siteUpdate,
      updateMany: mocks.siteUpdateMany,
      deleteMany: mocks.siteDeleteMany,
    },
    seoLink: { deleteMany: mocks.linkDeleteMany },
    seoPage: { deleteMany: mocks.pageDeleteMany },
    seoCrawl: {
      deleteMany: mocks.crawlDeleteMany,
      findMany: mocks.crawlFindMany,
      update: mocks.crawlUpdate,
    },
    seoCwv: { deleteMany: mocks.cwvDeleteMany },
    seoGeoAudit: { deleteMany: mocks.geoAuditDeleteMany },
    gscSiteLink: {
      findFirst: mocks.gscLinkFindFirst,
      findMany: mocks.gscLinkFindMany,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/server/seo/store", () => ({ primaryGscLink: vi.fn() }));
vi.mock("./scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scope")>()),
  resolveSiteScope: mocks.resolve,
}));
vi.mock("./verify", () => ({ checkSiteVerification: mocks.verify }));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));

import { scopeFromGscSite, scopeFromVerifiedDomain } from "@/lib/seo/crawl-url";

import { SeoSites } from "./sites";

const NOW = new Date("2026-10-06T12:00:00Z");
const VERIFIED = scopeFromVerifiedDomain("example.com")!;
const GSC = scopeFromGscSite("sc-domain:example.com")!;

function site(overrides: Partial<SeoSite> = {}): SeoSite {
  return {
    id: "site-1",
    workspaceId: "ws-1",
    projectId: "p1",
    isMock: false,
    scope: { ...VERIFIED },
    scopeKey: VERIFIED.key,
    origin: "https://example.com",
    verifyToken: "token123",
    verifiedDomain: "example.com",
    verifyMethod: "DNS",
    verifiedAt: new Date("2026-09-01T00:00:00Z"),
    verifyCheckedAt: new Date("2026-09-01T00:00:00Z"),
    verifyFailures: 0,
    settings: { v: 1, crawlEnabled: true, pageLimit: 250 },
    robotsStatus: 200,
    robotsVerdict: "OK",
    robotsHash: "h",
    robotsBody: "User-agent: *",
    robotsPrevBody: null,
    robotsFetchedAt: NOW,
    robotsChangedAt: null,
    robotsFailures: 0,
    robotsRetryAt: null,
    httpRedirectsToHttps: true,
    httpCheckedAt: NOW,
    sitemaps: [],
    sitemapsCheckedAt: NOW,
    sitemapBaselineAt: NOW,
    gscSitemapsAt: null,
    gscSitemapsNextAt: null,
    crawlLeaseUntil: null,
    crawlLeaseOwner: null,
    crawlNextAt: NOW,
    crawlPausedUntil: null,
    crawlThrottles: 0,
    crawlBlocked: false,
    fullCrawlDueAt: NOW,
    lastFullCrawlAt: null,
    regressionDueAt: NOW,
    lastRegressionAt: null,
    lastCrawlError: null,
    inspectDay: null,
    inspectCount: 0,
    inspectBudget: 200,
    inspectNextAt: null,
    inspectLastRunAt: null,
    inspectPausedUntil: null,
    inspectQueue: null,
    cwvCheckedAt: null,
    healthScore: 80,
    healthParts: null,
    healthComputedAt: NOW,
    healthDueAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    workspaceId: "ws-1",
    status: "ACTIVE",
    domain: "example.com",
    ...overrides,
  };
}

type UpdateArgs = { where: { id: string }; data: Record<string, unknown> };

function resetUpdate(): UpdateArgs {
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  const call = mocks.siteUpdate.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0] as UpdateArgs;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fixture satırları gerçek kip (isMock: false); CI'nın mock kipi sızmasın.
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  mocks.transaction.mockImplementation(async (ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
  for (const fn of [
    mocks.linkDeleteMany,
    mocks.pageDeleteMany,
    mocks.crawlDeleteMany,
    mocks.cwvDeleteMany,
    mocks.geoAuditDeleteMany,
    mocks.siteDeleteMany,
  ]) {
    fn.mockResolvedValue({ count: 2 });
  }
  mocks.siteUpdate.mockImplementation(async (args: UpdateArgs) => ({
    ...site(),
    ...args.data,
  }));
  mocks.crawlFindMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SeoSites.ensureForProject", () => {
  it("resets the site and idles every schedule when the domain is removed", async () => {
    mocks.projectFindUnique.mockResolvedValue(project({ domain: null }));
    mocks.siteFindUnique.mockResolvedValue(site());
    mocks.resolve.mockResolvedValue(null);

    await SeoSites.ensureForProject("p1", NOW);

    for (const fn of [
      mocks.linkDeleteMany,
      mocks.pageDeleteMany,
      mocks.crawlDeleteMany,
      mocks.cwvDeleteMany,
      // SC-F8: AI arama görünürlüğü denetimi de silinir.
      mocks.geoAuditDeleteMany,
    ]) {
      expect(fn).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
    }
    const { data } = resetUpdate();
    expect(data.scope).toBe(Prisma.DbNull);
    expect(data.scopeKey).toBeNull();
    expect(data.crawlNextAt).toBeNull();
    expect(data.inspectNextAt).toBeNull();
    expect(data.gscSitemapsNextAt).toBeNull();
    expect(data.origin).toBeNull();
    expect(data.sitemapBaselineAt).toBeNull();
    expect(data.crawlLeaseOwner).toBeNull();
    expect(data.healthDueAt).toEqual(NOW);
    // Alan adı artık yok: doğrulama düşer.
    expect(data.verifiedDomain).toBeNull();
  });

  it("resets a PAUSED project's site without resolving a scope", async () => {
    mocks.projectFindUnique.mockResolvedValue(project({ status: "PAUSED" }));
    mocks.siteFindUnique.mockResolvedValue(site());

    await SeoSites.ensureForProject("p1", NOW);

    expect(mocks.resolve).not.toHaveBeenCalled();
    const { data } = resetUpdate();
    expect(data.crawlNextAt).toBeNull();
    expect(data.scopeKey).toBeNull();
    // Aynı alan adı: doğrulama korunur.
    expect(data).not.toHaveProperty("verifiedDomain");
  });

  it("deletes the current-mode rows of a deleted project", async () => {
    mocks.projectFindUnique.mockResolvedValue(null);

    const result = await SeoSites.ensureForProject("p1", NOW);

    expect(result).toBeNull();
    expect(mocks.siteDeleteMany).toHaveBeenCalledWith({
      where: { projectId: "p1", isMock: false },
    });
  });

  it("never resets on a page render (reset: false)", async () => {
    const existing = site();
    mocks.projectFindUnique.mockResolvedValue(project());
    mocks.siteFindUnique.mockResolvedValue(existing);
    mocks.resolve.mockResolvedValue({
      scope: GSC,
      via: "GSC",
      linkId: "link-1",
    });

    const result = await SeoSites.ensureForProject("p1", NOW, { reset: false });

    expect(result).toBe(existing);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.siteUpdate).not.toHaveBeenCalled();
  });

  it("resets and re-arms when the scope key changes", async () => {
    mocks.projectFindUnique.mockResolvedValue(project());
    mocks.siteFindUnique.mockResolvedValue(site());
    mocks.resolve.mockResolvedValue({
      scope: GSC,
      via: "GSC",
      linkId: "link-1",
    });

    await SeoSites.ensureForProject("p1", NOW);

    const { data } = resetUpdate();
    expect(data.scopeKey).toBe(GSC.key);
    expect(data.crawlNextAt).toEqual(NOW);
    expect(data.fullCrawlDueAt).toEqual(NOW);
    expect(data.regressionDueAt).toEqual(NOW);
    expect(data.inspectNextAt).toEqual(NOW);
    expect(data.gscSitemapsNextAt).toEqual(NOW);
  });

  it("re-reads the row when a concurrent create wins (P2002)", async () => {
    const winner = site();
    mocks.projectFindUnique.mockResolvedValue(project());
    mocks.siteFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    mocks.resolve.mockResolvedValue({
      scope: VERIFIED,
      via: "VERIFIED",
      linkId: null,
    });
    mocks.siteUpsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const result = await SeoSites.ensureForProject("p1", NOW);

    expect(result).toBe(winner);
    expect(mocks.siteFindUnique).toHaveBeenCalledTimes(2);
  });
});

describe("SeoSites.deleteAuditData", () => {
  it("deletes child rows and audit state but keeps verification and settings", async () => {
    mocks.siteFindUnique.mockResolvedValue(site());

    const deleted = await SeoSites.deleteAuditData("p1", NOW);

    expect(deleted).toBe(8);
    const { data } = resetUpdate();
    for (const key of [
      "verifyToken",
      "verifiedDomain",
      "verifyMethod",
      "verifiedAt",
      "settings",
      "scope",
      "scopeKey",
    ]) {
      expect(data).not.toHaveProperty(key);
    }
    expect(data.robotsBody).toBeNull();
    expect(data.sitemapBaselineAt).toBeNull();
    expect(data.inspectQueue).toBe(Prisma.DbNull);
    expect(data.healthScore).toBeNull();
    expect(data.crawlNextAt).toEqual(NOW);
  });
});

describe("SeoSites.forgetSearchConsoleData", () => {
  it("clears only Google-derived state without resetScope", async () => {
    mocks.siteFindMany.mockResolvedValue([
      site({ scope: { ...GSC }, scopeKey: GSC.key }),
    ]);
    mocks.crawlFindMany.mockResolvedValue([
      {
        id: "crawl-1",
        frontier: {
          v: 1,
          queue: [
            { u: "https://example.com/a", d: 1, s: "GSC" },
            { u: "https://example.com/b", d: 1, s: "CRAWL" },
          ],
        },
      },
    ]);

    const touched = await SeoSites.forgetSearchConsoleData(
      ["p1"],
      { resetScope: false },
      NOW,
    );

    expect(touched).toBe(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    const update = mocks.siteUpdate.mock.calls[0]![0] as UpdateArgs;
    expect(update.data.inspectQueue).toBe(Prisma.DbNull);
    expect(update.data.inspectCount).toBe(0);
    expect(update.data.healthParts).toBe(Prisma.DbNull);
    expect(update.data.healthDueAt).toEqual(NOW);
    expect(update.data).not.toHaveProperty("scopeKey");
    expect(mocks.crawlUpdate).toHaveBeenCalledWith({
      where: { id: "crawl-1" },
      data: {
        frontier: {
          v: 1,
          queue: [{ u: "https://example.com/b", d: 1, s: "CRAWL" }],
        },
      },
    });
    expect(mocks.pageDeleteMany).toHaveBeenCalledWith({
      where: {
        siteId: "site-1",
        discoveredVia: "GSC",
        inSitemap: false,
        inlinks: 0,
        path: { not: "/" },
      },
    });
  });

  it("resets GSC-scoped sites with resetScope and keeps verification", async () => {
    mocks.siteFindMany.mockResolvedValue([
      site({ scope: { ...GSC }, scopeKey: GSC.key }),
      site({ id: "site-2", projectId: "p2" }),
    ]);
    // Yeniden kurulum: proje silinmiş gibi davranır (sadece çağrıyı görmek için).
    mocks.projectFindUnique.mockResolvedValue(null);

    const touched = await SeoSites.forgetSearchConsoleData(
      ["p1", "p2"],
      { resetScope: true },
      NOW,
    );

    expect(touched).toBe(2);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.linkDeleteMany).toHaveBeenCalledWith({
      where: { siteId: "site-1" },
    });
    const resetCall = mocks.siteUpdate.mock.calls.find(
      (call) => (call[0] as UpdateArgs).where.id === "site-1",
    )![0] as UpdateArgs;
    expect(resetCall.data.scopeKey).toBeNull();
    expect(resetCall.data.crawlNextAt).toBeNull();
    expect(resetCall.data.inspectNextAt).toBeNull();
    expect(resetCall.data).not.toHaveProperty("verifiedDomain");
    // Doğrulanmış kapsamlı site sıfırlanmaz, yalnız GSC kökenli durumu silinir.
    const verifiedCall = mocks.siteUpdate.mock.calls.find(
      (call) => (call[0] as UpdateArgs).where.id === "site-2",
    )![0] as UpdateArgs;
    expect(verifiedCall.data).not.toHaveProperty("scopeKey");
    expect(verifiedCall.data.inspectQueue).toBe(Prisma.DbNull);
    // GSC kapsamı düşen proje yeniden kurulmaya çalışılır.
    expect(mocks.projectFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1" } }),
    );
  });

  it("does nothing for an empty list", async () => {
    expect(
      await SeoSites.forgetSearchConsoleData([], { resetScope: true }),
    ).toBe(0);
    expect(mocks.siteFindMany).not.toHaveBeenCalled();
  });
});
