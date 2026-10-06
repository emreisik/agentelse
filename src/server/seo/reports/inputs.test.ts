import { Prisma, type GscSiteLink } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: SEO_HEALTH kapalıyken sağlık, uyarı, güncelleme ve
// yeni-CRITICAL okuyucuları ne veritabanına ne W2'ye dokunur; fırsat ve eylem
// okuyucuları yalnız SEO_INSIGHTS=on ve izinli projede çalışır; sıralı delta
// sorgusu tablo adlarını yalnız sabit haritadan alır (sorgu/sayfa × hafta/ay);
// yeni-CRITICAL sayımı ACKED'i ve susturma koşulunu içerir; dil geri dönüşü
// ReasoningService ile aynı ("tr").

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  alertCount: vi.fn(),
  projectFindUnique: vi.fn(),
  findingFindMany: vi.fn(),
  creativeFindMany: vi.fn(),
  listSearchAlerts: vi.fn(),
  readCoverage: vi.fn(),
  readLatestCwv: vi.fn(),
  readSearchHealthScore: vi.fn(),
  recentUpdates: vi.fn(),
  listProjectFindings: vi.fn(),
  primaryGscLink: vi.fn(),
  readGscDays: vi.fn(),
  readPeriodCoverage: vi.fn(),
  timezone: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    adsAlert: { count: mocks.alertCount },
    project: { findUnique: mocks.projectFindUnique },
    seoFinding: { findMany: mocks.findingFindMany },
    creative: { findMany: mocks.creativeFindMany },
  },
}));
vi.mock("@/server/seo/health/alerts", () => ({
  listSearchAlerts: mocks.listSearchAlerts,
}));
vi.mock("@/server/seo/health/coverage", () => ({
  readCoverage: mocks.readCoverage,
}));
vi.mock("@/server/seo/health/cwv", () => ({
  readLatestCwv: mocks.readLatestCwv,
}));
vi.mock("@/server/seo/health/runner", () => ({
  readSearchHealthScore: mocks.readSearchHealthScore,
}));
vi.mock("@/server/seo/health/updates", () => ({
  SearchUpdates: { recent: mocks.recentUpdates },
}));
vi.mock("@/server/seo/opportunities/findings-store", () => ({
  listProjectFindings: mocks.listProjectFindings,
}));
vi.mock("@/server/seo/opportunities/panel", () => ({
  ACTION_LABEL: { TITLE_META: "Fix the snippet", INVESTIGATE: "Look into it" },
  EFFORT_LABEL: { S: "Quick fix", VARIES: "Varies" },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
  readGscDays: mocks.readGscDays,
  readPeriodCoverage: mocks.readPeriodCoverage,
}));
vi.mock("@/server/seo/readers", () => ({ readQuickWinRows: vi.fn() }));
vi.mock("@/server/seo/brand-terms", () => ({
  brandSplitStatus: () => "none",
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: mocks.timezone,
}));
vi.mock("@/server/modules/seo/calendar", () => ({
  SEO_FORMAT_KEY: "seo.article",
}));

const {
  RANKED_SOURCES,
  countNewCriticalAlerts,
  readActions,
  readHealthSummary,
  readOpenSearchAlerts,
  readOpportunities,
  readRankedDeltas,
  readUpdates,
  reportContextForLink,
} = await import("./inputs");

const NOW = new Date("2026-10-07T12:00:00.000Z");

function link(overrides: Partial<GscSiteLink> = {}): GscSiteLink {
  return {
    id: "link1",
    projectId: "p1",
    workspaceId: "w1",
    siteUrl: "sc-domain:example.com",
    lastFinalDate: "2026-10-04",
    brandTerms: null,
    brandSeriesHash: null,
    ...overrides,
  } as GscSiteLink;
}

function sqlOf(call: unknown[]): Prisma.Sql {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
}

function expectNoDatabase() {
  expect(mocks.queryRaw).not.toHaveBeenCalled();
  expect(mocks.alertCount).not.toHaveBeenCalled();
  expect(mocks.projectFindUnique).not.toHaveBeenCalled();
  expect(mocks.findingFindMany).not.toHaveBeenCalled();
  expect(mocks.creativeFindMany).not.toHaveBeenCalled();
  expect(mocks.listSearchAlerts).not.toHaveBeenCalled();
  expect(mocks.readCoverage).not.toHaveBeenCalled();
  expect(mocks.readLatestCwv).not.toHaveBeenCalled();
  expect(mocks.readSearchHealthScore).not.toHaveBeenCalled();
  expect(mocks.recentUpdates).not.toHaveBeenCalled();
  expect(mocks.listProjectFindings).not.toHaveBeenCalled();
  expect(mocks.primaryGscLink).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SEO_HEALTH", "");
  vi.stubEnv("SEO_INSIGHTS", "");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reportContextForLink", () => {
  beforeEach(() => {
    mocks.timezone.mockResolvedValue("Europe/Istanbul");
  });

  it("falls back to 'tr' like ReasoningService when the project has no language", async () => {
    mocks.projectFindUnique.mockResolvedValue({
      language: "",
      brands: [{ id: "b1" }],
    });
    const ctx = await reportContextForLink(link());
    expect(ctx).toMatchObject({
      language: "tr",
      brandId: "b1",
      timezone: "Europe/Istanbul",
      finalThrough: "2026-10-04",
      brandSplitReady: false,
    });
  });

  it("keeps the project's language", async () => {
    mocks.projectFindUnique.mockResolvedValue({
      language: "de",
      brands: [{ id: "b1" }],
    });
    expect((await reportContextForLink(link()))?.language).toBe("de");
  });

  it("returns null without a final day or a default brand", async () => {
    expect(
      await reportContextForLink(link({ lastFinalDate: null })),
    ).toBeNull();
    mocks.projectFindUnique.mockResolvedValue({ language: "en", brands: [] });
    expect(await reportContextForLink(link())).toBeNull();
  });

  it("uses UTC when the timezone cannot be read", async () => {
    mocks.timezone.mockRejectedValue(new Error("db"));
    mocks.projectFindUnique.mockResolvedValue({
      language: "en",
      brands: [{ id: "b1" }],
    });
    expect((await reportContextForLink(link()))?.timezone).toBe("UTC");
  });
});

describe("SEO_HEALTH gate", () => {
  it("makes no database or W2 call while the flag is off", async () => {
    expect(await readHealthSummary("p1")).toBeNull();
    expect(await readOpenSearchAlerts("p1")).toBeNull();
    expect(
      await readUpdates({ from: "2026-09-01", to: "2026-09-30" }, NOW),
    ).toBeNull();
    expect(await countNewCriticalAlerts("p1", NOW, NOW)).toBe(0);
    expectNoDatabase();
  });

  it("builds the health summary with CRITICAL issues first once the flag is on", async () => {
    vi.stubEnv("SEO_HEALTH", "true");
    mocks.readSearchHealthScore.mockResolvedValue({
      score: { value: 72, cappedByCritical: true, parts: [] },
      computedAt: NOW,
    });
    mocks.listSearchAlerts.mockResolvedValue([
      alert("WARN", "Slow pages", "2026-10-06T10:00:00Z"),
      alert("CRITICAL", "Robots blocks the site", "2026-10-01T10:00:00Z"),
      alert("INFO", "New sitemap", "2026-10-06T11:00:00Z"),
    ]);
    mocks.readCoverage.mockResolvedValue({
      current: { point: 0.9, low: 0.8, high: 0.95, weekStart: "2026-10-05" },
    });
    const health = await readHealthSummary("p1");
    expect(health).toMatchObject({
      score: 72,
      cappedByCritical: true,
      critical: 1,
      warn: 1,
      coverage: { point: 0.9, low: 0.8, high: 0.95, weekStart: "2026-10-05" },
      cwv: null,
    });
    expect(health?.issues.map((issue) => issue.title)).toEqual([
      "Robots blocks the site",
      "Slow pages",
      "New sitemap",
    ]);
  });

  it("returns null when nothing is known", async () => {
    vi.stubEnv("SEO_HEALTH", "true");
    mocks.readSearchHealthScore.mockResolvedValue(null);
    mocks.listSearchAlerts.mockResolvedValue([]);
    mocks.readCoverage.mockResolvedValue(null);
    expect(await readHealthSummary("p1")).toBeNull();
  });

  it("maps the open alerts to kind, title and severity", async () => {
    vi.stubEnv("SEO_HEALTH", "true");
    mocks.listSearchAlerts.mockResolvedValue([
      alert("CRITICAL", "Robots blocks the site", "2026-10-01T10:00:00Z"),
    ]);
    expect(await readOpenSearchAlerts("p1")).toEqual([
      {
        kind: "SEO_ROBOTS_BLOCK",
        title: "Robots blocks the site",
        severity: "CRITICAL",
      },
    ]);
  });

  it("filters the updates to ranking updates and incidents, with a 3 day lead", async () => {
    vi.stubEnv("SEO_HEALTH", "true");
    mocks.recentUpdates.mockResolvedValue([
      update("Core update", "CORE", "2026-09-29T00:00:00Z", null),
      update("Discover update", "DISCOVER", "2026-09-29T00:00:00Z", null),
      update(
        "Old update",
        "SPAM",
        "2026-08-01T00:00:00Z",
        "2026-08-05T00:00:00Z",
      ),
      update(
        "Crawling issue",
        "CRAWLING",
        "2026-09-10T00:00:00Z",
        "2026-09-12T00:00:00Z",
      ),
    ]);
    const items = await readUpdates(
      { from: "2026-09-01", to: "2026-09-30" },
      NOW,
    );
    expect(items?.map((item) => item.name)).toEqual([
      "Core update",
      "Crawling issue",
    ]);
    expect(items?.[0]).toMatchObject({
      startedAt: "2026-09-29T00:00:00.000Z",
      endedAt: null,
    });
    // 29 Ağustos 00:00 UTC'den şimdiye kadar yeterli bakış penceresi.
    expect(mocks.recentUpdates).toHaveBeenCalledWith(NOW, 41);
  });
});

describe("countNewCriticalAlerts", () => {
  it("counts OPEN and ACKED critical GSC/SEO alerts that are not muted", async () => {
    vi.stubEnv("SEO_HEALTH", "true");
    mocks.alertCount.mockResolvedValue(2);
    const since = new Date("2026-10-01T00:00:00Z");
    expect(await countNewCriticalAlerts("p1", since, NOW)).toBe(2);
    expect(mocks.alertCount).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        source: { in: ["GSC", "SEO"] },
        severity: "CRITICAL",
        status: { in: ["OPEN", "ACKED"] },
        OR: [{ mutedUntil: null }, { mutedUntil: { lte: NOW } }],
        firstSeenAt: { gte: since },
      },
    });
  });
});

describe("SEO_INSIGHTS gate", () => {
  const range = {
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-10-08T00:00:00Z"),
  };

  it.each(["", "off", "shadow", "ON"])(
    "makes no call with SEO_INSIGHTS=%j",
    async (value) => {
      vi.stubEnv("SEO_INSIGHTS", value);
      expect(await readOpportunities("p1")).toBeNull();
      expect(await readActions("p1", range)).toBeNull();
      expectNoDatabase();
    },
  );

  it("makes no call for a project outside the rollout list", async () => {
    vi.stubEnv("SEO_INSIGHTS", "on");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other");
    expect(await readOpportunities("p1")).toBeNull();
    expect(await readActions("p1", range)).toBeNull();
    expectNoDatabase();
  });

  it("reads the findings once the engine is user-facing", async () => {
    vi.stubEnv("SEO_INSIGHTS", "on");
    mocks.listProjectFindings.mockResolvedValue([
      {
        id: "f1",
        title: "Fix the snippet of /pricing",
        actionKind: "TITLE_META",
        effort: "S",
        confidence: "SIGNIFICANT",
        status: "OPEN",
        priority: 80,
        impact: { kind: "clicks", perMonth: 41.6, low: 30, high: 52 },
      },
      {
        id: "f2",
        title: "Reach",
        actionKind: "INVESTIGATE",
        effort: "VARIES",
        confidence: "DIRECTIONAL",
        status: "ACCEPTED",
        priority: 10,
        impact: { kind: "reach", impressionsPerMonth: 900.4 },
      },
    ]);
    const items = await readOpportunities("p1", 50);
    expect(mocks.listProjectFindings).toHaveBeenCalledWith("p1", {
      statuses: ["OPEN", "ACCEPTED"],
      limit: 10,
    });
    expect(items).toEqual([
      {
        id: "f1",
        title: "Fix the snippet of /pricing",
        action: "Fix the snippet",
        impactPerMonth: 42,
        reachPerMonth: null,
        confidence: "Solid",
        effort: "Quick fix",
        status: "OPEN",
        priority: 80,
      },
      {
        id: "f2",
        title: "Reach",
        action: "Look into it",
        impactPerMonth: null,
        reachPerMonth: 900,
        confidence: "Directional",
        effort: "Varies",
        status: "ACCEPTED",
        priority: 10,
      },
    ]);
  });
});

describe("readRankedDeltas", () => {
  const base = {
    linkId: "link1",
    current: { from: "2026-09-14", to: "2026-10-05" },
    previous: { from: "2026-08-17", to: "2026-09-07" },
  };

  const matrix = [
    ["query", "WEEK", "GscWeeklyQuery", "GscQuery", "weekStart"],
    ["query", "MONTH", "GscMonthlyQuery", "GscQuery", "month"],
    ["page", "WEEK", "GscWeeklyPage", "GscPage", "weekStart"],
    ["page", "MONTH", "GscMonthlyPage", "GscPage", "month"],
  ] as const;

  it("keeps the table matrix constant", () => {
    expect(
      Object.entries(RANKED_SOURCES).map(([key, source]) => [
        key,
        source.table,
        source.dictionary,
        source.dateColumn,
      ]),
    ).toEqual([
      ["query:WEEK", "GscWeeklyQuery", "GscQuery", "weekStart"],
      ["query:MONTH", "GscMonthlyQuery", "GscQuery", "month"],
      ["page:WEEK", "GscWeeklyPage", "GscPage", "weekStart"],
      ["page:MONTH", "GscMonthlyPage", "GscPage", "month"],
    ]);
  });

  it.each(matrix)(
    "%s × %s takes identifiers only from the constant map and passes values as parameters",
    async (dimension, grain, table, dictionary, dateColumn) => {
      mocks.queryRaw.mockResolvedValue([]);
      await readRankedDeltas({ ...base, dimension, grain });
      expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
      const sql = sqlOf(mocks.queryRaw.mock.calls[0]!);
      expect(sql.sql).toContain(`FROM "${table}" w`);
      expect(sql.sql).toContain(`JOIN "${dictionary}" d`);
      expect(sql.sql).toContain(`w."${dateColumn}" BETWEEN`);
      expect(sql.sql).toContain(
        'ORDER BY GREATEST(t."curClicks", t."prevClicks") DESC',
      );
      // Değerler parametredir: bağ kimliği, tarihler ve sınır SQL metninde yok.
      expect(sql.sql).not.toContain("link1");
      expect(sql.sql).not.toContain("2026-09-14");
      expect(sql.values).toContain("link1");
      expect(sql.values).toContain("2026-09-14");
      expect(sql.values).toContain(200);
    },
  );

  it("filters brand queries only for the query dimension", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    await readRankedDeltas({
      ...base,
      dimension: "query",
      grain: "WEEK",
      nonBrandOnly: true,
    });
    await readRankedDeltas({
      ...base,
      dimension: "page",
      grain: "WEEK",
      nonBrandOnly: true,
    });
    expect(sqlOf(mocks.queryRaw.mock.calls[0]!).sql).toContain(
      'd."isBrand" = false',
    );
    expect(sqlOf(mocks.queryRaw.mock.calls[1]!).sql).not.toContain(
      'd."isBrand" = false',
    );
  });

  it("caps the limit at 500 and maps the rows", async () => {
    mocks.queryRaw.mockResolvedValue([
      {
        id: "q1",
        label: "sample",
        url: null,
        isBrand: false,
        firstSeenWeek: new Date("2026-03-02T00:00:00Z"),
        curClicks: BigInt(12),
        curImpressions: BigInt(300),
        curPosition: 1500,
        prevClicks: BigInt(0),
        prevImpressions: BigInt(0),
        prevPosition: 0,
      },
    ]);
    const rows = await readRankedDeltas({
      ...base,
      dimension: "query",
      grain: "WEEK",
      limit: 9_999,
    });
    expect(sqlOf(mocks.queryRaw.mock.calls[0]!).values).toContain(500);
    expect(rows).toEqual([
      {
        id: "q1",
        label: "sample",
        url: null,
        isBrand: false,
        firstSeen: "2026-03-02",
        current: { clicks: 12, impressions: 300, positionWeighted: 1500 },
        previous: { clicks: 0, impressions: 0, positionWeighted: 0 },
      },
    ]);
  });
});

function alert(severity: string, title: string, lastSeenAt: string) {
  return {
    id: title,
    source: "SEO",
    kind: "SEO_ROBOTS_BLOCK",
    severity,
    title,
    detail: null,
    lastSeenAt: new Date(lastSeenAt),
    dedupeKey: title,
  };
}

function update(
  name: string,
  kind: string,
  startedAt: string,
  endedAt: string | null,
) {
  return {
    id: name,
    name,
    kind,
    source: "STATUS_DASHBOARD",
    startedAt: new Date(startedAt),
    endedAt: endedAt ? new Date(endedAt) : null,
    url: null,
  };
}
