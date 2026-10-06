import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GscSiteLink, SeoSite } from "@prisma/client";

import { nextPacificMidnight } from "@/lib/seo/governor";
import { GoogleApiError } from "@/server/integrations/google/errors";

// Bu dosyanın kanıtladığı: bayraklar kapalıyken runDue ve syncDue
// veritabanına hiç gitmez; tur kilidi inspectLastRunAt + 60 sn'ye uyar ve
// kilit alınamazsa hiçbir şey okunmaz; gscSyncAllowedFor false ise site
// boşa alınır (not_allowed); dakikalık kota 15 dk, günlük kota PT gece
// yarısına kadar duraklatır; GSC sitemaps okuması her hata sınıfında
// gscSitemapsNextAt'i doğru geri çekilmeyle yazar.

const mocks = vi.hoisted(() => ({
  siteUpdateMany: vi.fn(),
  siteFindMany: vi.fn(),
  siteFindUnique: vi.fn(),
  siteFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  inspectionFindMany: vi.fn(),
  inspectionFindUnique: vi.fn(),
  inspectionCreate: vi.fn(),
  inspectionUpdate: vi.fn(),
  inspectionCount: vi.fn(),
  coverageFindFirst: vi.fn(),
  sitemapFindMany: vi.fn(),
  sitemapUpsert: vi.fn(),
  sitemapDeleteMany: vi.fn(),
  linkFindUnique: vi.fn(),
  credentialFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  primaryGscLink: vi.fn(),
  readTopPages: vi.fn(),
  gscDataThrough: vi.fn(),
  markHealthDue: vi.fn(),
  forProject: vi.fn(),
  parseInspectQueue: vi.fn(),
  appendInspectQueue: vi.fn(),
  removeFromInspectQueue: vi.fn(),
  refreshCoverageWeek: vi.fn(),
  listSitemaps: vi.fn(),
  token: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoSite: {
      updateMany: mocks.siteUpdateMany,
      findMany: mocks.siteFindMany,
      findUnique: mocks.siteFindUnique,
      findFirst: mocks.siteFindFirst,
    },
    seoPage: { findMany: mocks.pageFindMany },
    gscUrlInspection: {
      findMany: mocks.inspectionFindMany,
      findUnique: mocks.inspectionFindUnique,
      create: mocks.inspectionCreate,
      update: mocks.inspectionUpdate,
      count: mocks.inspectionCount,
    },
    gscCoverageWeek: { findFirst: mocks.coverageFindFirst },
    gscSitemap: {
      findMany: mocks.sitemapFindMany,
      upsert: mocks.sitemapUpsert,
      deleteMany: mocks.sitemapDeleteMany,
    },
    gscSiteLink: { findUnique: mocks.linkFindUnique },
    integrationCredential: { findUnique: mocks.credentialFindUnique },
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
  readTopPages: mocks.readTopPages,
  gscDataThrough: mocks.gscDataThrough,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: {
    markHealthDue: mocks.markHealthDue,
    forProject: mocks.forProject,
  },
}));
vi.mock("@/server/seo/site/inspect-queue", () => ({
  parseInspectQueue: mocks.parseInspectQueue,
  appendInspectQueue: mocks.appendInspectQueue,
  removeFromInspectQueue: mocks.removeFromInspectQueue,
}));
vi.mock("./coverage", () => ({
  refreshCoverageWeek: mocks.refreshCoverageWeek,
}));
vi.mock("@/server/integrations/search-console/sitemaps", () => ({
  listSearchConsoleSitemaps: mocks.listSitemaps,
}));
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken: mocks.token,
}));

const { SeoInspection, inspectionErrorOutcome } = await import("./inspection");
const { GscSitemaps, gscSitemapsRetryAt } = await import("./gsc-sitemaps");

const NOW = new Date("2026-10-06T18:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const SITE = {
  id: "site-1",
  workspaceId: "w1",
  projectId: "p1",
  isMock: true,
  inspectDay: null,
  inspectCount: 0,
  inspectBudget: 200,
  inspectQueue: [],
} as unknown as SeoSite;

const LINK = {
  id: "link-1",
  projectId: "p1",
  credentialId: "cred-1",
  siteUrl: "sc-domain:example.com",
  health: "OK",
} as unknown as GscSiteLink;

function quotaError(message: string): GoogleApiError {
  return new GoogleApiError(message, "RESOURCE_EXHAUSTED", { httpStatus: 429 });
}

function siteUpdates(): Record<string, unknown>[] {
  return mocks.siteUpdateMany.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SEO_DEV_PROJECTS", "");
  vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
  mocks.siteUpdateMany.mockResolvedValue({ count: 1 });
  mocks.siteFindUnique.mockResolvedValue(SITE);
  mocks.siteFindFirst.mockResolvedValue({ id: SITE.id });
  mocks.primaryGscLink.mockResolvedValue(LINK);
  mocks.parseInspectQueue.mockReturnValue([
    {
      url: "https://www.example.com/pricing",
      urlHash: "hash-pricing",
      requestedAt: NOW.toISOString(),
      by: "user",
    },
  ]);
  mocks.pageFindMany.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.inspectionCount.mockResolvedValue(0);
  mocks.inspectionFindMany.mockResolvedValue([]);
  mocks.inspectionFindUnique.mockResolvedValue(null);
  mocks.inspectionCreate.mockResolvedValue({});
  mocks.gscDataThrough.mockResolvedValue({
    through: null,
    finalThrough: null,
    earliest: null,
  });
  mocks.coverageFindFirst.mockResolvedValue({
    weekStart: new Date("2026-10-05T00:00:00.000Z"),
    computedAt: NOW,
  });
  mocks.executeRaw.mockResolvedValue(1);
  mocks.refreshCoverageWeek.mockResolvedValue(null);
  mocks.sitemapFindMany.mockResolvedValue([]);
  mocks.sitemapDeleteMany.mockResolvedValue({ count: 0 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SeoInspection.runDue", () => {
  it("returns 0 without touching the database when the flags are off", async () => {
    vi.stubEnv("SEO_HEALTH", "");
    await expect(SeoInspection.runDue(5, NOW)).resolves.toBe(0);
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("GSC_SYNC", "");
    await expect(SeoInspection.runDue(5, NOW)).resolves.toBe(0);
    expect(mocks.siteFindMany).not.toHaveBeenCalled();
    expect(mocks.siteUpdateMany).not.toHaveBeenCalled();
  });

  it("filters candidates by mode, schedule, pause and the allow-list", async () => {
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "p1");
    mocks.siteFindMany.mockResolvedValue([]);
    await SeoInspection.runDue(5, NOW);
    const where = (
      mocks.siteFindMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      }
    ).where;
    expect(where).toMatchObject({
      isMock: true,
      inspectNextAt: { not: null, lte: NOW },
      projectId: { in: ["p1"] },
    });
  });
});

describe("SeoInspection.runSite", () => {
  it("claims only when the last run is at least 60 s old", async () => {
    mocks.siteUpdateMany.mockResolvedValueOnce({ count: 0 });
    const result = await SeoInspection.runSite(SITE.id, {
      now: NOW,
      inspect: vi.fn(),
    });
    expect(result).toEqual({ inspected: 0, stopped: null });
    const claim = mocks.siteUpdateMany.mock.calls[0]![0] as {
      where: { AND: { OR: Record<string, unknown>[] }[] };
      data: Record<string, unknown>;
    };
    expect(claim.where.AND[1]!.OR).toEqual([
      { inspectLastRunAt: null },
      { inspectLastRunAt: { lte: new Date(NOW.getTime() - MINUTE) } },
    ]);
    expect(claim.data).toEqual({
      inspectLastRunAt: NOW,
      inspectNextAt: new Date(NOW.getTime() + MINUTE),
    });
    expect(mocks.siteFindUnique).not.toHaveBeenCalled();
  });

  it("idles the site when gscSyncAllowedFor is false", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "another-project");
    const inspect = vi.fn();
    const result = await SeoInspection.runSite(SITE.id, { now: NOW, inspect });
    expect(result).toEqual({ inspected: 0, stopped: "not_allowed" });
    expect(siteUpdates()[1]).toEqual({ inspectNextAt: null });
    expect(inspect).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("inspects a queued URL, stores it and drains the queue", async () => {
    const inspect = vi.fn().mockResolvedValue({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      indexingState: null,
      robotsTxtState: null,
      pageFetchState: null,
      googleCanonical: null,
      userCanonical: null,
      lastCrawlTime: null,
      crawledAs: null,
      sitemaps: [],
      referringUrls: [],
      richResults: null,
    });
    const result = await SeoInspection.runSite(SITE.id, { now: NOW, inspect });
    expect(result).toEqual({ inspected: 1, stopped: null });
    expect(inspect).toHaveBeenCalledWith(
      "mock-access-token",
      "sc-domain:example.com",
      "https://www.example.com/pricing",
    );
    expect(mocks.inspectionCreate).toHaveBeenCalledTimes(1);
    expect(mocks.removeFromInspectQueue).toHaveBeenCalledWith(SITE.id, [
      "hash-pricing",
    ]);
    expect(mocks.markHealthDue).toHaveBeenCalledWith(SITE.id, NOW);
    // Plan bitti: bir sonraki tur 15 dk sonra.
    expect(siteUpdates().at(-1)).toEqual({
      inspectNextAt: new Date(NOW.getTime() + 15 * MINUTE),
    });
  });

  it("pauses 15 minutes on a per-minute quota error", async () => {
    const inspect = vi
      .fn()
      .mockRejectedValue(
        quotaError(
          "Quota exceeded for 'Inspection requests per minute per site'",
        ),
      );
    const result = await SeoInspection.runSite(SITE.id, { now: NOW, inspect });
    expect(result).toEqual({ inspected: 0, stopped: "quota" });
    const until = new Date(NOW.getTime() + 15 * MINUTE);
    expect(siteUpdates()).toContainEqual({
      inspectPausedUntil: until,
      inspectNextAt: until,
    });
    expect(mocks.removeFromInspectQueue).not.toHaveBeenCalled();
  });

  it("pauses until the next Pacific midnight on a daily quota error", async () => {
    const inspect = vi
      .fn()
      .mockRejectedValue(
        quotaError("Quota exceeded for 'Inspection requests per day per site'"),
      );
    const result = await SeoInspection.runSite(SITE.id, { now: NOW, inspect });
    expect(result).toEqual({ inspected: 0, stopped: "quota" });
    const until = nextPacificMidnight(NOW);
    expect(until.toISOString()).toBe("2026-10-07T07:00:00.000Z");
    expect(siteUpdates()).toContainEqual({
      inspectPausedUntil: until,
      inspectNextAt: until,
    });
  });

  it("stops at the daily budget", async () => {
    mocks.executeRaw.mockResolvedValue(0);
    const inspect = vi.fn();
    const result = await SeoInspection.runSite(SITE.id, { now: NOW, inspect });
    expect(result).toEqual({ inspected: 0, stopped: "budget" });
    expect(inspect).not.toHaveBeenCalled();
    expect(siteUpdates().at(-1)).toEqual({
      inspectNextAt: nextPacificMidnight(NOW),
    });
  });

  it("waits 6 hours when the link needs the user", async () => {
    mocks.primaryGscLink.mockResolvedValue({ ...LINK, health: "ACCESS_LOST" });
    const result = await SeoInspection.runSite(SITE.id, {
      now: NOW,
      inspect: vi.fn(),
    });
    expect(result).toEqual({ inspected: 0, stopped: "auth" });
    expect(siteUpdates().at(-1)).toEqual({
      inspectNextAt: new Date(NOW.getTime() + 6 * HOUR),
    });
  });
});

describe("inspectionErrorOutcome", () => {
  it("maps error classes", () => {
    expect(
      inspectionErrorOutcome(
        new GoogleApiError("denied", "PERMISSION_DENIED", { httpStatus: 403 }),
        NOW,
      ),
    ).toEqual({ kind: "auth" });
    expect(
      inspectionErrorOutcome(
        new GoogleApiError("bad url", "INVALID_ARGUMENT", { httpStatus: 400 }),
        NOW,
      ),
    ).toEqual({ kind: "skip" });
    expect(
      inspectionErrorOutcome(
        new GoogleApiError("boom", "INTERNAL", { httpStatus: 500 }),
        NOW,
      ),
    ).toEqual({ kind: "count" });
    expect(inspectionErrorOutcome(new Error("x"), NOW)).toEqual({
      kind: "count",
    });
  });
});

describe("GscSitemaps", () => {
  it("returns 0 without touching the database when the flags are off", async () => {
    vi.stubEnv("SEO_HEALTH", "");
    await expect(GscSitemaps.syncDue(3, NOW)).resolves.toBe(0);
    expect(mocks.siteFindMany).not.toHaveBeenCalled();
  });

  it("writes gscSitemapsNextAt with the back-off of each error class", async () => {
    const cases: [unknown, Date][] = [
      [
        new GoogleApiError("expired", "UNAUTHENTICATED", { httpStatus: 401 }),
        new Date(NOW.getTime() + 6 * HOUR),
      ],
      [
        new GoogleApiError("gone", "NOT_FOUND", { httpStatus: 404 }),
        new Date(NOW.getTime() + 6 * HOUR),
      ],
      [quotaError("Quota exceeded per day"), nextPacificMidnight(NOW)],
      [
        quotaError("Quota exceeded per minute"),
        new Date(NOW.getTime() + 15 * MINUTE),
      ],
      [
        new GoogleApiError("boom", "INTERNAL", { httpStatus: 500 }),
        new Date(NOW.getTime() + HOUR),
      ],
      [new Error("network"), new Date(NOW.getTime() + HOUR)],
    ];
    for (const [error, expected] of cases) {
      mocks.siteUpdateMany.mockClear();
      mocks.linkFindUnique.mockResolvedValue(LINK);
      mocks.listSitemaps.mockRejectedValueOnce(error);
      await expect(GscSitemaps.syncLink(LINK.id, NOW)).resolves.toBe(0);
      expect(gscSitemapsRetryAt(error, NOW)).toEqual(expected);
      expect(mocks.siteUpdateMany).toHaveBeenCalledWith({
        where: { projectId: "p1", isMock: true },
        data: { gscSitemapsNextAt: expected },
      });
    }
  });

  it("upserts the list, deletes other paths and schedules the next read", async () => {
    mocks.linkFindUnique.mockResolvedValue(LINK);
    mocks.listSitemaps.mockResolvedValue([
      {
        path: "https://www.example.com/sitemap.xml",
        type: "sitemap",
        isIndex: false,
        isPending: false,
        lastSubmitted: "2026-01-15T09:00:00.000Z",
        lastDownloaded: "not a date",
        errors: 2,
        warnings: Number.NaN,
        contents: [
          { type: "web", submitted: 40 },
          { type: "image", submitted: 2 },
        ],
      },
    ]);
    mocks.sitemapDeleteMany.mockResolvedValue({ count: 1 });
    await expect(GscSitemaps.syncLink(LINK.id, NOW)).resolves.toBe(1);
    const upsert = mocks.sitemapUpsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
    };
    expect(upsert.create).toMatchObject({
      linkId: LINK.id,
      path: "https://www.example.com/sitemap.xml",
      errors: 2,
      warnings: 0,
      submittedCount: 42,
      lastSubmitted: new Date("2026-01-15T09:00:00.000Z"),
      lastDownloaded: null,
    });
    expect(mocks.sitemapDeleteMany).toHaveBeenCalledWith({
      where: {
        linkId: LINK.id,
        path: { notIn: ["https://www.example.com/sitemap.xml"] },
      },
    });
    expect(siteUpdates()).toContainEqual({
      gscSitemapsAt: NOW,
      gscSitemapsNextAt: new Date(NOW.getTime() + 24 * HOUR),
    });
    expect(mocks.markHealthDue).toHaveBeenCalledWith(SITE.id, NOW);
  });
});
