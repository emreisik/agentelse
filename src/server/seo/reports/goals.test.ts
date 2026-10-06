import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDays } from "@/lib/seo/dates";
import { SEO_GOAL_METRIC_KEYS } from "@/lib/seo/reports/types";

// Bu dosyanın kanıtladığı: bayrak ya da izin kapalıyken tempo okuyucusu
// veritabanına dokunmadan boş Map döner; unutma boş listede sorgu yapmaz ve
// yalnız beş tam anahtarı (önek değil) hedefler; yenileme yalnız bağın
// kipindeki hedefleri işler, değeri değişince yazar ve ilerleme satırını
// günceller; aktif olmayan hedeflerin ilerleme satırları silinir.

const mocks = vi.hoisted(() => ({
  goalFindMany: vi.fn(),
  goalUpdate: vi.fn(),
  goalUpdateMany: vi.fn(),
  progressFindMany: vi.fn(),
  progressUpsert: vi.fn(),
  progressDeleteMany: vi.fn(),
  queryRaw: vi.fn(),
  reportContextFor: vi.fn(),
  readFinalWindow: vi.fn(),
  latestFetchedWeeks: vi.fn(),
  readGscDays: vi.fn(),
  readCoverage: vi.fn(),
  readLatestCwv: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    projectGoal: {
      findMany: mocks.goalFindMany,
      update: mocks.goalUpdate,
      updateMany: mocks.goalUpdateMany,
    },
    seoGoalProgress: {
      findMany: mocks.progressFindMany,
      upsert: mocks.progressUpsert,
      deleteMany: mocks.progressDeleteMany,
    },
  },
}));
vi.mock("@/server/seo/store", () => ({ readGscDays: mocks.readGscDays }));
vi.mock("@/server/seo/health/coverage", () => ({
  readCoverage: mocks.readCoverage,
}));
vi.mock("@/server/seo/health/cwv", () => ({
  readLatestCwv: mocks.readLatestCwv,
}));
vi.mock("./inputs", () => ({
  reportContextFor: mocks.reportContextFor,
  readFinalWindow: mocks.readFinalWindow,
  latestFetchedWeeks: mocks.latestFetchedWeeks,
}));

const {
  forgetSeoGoalValues,
  loadSeoGoalPaces,
  measureSeoGoal,
  refreshSeoGoals,
} = await import("./goals");

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    link: { id: "link1", isMock: true },
    projectId: "p1",
    workspaceId: "w1",
    brandId: "b1",
    language: "en",
    timezone: "UTC",
    finalThrough: "2026-10-04",
    brandSplitReady: false,
    siteLabel: "example.com",
    ...overrides,
  };
}

function day(clicks: number, brand: number | null = null) {
  return {
    day: "2026-09-01",
    fresh: false,
    clicks,
    impressions: clicks * 10,
    positionWeighted: clicks * 50,
    brandClicks: brand,
    brandImpressions: brand === null ? null : brand * 10,
    brandPositionWeighted: brand === null ? null : brand * 50,
  };
}

function window30(clicks: number, complete = true) {
  const total = { clicks, impressions: clicks * 10, positionWeighted: 0 };
  return {
    days: [],
    complete,
    split: { total, brand: null, nonBrand: null },
    missingDays: complete ? 0 : 3,
    freshDays: 0,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadSeoGoalPaces", () => {
  it("returns an empty Map without touching the database when the flag is off", async () => {
    vi.stubEnv("SEO_REPORTS", "");
    const paces = await loadSeoGoalPaces("p1");
    expect(paces.size).toBe(0);
    expect(mocks.progressFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty Map for a project outside the allow-list", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other");
    expect((await loadSeoGoalPaces("p1")).size).toBe(0);
    expect(mocks.progressFindMany).not.toHaveBeenCalled();
  });

  it("maps the current mode's progress rows", async () => {
    mocks.progressFindMany.mockResolvedValue([
      { goalId: "g1", pace: "at_risk", measuredThrough: "2026-10-04" },
      { goalId: "g2", pace: "weird", measuredThrough: null },
    ]);
    const paces = await loadSeoGoalPaces("p1");
    expect(mocks.progressFindMany).toHaveBeenCalledWith({
      where: { projectId: "p1", isMock: true },
      select: { goalId: true, pace: true, measuredThrough: true },
    });
    expect(paces.get("g1")).toEqual({
      pace: "at_risk",
      label: "At risk",
      measuredThrough: "2026-10-04",
    });
    expect(paces.get("g2")?.pace).toBe("unknown");
  });
});

describe("forgetSeoGoalValues", () => {
  it("makes no query for an empty list", async () => {
    expect(await forgetSeoGoalValues([])).toBe(0);
    expect(mocks.goalUpdateMany).not.toHaveBeenCalled();
    expect(mocks.progressDeleteMany).not.toHaveBeenCalled();
  });

  it("nulls only the five exact keys, never a prefix, and ignores the flag", async () => {
    vi.stubEnv("SEO_REPORTS", "");
    mocks.goalUpdateMany.mockResolvedValue({ count: 3 });
    expect(await forgetSeoGoalValues(["p1", "p2"])).toBe(3);
    expect(mocks.goalUpdateMany).toHaveBeenCalledWith({
      where: {
        projectId: { in: ["p1", "p2"] },
        metricKey: { in: [...SEO_GOAL_METRIC_KEYS] },
      },
      data: { currentValue: null },
    });
    expect(mocks.progressDeleteMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["p1", "p2"] } },
    });
    const where = mocks.goalUpdateMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).not.toContain("startsWith");
  });

  it("limits both deletes to one mode when asked", async () => {
    mocks.goalUpdateMany.mockResolvedValue({ count: 1 });
    await forgetSeoGoalValues(["p1"], { isMock: true });
    expect(mocks.goalUpdateMany).toHaveBeenCalledWith({
      where: {
        projectId: { in: ["p1"] },
        metricKey: { in: [...SEO_GOAL_METRIC_KEYS] },
        isMock: true,
      },
      data: { currentValue: null },
    });
    expect(mocks.progressDeleteMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["p1"] }, isMock: true },
    });
  });
});

describe("measureSeoGoal", () => {
  it("sums the last 30 final days for gsc.clicks", async () => {
    mocks.readFinalWindow.mockResolvedValue(window30(1234));
    mocks.readGscDays.mockResolvedValue([]);
    const measure = await measureSeoGoal(ctx() as never, "gsc.clicks");
    expect(mocks.readFinalWindow).toHaveBeenCalledWith("link1", {
      from: "2026-09-05",
      to: "2026-10-04",
    });
    expect(measure).toMatchObject({
      value: 1234,
      measuredThrough: "2026-10-04",
      reason: null,
    });
  });

  it("reports short_history for an incomplete window", async () => {
    mocks.readFinalWindow.mockResolvedValue(window30(900, false));
    mocks.readGscDays.mockResolvedValue([]);
    const measure = await measureSeoGoal(ctx() as never, "gsc.clicks");
    expect(measure).toMatchObject({ value: null, reason: "short_history" });
  });

  it("needs the brand split for gsc.nonBrandClicks", async () => {
    const measure = await measureSeoGoal(
      ctx({ brandSplitReady: false }) as never,
      "gsc.nonBrandClicks",
    );
    expect(measure).toMatchObject({ value: null, reason: "no_brand_split" });
    expect(mocks.readFinalWindow).not.toHaveBeenCalled();
  });

  it("builds a weekly series scaled to 30 days from complete final weeks only", async () => {
    mocks.readFinalWindow.mockResolvedValue(window30(1000));
    // Son tam hafta 2026-09-28 (7 gün × 10 tık = 70) ve tek günlük eksik hafta.
    const week = Array.from({ length: 7 }, (_, index) => ({
      ...day(10),
      day: addDays("2026-09-28", index),
    }));
    const partial = [{ ...day(10), day: "2026-09-21" }];
    mocks.readGscDays.mockResolvedValue([...partial, ...week]);
    const measure = await measureSeoGoal(ctx() as never, "gsc.clicks");
    expect(measure.series).toEqual([
      { week: "2026-09-28", value: Math.round((70 * 30) / 7) },
    ]);
  });

  it("counts the non-brand queries in the top 10 as the mean of the last 4 weeks", async () => {
    const weeks = [
      "2026-09-28",
      "2026-09-21",
      "2026-09-14",
      "2026-09-07",
      "2026-08-31",
    ];
    mocks.latestFetchedWeeks.mockResolvedValue(weeks);
    mocks.queryRaw.mockResolvedValue([
      { week: "2026-08-31", count: 100 },
      { week: "2026-09-07", count: 10 },
      { week: "2026-09-14", count: 12 },
      { week: "2026-09-21", count: 14 },
      { week: "2026-09-28", count: 15 },
    ]);
    const measure = await measureSeoGoal(
      ctx({ brandSplitReady: true }) as never,
      "gsc.top10Queries",
    );
    expect(measure.value).toBe(13);
    expect(measure.series.map((point) => point.week)).toEqual([
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
  });

  it("has no value with fewer than 4 weekly points", async () => {
    mocks.latestFetchedWeeks.mockResolvedValue(["2026-09-28", "2026-09-21"]);
    mocks.queryRaw.mockResolvedValue([]);
    const measure = await measureSeoGoal(
      ctx({ brandSplitReady: true }) as never,
      "gsc.top10Queries",
    );
    expect(measure).toMatchObject({ value: null, reason: "short_history" });
  });

  it("needs the brand split for gsc.top10Queries", async () => {
    mocks.latestFetchedWeeks.mockClear();
    mocks.queryRaw.mockClear();
    const measure = await measureSeoGoal(
      ctx({ brandSplitReady: false }) as never,
      "gsc.top10Queries",
    );
    expect(measure).toMatchObject({ value: null, reason: "no_brand_split" });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("answers no_health and no_cwv without reading W2 when the flags are off", async () => {
    vi.stubEnv("SEO_HEALTH", "");
    expect(
      await measureSeoGoal(ctx() as never, "seo.indexedShare"),
    ).toMatchObject({ value: null, reason: "no_health" });
    expect(
      await measureSeoGoal(ctx() as never, "seo.cwvGoodShare"),
    ).toMatchObject({ value: null, reason: "no_cwv" });
    expect(mocks.readCoverage).not.toHaveBeenCalled();
    expect(mocks.readLatestCwv).not.toHaveBeenCalled();
  });

  it("turns the coverage point into a percentage", async () => {
    vi.stubEnv("SEO_HEALTH", "true");
    mocks.readCoverage.mockResolvedValue({
      current: { point: 0.8768, weekStart: "2026-10-05" },
      history: [
        { point: 0.8, weekStart: "2026-09-28" },
        { point: 0.8768, weekStart: "2026-10-05" },
      ],
    });
    const measure = await measureSeoGoal(ctx() as never, "seo.indexedShare");
    expect(measure.value).toBe(87.7);
    expect(measure.measuredThrough).toBe("2026-10-05");
    expect(measure.series).toEqual([
      { week: "2026-09-28", value: 80 },
      { week: "2026-10-05", value: 87.7 },
    ]);
  });

  it("shares the good Core Web Vitals views", async () => {
    vi.stubEnv("SEO_HEALTH", "true");
    vi.stubEnv("GOOGLE_API_KEY", "key");
    mocks.readLatestCwv.mockResolvedValue({
      checkedAt: new Date("2026-10-03T08:00:00Z"),
      phone: { overall: "good" },
      desktop: { overall: "poor" },
      urls: [{ phone: { overall: "good" }, desktop: null }],
    });
    const measure = await measureSeoGoal(ctx() as never, "seo.cwvGoodShare");
    expect(measure.value).toBe(66.7);
    expect(measure.measuredThrough).toBe("2026-10-03");
  });
});

describe("refreshSeoGoals", () => {
  it("returns 0 without a report context", async () => {
    mocks.reportContextFor.mockResolvedValue(null);
    expect(await refreshSeoGoals("p1")).toBe(0);
    expect(mocks.goalFindMany).not.toHaveBeenCalled();
  });

  it("reads only the link's mode and exact keys, writes a changed value and the progress row", async () => {
    mocks.reportContextFor.mockResolvedValue(ctx());
    mocks.readFinalWindow.mockResolvedValue(window30(1500));
    mocks.readGscDays.mockResolvedValue([]);
    mocks.goalFindMany.mockResolvedValue([
      {
        id: "g1",
        workspaceId: "w1",
        metricKey: "gsc.clicks",
        targetValue: 2000,
        currentValue: 1000,
      },
      {
        id: "g2",
        workspaceId: "w1",
        metricKey: "gsc.clicks",
        targetValue: 2000,
        currentValue: 1500,
      },
    ]);
    const updated = await refreshSeoGoals("p1");
    expect(updated).toBe(1);
    expect(mocks.goalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "p1",
          status: { in: ["ACTIVE", "APPROVED"] },
          metricKey: { in: [...SEO_GOAL_METRIC_KEYS] },
          isMock: true,
        },
      }),
    );
    expect(mocks.goalUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.goalUpdate).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { currentValue: 1500 },
    });
    expect(mocks.progressUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.progressUpsert.mock.calls[0]![0]).toMatchObject({
      where: { goalId: "g1" },
      create: { projectId: "p1", linkId: "link1", isMock: true, value: 1500 },
    });
    expect(mocks.progressDeleteMany).toHaveBeenCalledWith({
      where: { projectId: "p1", isMock: true, goalId: { notIn: ["g1", "g2"] } },
    });
  });

  it("keeps the stored value when the metric cannot be measured", async () => {
    mocks.reportContextFor.mockResolvedValue(ctx({ brandSplitReady: false }));
    mocks.goalFindMany.mockResolvedValue([
      {
        id: "g1",
        workspaceId: "w1",
        metricKey: "gsc.nonBrandClicks",
        targetValue: 500,
        currentValue: 321,
      },
    ]);
    expect(await refreshSeoGoals("p1")).toBe(0);
    expect(mocks.goalUpdate).not.toHaveBeenCalled();
    expect(mocks.progressUpsert.mock.calls[0]![0].create).toMatchObject({
      value: null,
      reason: "no_brand_split",
      pace: "unknown",
    });
  });
});
