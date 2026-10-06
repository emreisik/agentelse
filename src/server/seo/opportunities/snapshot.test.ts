import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GscSiteLink } from "@prisma/client";

import { addWeeks } from "@/lib/seo/dates";
import { priorCurve } from "@/lib/seo/ctr-curve";

// Bu dosyanın kanıtladığı: şimdiki 4 haftanın herhangi birinde query_page
// özeti yoksa anlık görüntü null; önceki pencere eksikse previousComplete
// false ve karşılaştırma listeleri boş (okunmaz); historyWeeks yalnız
// kesintisiz koşuyu sayar; pencere `week`ten Pazartesi..Pazar; tarama okuma
// hatası yalnız crawl'ı null yapar; kaybolmuş ve robots'a takılan sayfalar
// okunmaz.

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  project: vi.fn(),
  slices: vi.fn(),
  inspections: vi.fn(),
  gscPages: vi.fn(),
  seoPages: vi.fn(),
  seoCrawl: vi.fn(),
  seoLinks: vi.fn(),
  coverage: vi.fn(),
  days: vi.fn(),
  forProject: vi.fn(),
  health: vi.fn(),
  crawl: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    project: { findUnique: mocks.project },
    gscDailySlice: { findMany: mocks.slices },
    gscUrlInspection: { findMany: mocks.inspections },
    gscPage: { findMany: mocks.gscPages },
    seoPage: { findMany: mocks.seoPages },
    seoCrawl: { findFirst: mocks.seoCrawl },
    seoLink: { findMany: mocks.seoLinks },
  },
}));
vi.mock("@/server/seo/store", () => ({
  readPeriodCoverage: mocks.coverage,
  readGscDays: mocks.days,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: { forProject: mocks.forProject },
}));
vi.mock("@/lib/seo/health-flags", () => ({
  SeoFlags: { health: mocks.health, crawl: mocks.crawl },
}));
vi.mock("@/server/seo/brand-terms", () => ({
  brandSplitStatus: () => "ready",
}));

const { loadRuleSnapshot } = await import("./snapshot");

const WEEK = "2026-09-21";
const CURVES = {
  nonBrand: priorCurve("non-brand"),
  brand: priorCurve("brand"),
};

const LINK = {
  id: "link-1",
  projectId: "project-1",
  propertyType: "DOMAIN",
  brandTerms: null,
  brandSeriesHash: null,
  backfillDoneAt: null,
  lastFinalDate: "2026-09-30",
} as unknown as GscSiteLink;

// fetched[grain:key] = Pazartesi'ler (ya da ay başları).
let fetched: Record<string, Set<string>>;

function weeksBack(count: number): string[] {
  return Array.from({ length: count }, (_, index) => addWeeks(WEEK, -index));
}

function sqlText(args: unknown[]): string {
  const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
  const parts = values.map((value) =>
    value && typeof value === "object" && "sql" in value
      ? String((value as { sql: unknown }).sql)
      : "",
  );
  return [...strings, ...parts].join(" ");
}

function setCoverage(keys: Record<string, string[]>) {
  fetched = Object.fromEntries(
    Object.entries(keys).map(([key, periods]) => [key, new Set(periods)]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setCoverage({
    "WEEK:query": weeksBack(30),
    "WEEK:page": weeksBack(8),
    "WEEK:query_page": weeksBack(8),
  });
  mocks.coverage.mockImplementation(
    async (
      _link: string,
      grain: string,
      key: string,
      from: string,
      to: string,
    ) => ({
      periods: [...(fetched[`${grain}:${key}`] ?? [])]
        .filter((period) => period >= from && period <= to)
        .sort(),
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    }),
  );
  mocks.queryRaw.mockResolvedValue([]);
  mocks.project.mockResolvedValue({ language: "en", country: "US" });
  mocks.slices.mockResolvedValue([]);
  mocks.days.mockResolvedValue([]);
  mocks.inspections.mockResolvedValue([]);
  mocks.gscPages.mockResolvedValue([]);
  mocks.seoPages.mockResolvedValue([]);
  mocks.seoCrawl.mockResolvedValue({ status: "DONE" });
  mocks.seoLinks.mockResolvedValue([]);
  mocks.forProject.mockResolvedValue({ id: "site-1" });
  mocks.health.mockReturnValue(false);
  mocks.crawl.mockReturnValue(false);
});

function load() {
  return loadRuleSnapshot({
    link: LINK,
    week: WEEK,
    curves: CURVES,
    clusters: [],
    now: new Date("2026-10-07T12:00:00.000Z"),
  });
}

describe("loadRuleSnapshot", () => {
  it("returns null when any current week lacks a query_page fetch", async () => {
    setCoverage({
      "WEEK:query": weeksBack(30),
      "WEEK:page": weeksBack(8),
      "WEEK:query_page": weeksBack(8).filter(
        (monday) => monday !== addWeeks(WEEK, -2),
      ),
    });
    expect(await load()).toBeNull();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("anchors the window on week, Monday to Sunday", async () => {
    const snapshot = await load();
    expect(snapshot?.week).toBe(WEEK);
    expect(snapshot?.current).toEqual({ from: "2026-08-31", to: "2026-09-27" });
    expect(snapshot?.previous).toEqual({
      from: "2026-08-03",
      to: "2026-08-30",
    });
    expect(snapshot?.previousComplete).toBe(true);
    expect(snapshot?.pairWeeks).toHaveLength(8);
  });

  it("leaves the previous lists empty when the previous window is incomplete", async () => {
    setCoverage({
      "WEEK:query": weeksBack(30),
      "WEEK:page": weeksBack(8),
      "WEEK:query_page": weeksBack(6),
    });
    mocks.queryRaw.mockImplementation(async (...args: unknown[]) => {
      const sql = sqlText(args);
      if (sql.includes("JOIN") || sql.includes("ANY(")) return [];
      if (sql.includes("GscWeeklyQueryPage") && sql.includes("GROUP BY")) {
        return [
          {
            queryId: "q1",
            pageId: "p1",
            clicks: BigInt(1),
            impressions: BigInt(10),
            positionWeighted: 50,
          },
        ];
      }
      if (sql.includes('"GscWeeklyQuery"') || sql.includes('"GscWeeklyPage"')) {
        return [{ id: "x", clicks: BigInt(1), impressions: BigInt(2), positionWeighted: 3 }];
      }
      return [];
    });
    const snapshot = await load();
    expect(snapshot?.previousComplete).toBe(false);
    expect(snapshot?.previousQueries).toEqual([]);
    expect(snapshot?.previousPages).toEqual([]);
    expect(snapshot?.previousPairs).toEqual([]);
    expect(snapshot?.pairs).toHaveLength(1);
    expect(snapshot?.pairWeeks).toHaveLength(6);
  });

  it("counts only the contiguous run of query weeks", async () => {
    const run = weeksBack(5);
    setCoverage({
      "WEEK:query": [...run, ...weeksBack(30).slice(6)],
      "WEEK:page": weeksBack(8),
      "WEEK:query_page": weeksBack(8),
    });
    const snapshot = await load();
    expect(snapshot?.historyWeeks).toBe(5);
  });

  it("returns crawl null when the crawl read fails", async () => {
    mocks.crawl.mockReturnValue(true);
    mocks.seoPages.mockRejectedValue(new Error("boom"));
    const snapshot = await load();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.crawl).toBeNull();
  });

  it("reads only live, crawlable pages and maps them to GSC pages", async () => {
    mocks.crawl.mockReturnValue(true);
    mocks.seoPages.mockResolvedValue([
      {
        id: "sp1",
        url: "https://example.com/a",
        urlHash: "h1",
        path: "/a",
        status: 200,
        noindex: false,
        indexable: true,
        title: "A",
        h1: "Heading",
        headings: { h1: ["Heading"], h2: ["Sub"] },
        lang: "en",
        hreflang: [{ lang: "de", href: "https://example.com/de/a" }],
        schemaTypes: [],
        inlinks: 5,
        imagesNoAlt: 0,
        issues: [{ code: "TA7", severity: "WARN" }],
        depth: 1,
      },
    ]);
    mocks.gscPages.mockResolvedValue([
      { id: "gp1", url: "https://example.com/a" },
    ]);
    const snapshot = await load();
    expect(mocks.seoPages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { siteId: "site-1", goneAt: null, robotsBlocked: false },
      }),
    );
    expect(snapshot?.crawl?.complete).toBe(true);
    expect(snapshot?.crawl?.pages[0]).toMatchObject({
      pageId: "gp1",
      h1: ["Heading"],
      h2: ["Sub"],
      hreflang: ["de"],
      issues: [{ code: "TA7", severity: "WARN" }],
    });
  });
});
