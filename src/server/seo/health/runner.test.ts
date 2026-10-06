import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEALTH_EVERY_MS } from "@/lib/seo/audit-constants";
import type { SearchHealthInput } from "@/lib/seo/health/checks";

// Bu dosyanın kanıtladığı: SEO_HEALTH kapalıyken koşucu hiçbir sorgu yapmaz;
// aday sorgusu geçerli kipi, vadeyi ve izin listesini WHERE'e koyar; site
// healthDueAt CAS'ı ile sahiplenilir; taslaklar ve kaynak başına
// değerlendirilen türler bağdaştırıcıya gider, puan yazılır; durdurulmuş
// proje her şeyi çözer ve siteyi boşa alır (healthDueAt = null).

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  beat: vi.fn(),
  ok: vi.fn(),
  reconcileDue: vi.fn(),
  raise: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoSite: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
    },
  },
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: mocks.beat, ok: mocks.ok },
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { reconcileDue: mocks.reconcileDue },
}));
vi.mock("@/server/seo/health/alerts", () => ({
  raiseSeoAlerts: mocks.raise,
}));
vi.mock("@/server/seo/health/snapshot", () => ({
  loadHealthSnapshot: mocks.snapshot,
}));

const { SeoHealth, readSearchHealthScore } = await import("./runner");

const NOW = new Date("2026-10-06T12:00:00.000Z");

function input(overrides: Partial<SearchHealthInput> = {}): SearchHealthInput {
  return {
    now: NOW,
    projectStatus: "ACTIVE",
    scope: {
      kind: "VERIFIED_DOMAIN",
      root: "example.com",
      prefix: null,
      key: "VERIFIED_DOMAIN:example.com:",
    },
    crawlEnabled: true,
    crawlBlocked: false,
    lastFullCrawlAt: null,
    lastRegressionAt: new Date(NOW.getTime() - 3_600_000),
    lastFull: null,
    keyPages: [
      {
        url: "https://example.com/",
        path: "/",
        isHomepage: true,
        status: 200,
        fetchError: null,
        previousFetchError: null,
        noindexMeta: true,
        noindexHeader: false,
        canonical: null,
        renderRisk: false,
        schemaErrors: 0,
        checkedAt: new Date(NOW.getTime() - 3_600_000),
        inspection: null,
      },
    ],
    robots: null,
    sitemaps: null,
    homepageAssets: [],
    httpRedirectsToHttps: null,
    issues: null,
    technicalCleanShare: null,
    cwv: null,
    gsc: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SearchHealthInput> = {}, extra = {}) {
  const built = input(overrides);
  return {
    projectId: "p1",
    workspaceId: "w1",
    projectStatus: built.projectStatus,
    siteId: "site-1",
    hasScope: built.scope !== null,
    hasGscLink: built.gsc !== null,
    input: built,
    ...extra,
  };
}

beforeEach(() => {
  vi.stubEnv("SEO_HEALTH", "true");
  vi.stubEnv("SEO_ROLLOUT_PROJECTS", "");
  vi.stubEnv("SEO_DEV_PROJECTS", "");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.raise.mockResolvedValue({ raised: 1, resolved: 2 });
  mocks.reconcileDue.mockResolvedValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SeoHealth.runDue", () => {
  it("returns 0 without any query when SEO_HEALTH is off", async () => {
    vi.stubEnv("SEO_HEALTH", "false");
    expect(await SeoHealth.runDue(5, NOW)).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.beat).not.toHaveBeenCalled();
    expect(mocks.reconcileDue).not.toHaveBeenCalled();
  });

  it("puts the mode, due time and allow-list into the candidate query", async () => {
    vi.stubEnv("SEO_ROLLOUT_PROJECTS", "p1,p2");
    mocks.findMany.mockResolvedValue([]);
    await SeoHealth.runDue(5, NOW);
    expect(mocks.beat).toHaveBeenCalledWith("seo.health", NOW);
    expect(mocks.reconcileDue).toHaveBeenCalledWith(NOW);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isMock: false,
          healthDueAt: { not: null, lte: NOW },
          projectId: { in: ["p1", "p2"] },
        },
        take: 25,
      }),
    );
  });

  it("claims with a CAS on healthDueAt and skips a lost claim", async () => {
    const due = new Date(NOW.getTime() - 60_000);
    mocks.findMany.mockResolvedValue([
      { id: "site-1", projectId: "p1", healthDueAt: due },
      { id: "site-2", projectId: "p2", healthDueAt: due },
    ]);
    mocks.updateMany.mockImplementation(
      async (args: { where: { id: string }; data: object }) =>
        args.where.id === "site-1" && !("healthScore" in args.data)
          ? { count: 0 }
          : { count: 1 },
    );
    mocks.snapshot.mockResolvedValue(
      snapshot({}, { projectId: "p2", siteId: "site-2" }),
    );
    expect(await SeoHealth.runDue(5, NOW)).toBe(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "site-1", healthDueAt: due },
      data: { healthDueAt: new Date(NOW.getTime() + HEALTH_EVERY_MS) },
    });
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot).toHaveBeenCalledWith("p2", NOW);
  });

  it("stops at the limit", async () => {
    const due = new Date(NOW.getTime() - 60_000);
    mocks.findMany.mockResolvedValue(
      ["a", "b", "c"].map((id) => ({ id, projectId: id, healthDueAt: due })),
    );
    mocks.snapshot.mockResolvedValue(snapshot());
    expect(await SeoHealth.runDue(2, NOW)).toBe(2);
  });
});

describe("SeoHealth.evaluateProject", () => {
  it("raises drafts, passes the evaluated kinds per source and writes the score", async () => {
    mocks.snapshot.mockResolvedValue(snapshot());
    const result = await SeoHealth.evaluateProject("p1", NOW);

    expect(mocks.raise).toHaveBeenCalledTimes(1);
    const call = mocks.raise.mock.calls[0]![0] as {
      drafts: { kind: string }[];
      evaluated: { GSC: string[]; SEO: string[] };
      workspaceId: string;
    };
    expect(call.workspaceId).toBe("w1");
    expect(call.drafts.map((draft) => draft.kind)).toEqual([
      "SEO_KEY_PAGE_NOINDEX",
    ]);
    expect(call.evaluated.SEO).toContain("SEO_KEY_PAGE_NOINDEX");
    expect(call.evaluated.SEO).toContain("SEO_KEY_PAGE_ERROR");
    // GSC bağı yok: her GSC türü taslaksız değerlendirilir.
    expect(call.evaluated.GSC).toContain("GSC_SEARCH_DROP");
    // Robots girdisi yok: robots türleri açık kalır.
    expect(call.evaluated.SEO).not.toContain("SEO_ROBOTS_BLOCK");

    expect(result?.score.value).toBe(0);
    expect(result?.score.cappedByCritical).toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: expect.objectContaining({
        healthScore: 0,
        healthComputedAt: NOW,
      }),
    });
  });

  it("resolves everything and idles a paused project", async () => {
    mocks.snapshot.mockResolvedValue(snapshot({ projectStatus: "PAUSED" }));
    const result = await SeoHealth.evaluateProject("p1", NOW);
    const call = mocks.raise.mock.calls[0]![0] as {
      drafts: unknown[];
      evaluated: { GSC: string[]; SEO: string[] };
    };
    expect(call.drafts).toEqual([]);
    expect(call.evaluated.GSC.length + call.evaluated.SEO.length).toBe(35);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: expect.objectContaining({ healthDueAt: null, healthScore: null }),
    });
    expect(result?.score.value).toBeNull();
  });

  it("idles a project with no scope and no Search Console link", async () => {
    mocks.snapshot.mockResolvedValue(snapshot({ scope: null, gsc: null }));
    await SeoHealth.evaluateProject("p1", NOW);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: expect.objectContaining({ healthDueAt: null }),
    });
  });

  it("returns null for a missing project", async () => {
    mocks.snapshot.mockResolvedValue(null);
    expect(await SeoHealth.evaluateProject("gone", NOW)).toBeNull();
    expect(mocks.raise).not.toHaveBeenCalled();
  });
});

describe("readSearchHealthScore", () => {
  it("parses the stored score", async () => {
    mocks.findUnique.mockResolvedValue({
      healthComputedAt: NOW,
      healthParts: {
        value: 80,
        cappedByCritical: false,
        parts: [{ key: "data", score: 10, available: true }],
      },
    });
    const stored = await readSearchHealthScore("p1");
    expect(stored?.score.value).toBe(80);
    expect(stored?.score.parts[0]).toMatchObject({
      key: "data",
      label: "Data & connection",
      weight: 10,
    });
  });
});
