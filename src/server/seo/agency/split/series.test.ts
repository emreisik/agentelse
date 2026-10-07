import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: kimlikler 1000'lik parçalarla okunur; her kolun
// serisi hafta sırasıyla kurulur ve verisi olmayan sayfa girmez; kapsama
// yalnız istenen haftaları sayar ve kesilme bayrağı taşınır; boş hafta
// listesinde sorgu yok.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  coverage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gscWeeklyPage: { findMany: mocks.findMany } },
}));
vi.mock("@/server/seo/store", () => ({ readPeriodCoverage: mocks.coverage }));

const { loadArmSeries, SERIES_CHUNK } = await import("./series");

const WEEKS = ["2026-06-08", "2026-06-15"];

function row(pageId: string, week: string, clicks: number) {
  return {
    pageId,
    weekStart: new Date(`${week}T00:00:00.000Z`),
    clicks,
    impressions: clicks * 10,
    positionWeighted: clicks * 50,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.coverage.mockResolvedValue({
    periods: ["2026-06-08", "2026-06-15", "2026-06-22"],
    truncated: true,
    rowClicks: 0,
    rowImpressions: 0,
  });
});

describe("loadArmSeries", () => {
  it("builds ordered series per arm and skips pages without rows", async () => {
    mocks.findMany.mockImplementation(({ where }: { where: { pageId: { in: string[] } } }) =>
      Promise.resolve(
        where.pageId.in.includes("t1")
          ? [row("t1", "2026-06-15", 5), row("t1", "2026-06-08", 4)]
          : [row("c1", "2026-06-08", 3)],
      ),
    );
    const result = await loadArmSeries({
      linkId: "l",
      testIds: ["t1", "t-empty"],
      controlIds: ["c1"],
      weeks: WEEKS,
    });
    expect(result.test.map((series) => series.pageId)).toEqual(["t1"]);
    expect(result.test[0]?.weeks.map((week) => week.weekStart)).toEqual(WEEKS);
    expect(result.control[0]?.weeks[0]?.clicks).toBe(3);
  });

  it("chunks the ids by 1000 and parameterises the query", async () => {
    mocks.findMany.mockResolvedValue([]);
    const ids = Array.from({ length: SERIES_CHUNK * 2 + 5 }, (_, index) => `p${index}`);
    await loadArmSeries({ linkId: "link-9", testIds: ids, controlIds: [], weeks: WEEKS });
    expect(SERIES_CHUNK).toBe(1000);
    expect(mocks.findMany).toHaveBeenCalledTimes(3);
    const first = mocks.findMany.mock.calls[0]?.[0];
    expect(first.where.linkId).toBe("link-9");
    expect(first.where.pageId.in).toHaveLength(1000);
    expect(first.where.weekStart.in).toHaveLength(2);
    expect(mocks.findMany.mock.calls[2]?.[0].where.pageId.in).toHaveLength(5);
  });

  it("reports covered requested weeks and the truncated flag", async () => {
    mocks.findMany.mockResolvedValue([]);
    const result = await loadArmSeries({ linkId: "l", testIds: ["a"], controlIds: ["b"], weeks: WEEKS });
    expect([...result.coveredWeeks].sort()).toEqual(WEEKS);
    expect(result.truncated).toBe(true);
    expect(mocks.coverage).toHaveBeenCalledWith("l", "WEEK", "page", "2026-06-08", "2026-06-15");
  });

  it("does not query without weeks", async () => {
    const result = await loadArmSeries({ linkId: "l", testIds: ["a"], controlIds: [], weeks: [] });
    expect(result.test).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.coverage).not.toHaveBeenCalled();
  });
});
