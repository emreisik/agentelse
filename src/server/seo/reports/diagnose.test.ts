import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken teşhis hiçbir veritabanı okumaz;
// bağ yoksa "no_link", veri yetmiyorsa "not_enough_data"; 7 ve 28 günlük
// pencereler; pencereyle hizalı haftalar çekilmemişse tablolar en son çekilen
// haftalara düşer (fallback true) ve bir haftadan azı varsa tablo yoktur.

const mocks = vi.hoisted(() => ({
  primaryGscLink: vi.fn(),
  gscDataThrough: vi.fn(),
  readPeriodCoverage: vi.fn(),
  reportContextForLink: vi.fn(),
  readFinalWindow: vi.fn(),
  readRankedDeltas: vi.fn(),
  readPairDeltas: vi.fn(),
  latestFetchedWeeks: vi.fn(),
  readOpenSearchAlerts: vi.fn(),
  readUpdates: vi.fn(),
  readCoverage: vi.fn(),
  readInspectionsFor: vi.fn(),
  seoPageFindMany: vi.fn(),
  diagnoseSearchDrop: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { seoPage: { findMany: mocks.seoPageFindMany } },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
  gscDataThrough: mocks.gscDataThrough,
  readPeriodCoverage: mocks.readPeriodCoverage,
}));
vi.mock("@/server/seo/health/coverage", () => ({
  readCoverage: mocks.readCoverage,
}));
vi.mock("@/server/seo/health/google-reads", () => ({
  readInspectionsFor: mocks.readInspectionsFor,
}));
vi.mock("@/lib/seo/reports/diagnose", () => ({
  diagnoseSearchDrop: mocks.diagnoseSearchDrop,
}));
vi.mock("./inputs", () => ({
  reportContextForLink: mocks.reportContextForLink,
  readFinalWindow: mocks.readFinalWindow,
  readRankedDeltas: mocks.readRankedDeltas,
  readPairDeltas: mocks.readPairDeltas,
  latestFetchedWeeks: mocks.latestFetchedWeeks,
  readOpenSearchAlerts: mocks.readOpenSearchAlerts,
  readUpdates: mocks.readUpdates,
}));

const { diagnoseWindows, loadDiagnoseInput, runSearchDiagnosis } =
  await import("./diagnose");

const NOW = new Date("2026-10-07T12:00:00.000Z");

function ctx() {
  return {
    link: { id: "link1", health: "OK", backfillDoneAt: new Date("2026-09-01") },
    projectId: "p1",
    workspaceId: "w1",
    brandId: "b1",
    language: "en",
    timezone: "UTC",
    finalThrough: "2026-10-04",
    brandSplitReady: false,
    siteLabel: "example.com",
  };
}

function finalWindow(clicks: number) {
  const total = {
    clicks,
    impressions: clicks * 20,
    positionWeighted: clicks * 100,
  };
  return {
    days: [{ day: "x" }],
    complete: true,
    split: { total, brand: null, nonBrand: null },
    missingDays: 0,
    freshDays: 0,
  };
}

// Verilen dönem başları "çekilmiş" sayılır; aralık dışındakiler süzülür.
function fetched(weeks: { query: string[]; pairs?: string[] }) {
  mocks.readPeriodCoverage.mockImplementation(
    async (
      _linkId: string,
      grain: string,
      key: string,
      from: string,
      to: string,
    ) => ({
      periods: (key === "query_page" ? (weeks.pairs ?? []) : weeks.query)
        .filter((week) => grain === "WEEK" && week >= from && week <= to)
        .sort(),
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    }),
  );
}

const ALIGNED = [
  "2026-08-10",
  "2026-08-17",
  "2026-08-24",
  "2026-08-31",
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("SEO_HEALTH", "");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  mocks.gscDataThrough.mockResolvedValue({
    through: "2026-10-04",
    finalThrough: "2026-10-04",
    earliest: "2025-06-01",
  });
  mocks.readFinalWindow
    .mockResolvedValueOnce(finalWindow(700))
    .mockResolvedValueOnce(finalWindow(1000))
    .mockResolvedValue(finalWindow(900));
  mocks.readOpenSearchAlerts.mockResolvedValue(null);
  mocks.readUpdates.mockResolvedValue(null);
  mocks.readRankedDeltas.mockResolvedValue([]);
  mocks.readPairDeltas.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("diagnoseWindows", () => {
  it("builds two equal windows ending on `end`", () => {
    expect(diagnoseWindows("2026-10-04", 7)).toEqual({
      current: { from: "2026-09-28", to: "2026-10-04" },
      previous: { from: "2026-09-21", to: "2026-09-27" },
    });
    expect(diagnoseWindows("2026-10-04", 28)).toEqual({
      current: { from: "2026-09-07", to: "2026-10-04" },
      previous: { from: "2026-08-10", to: "2026-09-06" },
    });
  });
});

describe("runSearchDiagnosis", () => {
  it("answers 'off' without any database access when the flag is off", async () => {
    vi.stubEnv("SEO_REPORTS", "");
    expect(await runSearchDiagnosis("p1")).toEqual({
      ok: false,
      reason: "off",
    });
    vi.stubEnv("SEO_REPORTS", "true");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other");
    expect(await runSearchDiagnosis("p1")).toEqual({
      ok: false,
      reason: "off",
    });
    expect(mocks.primaryGscLink).not.toHaveBeenCalled();
    expect(mocks.gscDataThrough).not.toHaveBeenCalled();
  });

  it("answers 'no_link' without a link", async () => {
    mocks.primaryGscLink.mockResolvedValue(null);
    expect(await runSearchDiagnosis("p1")).toEqual({
      ok: false,
      reason: "no_link",
    });
  });

  it("answers 'not_enough_data' without a context or when history is too short", async () => {
    mocks.primaryGscLink.mockResolvedValue({ id: "link1" });
    mocks.reportContextForLink.mockResolvedValueOnce(null);
    expect(await runSearchDiagnosis("p1")).toEqual({
      ok: false,
      reason: "not_enough_data",
    });
    mocks.reportContextForLink.mockResolvedValue(ctx());
    mocks.gscDataThrough.mockResolvedValue({
      through: "2026-10-04",
      finalThrough: "2026-10-04",
      earliest: "2026-09-20",
    });
    expect(await runSearchDiagnosis("p1")).toEqual({
      ok: false,
      reason: "not_enough_data",
    });
    expect(mocks.diagnoseSearchDrop).not.toHaveBeenCalled();
  });

  it("hands the loaded input to the pure tree", async () => {
    mocks.primaryGscLink.mockResolvedValue({ id: "link1" });
    mocks.reportContextForLink.mockResolvedValue(ctx());
    fetched({ query: ALIGNED });
    mocks.diagnoseSearchDrop.mockReturnValue({ v: 1, primary: "ranking" });
    const result = await runSearchDiagnosis("p1", { now: NOW });
    expect(result).toEqual({
      ok: true,
      diagnosis: { v: 1, primary: "ranking" },
    });
    expect(mocks.diagnoseSearchDrop).toHaveBeenCalledTimes(1);
  });
});

describe("loadDiagnoseInput tables", () => {
  it("uses the four aligned weeks when they are fetched", async () => {
    fetched({ query: ALIGNED });
    const input = await loadDiagnoseInput(ctx() as never, { now: NOW });
    expect(input?.tables).toEqual({
      grain: "WEEK",
      current: { from: "2026-09-07", to: "2026-09-28" },
      previous: { from: "2026-08-10", to: "2026-08-31" },
      fallback: false,
    });
    expect(mocks.latestFetchedWeeks).not.toHaveBeenCalled();
    expect(input?.window).toEqual(diagnoseWindows("2026-10-04", 28));
    expect(input?.metric).toBe("clicks");
    expect(input?.totals.current.clicks).toBe(700);
    expect(input?.totals.previous.clicks).toBe(1000);
  });

  it("falls back to the latest fetched weeks when the aligned ones are missing", async () => {
    const latest = [
      "2026-09-21",
      "2026-09-14",
      "2026-09-07",
      "2026-08-31",
      "2026-08-24",
      "2026-08-17",
      "2026-08-10",
      "2026-08-03",
    ];
    fetched({ query: latest });
    mocks.latestFetchedWeeks.mockResolvedValue(latest);
    const input = await loadDiagnoseInput(ctx() as never, { now: NOW });
    expect(mocks.latestFetchedWeeks).toHaveBeenCalledWith(
      "link1",
      8,
      "2026-09-28",
    );
    expect(input?.tables).toEqual({
      grain: "WEEK",
      current: { from: "2026-08-31", to: "2026-09-21" },
      previous: { from: "2026-08-03", to: "2026-08-24" },
      fallback: true,
    });
    expect(mocks.readRankedDeltas).toHaveBeenCalledWith(
      expect.objectContaining({
        dimension: "query",
        grain: "WEEK",
        current: { from: "2026-08-31", to: "2026-09-21" },
      }),
    );
  });

  it("has no tables with fewer than two fetched weeks", async () => {
    fetched({ query: ["2026-09-28"] });
    mocks.latestFetchedWeeks.mockResolvedValue(["2026-09-28"]);
    const input = await loadDiagnoseInput(ctx() as never, { now: NOW });
    expect(input?.tables).toBeNull();
    expect(input?.pairWeeks).toBeNull();
    expect(input?.queries).toEqual([]);
    expect(mocks.readRankedDeltas).not.toHaveBeenCalled();
  });

  it("compares the week with the previous one for a Sunday-ended 7 day window", async () => {
    fetched({ query: ALIGNED, pairs: ALIGNED });
    const input = await loadDiagnoseInput(ctx() as never, {
      now: NOW,
      days: 7,
      end: "2026-10-04",
    });
    expect(input?.tables).toEqual({
      grain: "WEEK",
      current: { from: "2026-09-28", to: "2026-09-28" },
      previous: { from: "2026-09-21", to: "2026-09-21" },
      fallback: false,
    });
    expect(input?.pairWeeks).toEqual({
      current: { from: "2026-09-28", to: "2026-09-28" },
      previous: { from: "2026-09-21", to: "2026-09-21" },
    });
  });

  it("uses the month tables of an explicit monthly window", async () => {
    mocks.latestFetchedWeeks.mockResolvedValue([...ALIGNED].reverse());
    mocks.readPeriodCoverage.mockImplementation(
      async (_linkId: string, grain: string, key: string) => ({
        periods:
          grain === "MONTH" && key === "query"
            ? ["2026-08-01", "2026-09-01"]
            : ALIGNED,
        truncated: false,
        rowClicks: 0,
        rowImpressions: 0,
      }),
    );
    const input = await loadDiagnoseInput(ctx() as never, {
      now: NOW,
      windows: {
        current: { from: "2026-09-01", to: "2026-09-30" },
        previous: { from: "2026-08-01", to: "2026-08-31" },
        tableGrain: "MONTH",
      },
    });
    expect(input?.tables).toEqual({
      grain: "MONTH",
      current: { from: "2026-09-01", to: "2026-09-01" },
      previous: { from: "2026-08-01", to: "2026-08-01" },
      fallback: false,
    });
    expect(input?.window.current).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    // Çiftler için ayın sonuna kadarki son tam haftalar.
    expect(mocks.latestFetchedWeeks).toHaveBeenCalledWith(
      "link1",
      8,
      "2026-09-21",
    );
  });

  it("asks for pairs of the queries that lost the most clicks only", async () => {
    fetched({ query: ALIGNED, pairs: ALIGNED });
    const row = (id: string, current: number, previous: number) => ({
      id,
      label: id,
      url: null,
      isBrand: false,
      firstSeen: "2026-01-05",
      current: { clicks: current, impressions: 100, positionWeighted: 500 },
      previous: { clicks: previous, impressions: 100, positionWeighted: 500 },
    });
    mocks.readRankedDeltas.mockResolvedValueOnce([
      row("gain", 20, 10),
      row("small", 8, 10),
      row("big", 1, 40),
    ]);
    await loadDiagnoseInput(ctx() as never, { now: NOW });
    expect(mocks.readPairDeltas).toHaveBeenCalledWith({
      linkId: "link1",
      queryIds: ["big", "small"],
      current: { from: "2026-09-07", to: "2026-09-28" },
      previous: { from: "2026-08-10", to: "2026-08-31" },
    });
  });

  it("does not look at SeoPage or W2 coverage while SEO_HEALTH is off", async () => {
    fetched({ query: ALIGNED });
    mocks.readRankedDeltas.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "pg",
        label: "/a",
        url: "https://example.com/a",
        isBrand: false,
        firstSeen: "2026-01-05",
        current: { clicks: 0, impressions: 0, positionWeighted: 0 },
        previous: { clicks: 50, impressions: 100, positionWeighted: 500 },
      },
    ]);
    const input = await loadDiagnoseInput(ctx() as never, { now: NOW });
    expect(mocks.seoPageFindMany).not.toHaveBeenCalled();
    expect(mocks.readCoverage).not.toHaveBeenCalled();
    expect(input?.health.available).toBe(false);
    expect(input?.updatesAvailable).toBe(false);
    expect(input?.pages[0]).toMatchObject({
      status: null,
      noindex: null,
      indexed: null,
    });
  });
});
