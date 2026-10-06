import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SeoFindingView } from "@/server/seo/opportunities/findings-store";

// Bu dosyanın kanıtladığı: dönem tablo seçimini belirler (kısa → haftalık,
// uzun → aylık); "içerir" süzgecinde %, _ ve ters bölü kaçırılır; satır sınırı
// 20'ye kırpılır; her sonuç en çok 20 farklı Google dizgisi ve veri notunu
// taşır; "Which pages should I improve first?" sorusu öncelik sırasıyla ve
// ambar sayılarıyla yanıtlanır.

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  sliceFindMany: vi.fn(),
  pageFindFirst: vi.fn(),
  weeklyPageAggregate: vi.fn(),
  findingCount: vi.fn(),
  seoSiteFindUnique: vi.fn(),
  seoPageFindFirst: vi.fn(),
  primaryGscLink: vi.fn(),
  gscDataThrough: vi.fn(),
  readGscDays: vi.fn(),
  readTopQueries: vi.fn(),
  readTopPages: vi.fn(),
  buildSearchReport: vi.fn(),
  listProjectFindings: vi.fn(),
  readInspectionsFor: vi.fn(),
  requestInspection: vi.fn(),
  readSearchHealthScore: vi.fn(),
  readLatestCwv: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    gscDailySlice: { findMany: mocks.sliceFindMany },
    gscPage: { findFirst: mocks.pageFindFirst },
    gscWeeklyPage: { aggregate: mocks.weeklyPageAggregate },
    seoFinding: { count: mocks.findingCount },
    seoSite: { findUnique: mocks.seoSiteFindUnique },
    seoPage: { findFirst: mocks.seoPageFindFirst },
  },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
  gscDataThrough: mocks.gscDataThrough,
  readGscDays: mocks.readGscDays,
  readTopQueries: mocks.readTopQueries,
  readTopPages: mocks.readTopPages,
}));
vi.mock("@/server/seo/report", () => ({
  buildSearchReport: mocks.buildSearchReport,
}));
vi.mock("@/server/seo/opportunities/findings-store", () => ({
  listProjectFindings: mocks.listProjectFindings,
}));
vi.mock("@/server/seo/health/google-reads", () => ({
  readInspectionsFor: mocks.readInspectionsFor,
}));
vi.mock("@/server/seo/health/inspection", () => ({
  SeoInspection: { requestInspection: mocks.requestInspection },
}));
vi.mock("@/server/seo/health/runner", () => ({
  readSearchHealthScore: mocks.readSearchHealthScore,
}));
vi.mock("@/server/seo/health/cwv", () => ({
  readLatestCwv: mocks.readLatestCwv,
}));

import {
  inspectUrlForChat,
  likePattern,
  performanceGrain,
  querySearchPerformance,
  readOpportunitiesForChat,
  readPageSeo,
  readSearchOverviewForChat,
  SEARCH_DATA_NOTE,
} from "./chat-readers";

const NOW = new Date("2026-10-01T12:00:00Z");
const LINK = {
  id: "link-1",
  projectId: "p1",
  lastWeeklyWeek: "2026-09-21",
  lastFinalDate: "2026-09-29",
};

function ranked(label: string, index: number) {
  return {
    id: `id-${label}`,
    label,
    url: null,
    isBrand: false,
    clicks: 100 - index,
    impressions: 1000 - index,
    positionWeighted: (1000 - index) * 5,
  };
}

function sqlOf(call: unknown[]): Prisma.Sql {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
}

// Sonuçtaki Google dizgileri: sorgu/sayfa etiketleri, yollar, anahtar sözcükler.
function googleStrings(result: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, key: string | null) => {
    if (typeof value === "string") {
      if (key && ["label", "path", "keyword", "url"].includes(key)) {
        out.add(value);
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(result, null);
  return out;
}

function finding(
  id: string,
  priority: number,
  overrides: Partial<SeoFindingView> = {},
): SeoFindingView {
  return {
    id,
    ruleKey: "SO1_STRIKING_DISTANCE",
    kind: "OPPORTUNITY",
    status: "OPEN",
    severity: "INFO",
    confidence: "SIGNIFICANT",
    effort: "S",
    actionKind: "TITLE_META",
    impact: {
      kind: "clicks",
      perMonth: priority,
      low: Math.round(priority * 0.7),
      high: Math.round(priority * 1.3),
    },
    priority,
    title: `Improve ${id}`,
    summary: `Summary ${id}`,
    explanation: null,
    evidence: {
      window: { from: "2026-08-31", to: "2026-09-27" },
      metrics: { impressions: priority * 10 },
      pages: [
        {
          pageId: `pg-${id}`,
          path: `/page-${id}`,
          url: null,
          clicks: 1,
          impressions: priority * 10,
          position: 8,
        },
      ],
    },
    periodStart: "2026-08-31",
    periodEnd: "2026-09-27",
    periodKey: "W:2026-09-27",
    pageId: `pg-${id}`,
    queryId: null,
    clusterId: null,
    keyword: `keyword ${id}`,
    ideaIds: [],
    signalId: null,
    shadow: false,
    review: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.primaryGscLink.mockResolvedValue(LINK);
  mocks.gscDataThrough.mockResolvedValue({
    through: "2026-09-30",
    finalThrough: "2026-09-29",
    earliest: "2025-01-01",
  });
  mocks.readTopQueries.mockImplementation(
    async (_link: string, _weeks: unknown, options: { limit: number }) =>
      Array.from({ length: 30 }, (_, i) => ranked(`query ${i}`, i)).slice(
        0,
        options.limit,
      ),
  );
  mocks.readTopPages.mockResolvedValue([ranked("/a", 0)]);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.listProjectFindings.mockResolvedValue([]);
  mocks.findingCount.mockResolvedValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("performanceGrain", () => {
  it("chooses weekly tables for short periods and monthly ones for long", () => {
    for (const period of ["7d", "28d", "3m"] as const) {
      expect(performanceGrain("query", period)).toBe("week");
      expect(performanceGrain("page", period)).toBe("week");
    }
    for (const period of ["12m", "16m", "all"] as const) {
      expect(performanceGrain("query", period)).toBe("month");
      expect(performanceGrain("date", period)).toBe("month");
    }
    expect(performanceGrain("date", "7d")).toBe("day");
    expect(performanceGrain("date", "28d")).toBe("day");
    expect(performanceGrain("date", "3m")).toBe("week");
    expect(performanceGrain("country", "12m")).toBe("day");
  });
});

describe("likePattern", () => {
  it("escapes %, _ and backslash", () => {
    expect(likePattern("50%_off\\x")).toBe("%50\\%\\_off\\\\x%");
    expect(likePattern("  ")).toBeNull();
  });
});

describe("querySearchPerformance", () => {
  it("reads complete weeks for 28 days and clamps the limit to 20", async () => {
    const result = await querySearchPerformance(
      "p1",
      { dimension: "query", period: "28d", limit: 100 },
      NOW,
    );
    expect(mocks.readTopQueries).toHaveBeenCalledWith(
      "link-1",
      { from: "2026-09-07", to: "2026-09-21" },
      { limit: 20, brand: "all", orderBy: "clicks" },
    );
    expect(result).toMatchObject({
      status: "ok",
      grain: "week",
      note: SEARCH_DATA_NOTE,
    });
    expect(result.notes).toEqual(
      expect.arrayContaining([
        "Search Console days are Pacific Time.",
        "Position is the average top position, not a rank tracker.",
      ]),
    );
    const rows = result.rows as {
      label: string;
      ctr: number;
      position: number;
    }[];
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual({
      label: "query 0",
      clicks: 100,
      impressions: 1000,
      ctr: 10,
      position: 5,
    });
    expect(googleStrings(result).size).toBeLessThanOrEqual(20);
  });

  it("uses the monthly table for 12 months and ILIKE for contains", async () => {
    await querySearchPerformance(
      "p1",
      {
        dimension: "query",
        period: "12m",
        contains: "50%_off",
        brand: "non-brand",
      },
      NOW,
    );
    expect(mocks.readTopQueries).not.toHaveBeenCalled();
    const sql = sqlOf(mocks.queryRaw.mock.calls[0]!);
    expect(sql.sql).toContain('"GscMonthlyQuery" w');
    expect(sql.sql).toContain("ILIKE");
    expect(sql.sql).toContain('d."isBrand" = false');
    expect(sql.values).toContain("%50\\%\\_off%");
    expect(sql.values).toContain("2025-09-01");
    expect(sql.values).toContain("2026-08-01");

    await querySearchPerformance(
      "p1",
      { dimension: "page", period: "3m", contains: "blog" },
      NOW,
    );
    const weekly = sqlOf(mocks.queryRaw.mock.calls[1]!);
    expect(weekly.sql).toContain('"GscWeeklyPage" w');
    expect(weekly.sql).toContain('d."path"');
  });

  it("sums country slices and reports an empty warehouse", async () => {
    mocks.sliceFindMany.mockResolvedValueOnce([
      {
        rows: [
          ["tur", 10, 100, 300],
          ["usa", 5, 200, 1000],
        ],
      },
      { rows: [["tur", 2, 20, 60], "bad"] },
    ]);
    const result = await querySearchPerformance(
      "p1",
      { dimension: "country", period: "7d", orderBy: "impressions" },
      NOW,
    );
    expect(result.rows).toEqual([
      { label: "usa", clicks: 5, impressions: 200, ctr: 2.5, position: 5 },
      { label: "tur", clicks: 12, impressions: 120, ctr: 10, position: 3 },
    ]);
    mocks.sliceFindMany.mockResolvedValueOnce([]);
    const empty = await querySearchPerformance(
      "p1",
      { dimension: "device", period: "28d" },
      NOW,
    );
    expect(empty.notes).toContain("Not in the warehouse yet");
    expect(empty.note).toBe(SEARCH_DATA_NOTE);
  });

  it("buckets dates by day for 28 days and by month for 12 months", async () => {
    const day = (key: string, clicks: number) => ({
      day: key,
      searchType: "web",
      fresh: false,
      clicks,
      impressions: clicks * 10,
      positionWeighted: clicks * 30,
      brandClicks: null,
      brandImpressions: null,
      brandPositionWeighted: null,
    });
    mocks.readGscDays.mockResolvedValue([
      day("2026-08-30", 1),
      day("2026-08-31", 2),
      day("2026-09-01", 3),
    ]);
    const daily = await querySearchPerformance(
      "p1",
      { dimension: "date", period: "28d" },
      NOW,
    );
    expect((daily.rows as { label: string }[]).map((row) => row.label)).toEqual(
      ["2026-08-30", "2026-08-31", "2026-09-01"],
    );
    const monthly = await querySearchPerformance(
      "p1",
      { dimension: "date", period: "12m" },
      NOW,
    );
    expect(monthly.rows).toEqual([
      { label: "2026-08-01", clicks: 3, impressions: 30, ctr: 10, position: 3 },
      { label: "2026-09-01", clicks: 3, impressions: 30, ctr: 10, position: 3 },
    ]);
  });

  it("says when Search Console is not connected", async () => {
    mocks.primaryGscLink.mockResolvedValueOnce(null);
    expect(
      await querySearchPerformance("p1", { dimension: "query", period: "7d" }),
    ).toMatchObject({ status: "not_connected", note: SEARCH_DATA_NOTE });
  });
});

describe("readSearchOverviewForChat", () => {
  it("returns non-brand KPIs, top rows and the open count within the string budget", async () => {
    const row = (label: string) => ({
      label,
      href: null,
      isBrand: false,
      clicks: 10,
      impressions: 100,
      ctr: 10,
      position: 4.44,
    });
    mocks.buildSearchReport.mockResolvedValueOnce({
      state: "ready",
      report: {
        link: { siteLabel: "example.com", finalThrough: "2026-09-29" },
        period: { label: "28 days", from: "2026-09-02", to: "2026-09-29" },
        kpis: [
          {
            key: "clicks",
            label: "Clicks",
            value: 1234,
            previous: 1000,
            format: "count",
            lowerIsBetter: false,
          },
        ],
        queries: { rows: Array.from({ length: 25 }, (_, i) => row(`q${i}`)) },
        pages: { rows: Array.from({ length: 25 }, (_, i) => row(`/p${i}`)) },
        anonymousShare: 0.123,
        notes: [],
      },
    });
    mocks.findingCount.mockResolvedValueOnce(4);
    const result = await readSearchOverviewForChat("p1", NOW);
    expect(mocks.buildSearchReport).toHaveBeenCalledWith("p1", "28d", {
      queryFilter: "non-brand",
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "ok",
      note: SEARCH_DATA_NOTE,
      finalThrough: "2026-09-29",
      openOpportunities: 4,
      anonymousShare: 12.3,
    });
    expect(result.topQueries).toHaveLength(5);
    expect(result.topPages).toHaveLength(5);
    expect(result).not.toHaveProperty("healthScore");
    expect(googleStrings(result).size).toBeLessThanOrEqual(20);

    vi.stubEnv("SEO_HEALTH", "true");
    mocks.buildSearchReport.mockResolvedValueOnce({ state: "waiting" });
    expect(await readSearchOverviewForChat("p1", NOW)).toMatchObject({
      status: "no_data",
    });
  });
});

describe("readPageSeo", () => {
  it("matches the page and keeps at most 20 Google strings", async () => {
    mocks.pageFindFirst.mockResolvedValueOnce({
      id: "pg1",
      url: "https://example.com/blog/shoes",
      path: "/blog/shoes",
      pageGroup: "/blog",
      firstSeenWeek: new Date("2025-01-06T00:00:00Z"),
      lastSeenWeek: new Date("2026-09-21T00:00:00Z"),
    });
    mocks.weeklyPageAggregate
      .mockResolvedValueOnce({
        _sum: { clicks: 40, impressions: 1000, positionWeighted: 6000 },
      })
      .mockResolvedValueOnce({
        _sum: { clicks: 60, impressions: 1200, positionWeighted: 6000 },
      });
    mocks.queryRaw.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({
        label: `shoe query ${i}`,
        clicks: 5,
        impressions: 50,
        positionWeighted: 250,
      })),
    );
    mocks.listProjectFindings.mockResolvedValueOnce(
      Array.from({ length: 8 }, (_, i) => finding(`f${i}`, 50 - i)),
    );
    const result = await readPageSeo(
      "p1",
      "https://example.com/blog/shoes?utm_source=x",
      NOW,
    );
    expect(mocks.pageFindFirst.mock.calls[0]![0].where).toMatchObject({
      linkId: "link-1",
    });
    expect(mocks.listProjectFindings).toHaveBeenCalledWith("p1", {
      pageId: "pg1",
    });
    expect(result).toMatchObject({
      status: "ok",
      note: SEARCH_DATA_NOTE,
      page: { path: "/blog/shoes" },
      current: { clicks: 40, impressions: 1000, ctr: 4, position: 6 },
      previous: { clicks: 60, impressions: 1200, ctr: 5, position: 5 },
      weeks: {
        current: { from: "2026-08-31", to: "2026-09-21" },
        previous: { from: "2026-08-03", to: "2026-08-24" },
      },
    });
    expect(result.topQueries).toHaveLength(10);
    // Yol + 10 sorgu = 11; her bulgu 2 dizge → en çok 4 bulgu sığar.
    expect(result.openFindings).toHaveLength(4);
    expect(googleStrings(result).size).toBeLessThanOrEqual(20);
    expect(result).not.toHaveProperty("inspection");
    expect(result).not.toHaveProperty("crawl");
  });

  it("falls back to the path and says when the page is unknown", async () => {
    mocks.pageFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const result = await readPageSeo("p1", "https://example.com/missing", NOW);
    expect(mocks.pageFindFirst.mock.calls[1]![0].where).toEqual({
      linkId: "link-1",
      path: "/missing",
    });
    expect(result.notes).toContain("Not in the warehouse yet");
  });
});

describe("inspectUrlForChat", () => {
  it("returns a fresh inspection and queues an old one", async () => {
    const inspection = {
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      indexingState: "INDEXING_ALLOWED",
      googleCanonical: null,
      userCanonical: null,
      lastCrawlTime: null,
      inspectedAt: new Date(NOW.getTime() - 3_600_000),
    };
    mocks.readInspectionsFor.mockImplementation(
      async (_projectId: string, hashes: string[]) =>
        new Map([[hashes[0], inspection]]),
    );
    const fresh = await inspectUrlForChat("p1", "https://example.com/a", NOW);
    expect(fresh).toMatchObject({
      status: "ok",
      fresh: true,
      inspection: { verdict: "PASS" },
      note: SEARCH_DATA_NOTE,
    });
    expect(mocks.requestInspection).not.toHaveBeenCalled();

    inspection.inspectedAt = new Date(NOW.getTime() - 48 * 3_600_000);
    mocks.requestInspection.mockResolvedValueOnce("queued");
    const queued = await inspectUrlForChat("p1", "https://example.com/a", NOW);
    expect(mocks.requestInspection).toHaveBeenCalledWith({
      projectId: "p1",
      url: "https://example.com/a",
      by: "user",
      now: NOW,
    });
    expect(queued).toMatchObject({ fresh: false, request: "queued" });
    expect((queued.notes as string[]).join(" ")).toMatch(/Queued/);
  });

  it("refuses an invalid address", async () => {
    expect(await inspectUrlForChat("p1", "not a url", NOW)).toMatchObject({
      status: "error",
    });
  });
});

describe("readOpportunitiesForChat", () => {
  it("answers 'Which pages should I improve first?' by priority with warehouse numbers", async () => {
    mocks.listProjectFindings.mockResolvedValueOnce([
      finding("a", 120),
      finding("b", 80, {
        actionKind: "CONTENT_REFRESH",
        explanation: "Clicks fell after a rewrite.",
      }),
      finding("c", 30),
    ]);
    const result = await readOpportunitiesForChat("p1", { limit: 3 });
    expect(mocks.listProjectFindings).toHaveBeenCalledWith("p1", {
      statuses: ["OPEN", "ACCEPTED"],
      shadow: false,
      limit: 3,
    });
    expect(result).toMatchObject({
      status: "ok",
      note: SEARCH_DATA_NOTE,
      count: 3,
    });
    const items = result.opportunities as Record<string, unknown>[];
    expect(items.map((item) => item.path)).toEqual([
      "/page-a",
      "/page-b",
      "/page-c",
    ]);
    expect(items[0]).toMatchObject({
      title: "Improve a",
      impact: {
        kind: "extra clicks per month",
        perMonth: 120,
        low: 84,
        high: 156,
      },
      confidence: "SIGNIFICANT",
      effort: "S",
      actionKind: "TITLE_META",
      keyword: "keyword a",
      status: "OPEN",
    });
    expect(items[1]?.explanation).toBe("Clicks fell after a rewrite.");
  });

  it("filters by action kind, clamps to 10 and keeps 20 strings at most", async () => {
    mocks.listProjectFindings.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, i) => finding(`f${i}`, 100 - i)),
    );
    const result = await readOpportunitiesForChat("p1", {
      limit: 50,
      actionKind: "TITLE_META",
    });
    expect(mocks.listProjectFindings.mock.calls[0]![1].limit).toBe(100);
    expect(result.count).toBe(10);
    expect(googleStrings(result).size).toBeLessThanOrEqual(20);
  });
});
