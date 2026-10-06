import { readFileSync } from "node:fs";
import path from "node:path";

import type { GscSiteLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DiagnoseInput,
  SearchDiagnosis,
  SearchForecast,
  SeoRange,
  SeoReportGoal,
} from "@/lib/seo/reports/types";
import type { GscSplit, GscTotals } from "@/lib/seo/totals";

const mocks = vi.hoisted(() => ({
  gscDataThrough: vi.fn(),
  readPeriodCoverage: vi.fn(),
  readFinalWindow: vi.fn(),
  readRankedDeltas: vi.fn(),
  readAnonymousShare: vi.fn(),
  readHealthSummary: vi.fn(),
  readActions: vi.fn(),
  readContentPlan: vi.fn(),
  readUpdates: vi.fn(),
  listSeoGoals: vi.fn(),
  refreshSeoGoals: vi.fn(),
  forecastSearchMonth: vi.fn(),
  loadDiagnoseInput: vi.fn(),
  diagnoseSearchDrop: vi.fn(),
}));

vi.mock("@/server/seo/store", () => ({
  gscDataThrough: mocks.gscDataThrough,
  readPeriodCoverage: mocks.readPeriodCoverage,
}));
vi.mock("./inputs", () => ({
  readFinalWindow: mocks.readFinalWindow,
  readRankedDeltas: mocks.readRankedDeltas,
  readAnonymousShare: mocks.readAnonymousShare,
  readHealthSummary: mocks.readHealthSummary,
  readActions: mocks.readActions,
  readContentPlan: mocks.readContentPlan,
  readUpdates: mocks.readUpdates,
  // weekly.ts'in (paylaşılan yardımcılar) içe aktardığı okuyucular
  readOpportunities: vi.fn(),
}));
vi.mock("./goals", () => ({
  listSeoGoals: mocks.listSeoGoals,
  refreshSeoGoals: mocks.refreshSeoGoals,
}));
vi.mock("./forecast", () => ({
  forecastSearchMonth: mocks.forecastSearchMonth,
}));
vi.mock("./diagnose", () => ({ loadDiagnoseInput: mocks.loadDiagnoseInput }));
vi.mock("@/lib/seo/reports/diagnose", async () => ({
  ...(await vi.importActual<typeof import("@/lib/seo/reports/diagnose")>(
    "@/lib/seo/reports/diagnose",
  )),
  diagnoseSearchDrop: mocks.diagnoseSearchDrop,
}));

import { buildMonthlyReport } from "./monthly";
import type { ReportLinkContext } from "./inputs";

const MONTH = "2026-09-01";
const PREV = "2026-08-01";
const NEXT = "2026-10-01";
const NOW = new Date("2026-10-07T12:00:00Z");

function totals(clicks: number, impressions: number): GscTotals {
  return { clicks, impressions, positionWeighted: impressions * 4 };
}

function split(clicks: number, impressions: number, brand = 100): GscSplit {
  return {
    total: totals(clicks, impressions),
    brand: totals(brand, impressions / 5),
    nonBrand: totals(clicks - brand, impressions - impressions / 5),
  };
}

function windowOf(value: GscSplit, complete = true) {
  return {
    days: [],
    complete,
    split: value,
    missingDays: complete ? 0 : 1,
    freshDays: complete ? 0 : 1,
  };
}

function context(): ReportLinkContext {
  return {
    link: {
      id: "link1",
      isMock: false,
      lastWeeklyWeek: "2026-09-28",
      lastMonthlyMonth: MONTH,
    } as unknown as GscSiteLink,
    projectId: "p1",
    workspaceId: "w1",
    brandId: "b1",
    language: "en",
    timezone: "Europe/Skopje",
    finalThrough: "2026-10-04",
    brandSplitReady: true,
    siteLabel: "example.com",
  };
}

const GOAL: SeoReportGoal = {
  goalId: "g1",
  title: "Reach 1,200 non-brand search clicks a month",
  metricKey: "gsc.nonBrandClicks",
  target: 1200,
  current: 900,
  pace: "on_track",
  paceLabel: "On track",
  measuredThrough: "2026-10-04",
  projected: 1250,
  projectedLow: 1100,
  projectedHigh: 1400,
};

const FORECAST: SearchForecast = {
  metric: "nonBrandClicks",
  month: NEXT,
  value: 950,
  low: 800,
  high: 1100,
  method: "trend",
  historyMonths: 6,
  errorPct: 0.15,
  newContent: null,
};

function diagnosis(dropped: boolean): SearchDiagnosis {
  return {
    v: 1,
    metric: "nonBrandClicks",
    window: {
      current: { from: MONTH, to: "2026-09-30" },
      previous: { from: PREV, to: "2026-08-31" },
    },
    current: 700,
    previous: 1000,
    changePct: -0.3,
    dropped,
    primary: dropped ? "ranking" : null,
    also: [],
    steps: [],
    askUser: [],
    summary: "Clicks dropped.",
  };
}

function setup(
  options: { cur?: GscSplit; prev?: GscSplit; curComplete?: boolean } = {},
) {
  const cur = options.cur ?? split(1500, 20000);
  const prev = options.prev ?? split(1450, 19000);
  mocks.gscDataThrough.mockResolvedValue({
    through: "2026-10-05",
    finalThrough: "2026-10-04",
    earliest: "2025-01-01",
  });
  mocks.readPeriodCoverage.mockImplementation(
    async (
      _link: string,
      _grain: string,
      _key: string,
      from: string,
      to: string,
    ) => ({
      periods: [PREV, MONTH].filter((day) => day >= from && day <= to),
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    }),
  );
  mocks.readFinalWindow.mockImplementation(
    async (_link: string, range: SeoRange) => {
      if (range.from === MONTH)
        return windowOf(cur, options.curComplete ?? true);
      if (range.from === PREV) return windowOf(prev);
      return windowOf(split(900, 12000));
    },
  );
  mocks.readRankedDeltas.mockResolvedValue([]);
  mocks.readAnonymousShare.mockResolvedValue({ share: 0.05, truncated: true });
  mocks.readHealthSummary.mockResolvedValue(null);
  mocks.readActions.mockResolvedValue(null);
  mocks.readContentPlan.mockResolvedValue([]);
  mocks.readUpdates.mockResolvedValue(null);
  mocks.listSeoGoals.mockResolvedValue([]);
  mocks.forecastSearchMonth.mockResolvedValue(null);
  mocks.loadDiagnoseInput.mockResolvedValue({} as DiagnoseInput);
  mocks.diagnoseSearchDrop.mockReturnValue(diagnosis(true));
}

function types(result: Awaited<ReturnType<typeof buildMonthlyReport>>) {
  if (!("snapshot" in result)) throw new Error("rapor beklendi");
  return result.snapshot.sections.map((section) => section.type);
}

describe("buildMonthlyReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never imports or calls refreshSeoGoals", async () => {
    setup();
    mocks.listSeoGoals.mockResolvedValue([GOAL]);
    await buildMonthlyReport(context(), MONTH, NOW);
    expect(mocks.refreshSeoGoals).not.toHaveBeenCalled();
    const source = readFileSync(
      path.join(process.cwd(), "src/server/seo/reports/monthly.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/import[^;]*refreshSeoGoals/);
  });

  it("adds goals and the forecast for the next month when they return data", async () => {
    setup();
    mocks.listSeoGoals.mockResolvedValue([GOAL]);
    mocks.forecastSearchMonth.mockResolvedValue(FORECAST);
    const result = await buildMonthlyReport(context(), MONTH, NOW);
    expect(types(result)).toEqual(["kpis", "goals", "forecast"]);
    expect(mocks.forecastSearchMonth).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      NEXT,
    );
    if (!("snapshot" in result)) return;
    expect(result.snapshot).toMatchObject({
      kind: "MONTHLY",
      title: "Monthly SEO report",
      periodKey: "M:2026-09",
      period: { from: MONTH, to: "2026-09-30", label: "September 2026" },
      compare: { from: PREV, to: "2026-08-31", label: "August 2026" },
      yearAgo: { from: "2025-09-01", to: "2025-09-30" },
      anonymousShare: 0.05,
    });
    const kpis = result.snapshot.sections[0];
    if (kpis?.type !== "kpis") throw new Error("kpis beklendi");
    expect(kpis.compareLabel).toBe("vs the month before");
    expect(kpis.yearAgoLabel).toBe("vs last year");
    expect(result.snapshot.notes).toContain(
      "Google returned only the top rows for part of this period.",
    );
  });

  it("omits goals and the forecast when there is nothing to show", async () => {
    setup();
    expect(types(await buildMonthlyReport(context(), MONTH, NOW))).toEqual([
      "kpis",
    ]);
  });

  it("diagnoses a drop with the calendar-month windows and the MONTH table grain", async () => {
    setup({ cur: split(1000, 20000), prev: split(1500, 21000) });
    const result = await buildMonthlyReport(context(), MONTH, NOW);
    expect(types(result)).toEqual(["kpis", "diagnosis"]);
    expect(mocks.loadDiagnoseInput).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      {
        windows: {
          current: { from: MONTH, to: "2026-09-30" },
          previous: { from: PREV, to: "2026-08-31" },
          tableGrain: "MONTH",
        },
        now: NOW,
      },
    );
  });

  it("reads the MONTH grain tables with a minimum delta of 10", async () => {
    setup();
    mocks.readRankedDeltas.mockImplementation(
      async (input: { dimension: string }) => {
        const label = input.dimension === "query" ? "q" : "/p";
        return [
          {
            id: `${label}1`,
            label: `${label} big`,
            url: null,
            isBrand: false,
            firstSeen: PREV,
            current: totals(40, 400),
            previous: totals(20, 400),
          },
          {
            id: `${label}2`,
            label: `${label} small`,
            url: null,
            isBrand: false,
            firstSeen: PREV,
            current: totals(25, 400),
            previous: totals(20, 400),
          },
        ];
      },
    );
    const result = await buildMonthlyReport(context(), MONTH, NOW);
    if (!("snapshot" in result)) throw new Error("rapor beklendi");
    const tables = result.snapshot.sections.flatMap((section) =>
      section.type === "table" ? [section.table] : [],
    );
    expect(tables.map((table) => table.key)).toEqual([
      "winning_pages",
      "winning_queries",
    ]);
    expect(tables.map((table) => table.rows.map((row) => row.label))).toEqual([
      ["/p big"],
      ["q big"],
    ]);
    expect(mocks.readRankedDeltas).toHaveBeenCalledWith(
      expect.objectContaining({
        grain: "MONTH",
        current: { from: MONTH, to: MONTH },
        previous: { from: PREV, to: PREV },
      }),
    );
  });

  it("adds the content sections for both months, each only when it has items", async () => {
    setup();
    mocks.readContentPlan.mockImplementation(
      async (_project: string, month: string) =>
        month === MONTH
          ? [{ title: "Shoe guide", date: "2026-09-12", status: "PUBLISHED" }]
          : [{ title: "Trail guide", date: "2026-10-09", status: "APPROVED" }],
    );
    const result = await buildMonthlyReport(context(), MONTH, NOW);
    expect(types(result)).toEqual(["kpis", "content", "content"]);
    if (!("snapshot" in result)) return;
    const titles = result.snapshot.sections.flatMap((section) =>
      section.type === "content" ? [section.title] : [],
    );
    expect(titles).toEqual([
      "SEO articles this month",
      "Planned for next month",
    ]);
    expect(mocks.readContentPlan).toHaveBeenCalledWith(
      "p1",
      MONTH,
      "Europe/Skopje",
    );
    expect(mocks.readContentPlan).toHaveBeenCalledWith(
      "p1",
      NEXT,
      "Europe/Skopje",
    );

    mocks.readContentPlan.mockImplementation(
      async (_project: string, month: string) =>
        month === NEXT
          ? [{ title: "Trail guide", date: "2026-10-09", status: "APPROVED" }]
          : [],
    );
    const onlyNext = await buildMonthlyReport(context(), MONTH, NOW);
    expect(types(onlyNext)).toEqual(["kpis", "content"]);
  });

  it("keeps the section order when everything is present", async () => {
    setup({ cur: split(1000, 20000), prev: split(1500, 21000) });
    mocks.listSeoGoals.mockResolvedValue([GOAL]);
    mocks.forecastSearchMonth.mockResolvedValue(FORECAST);
    mocks.readHealthSummary.mockResolvedValue({
      score: 70,
      cappedByCritical: false,
      critical: 0,
      warn: 0,
      issues: [],
      coverage: null,
      cwv: null,
    });
    mocks.readActions.mockResolvedValue({
      accepted: 1,
      done: 1,
      evaluated: 0,
      items: [],
    });
    mocks.readContentPlan.mockResolvedValue([
      { title: "A", date: "2026-09-02", status: "PUBLISHED" },
    ]);
    mocks.readUpdates.mockResolvedValue([
      {
        name: "Core update",
        kind: "CORE",
        startedAt: "2026-09-05T00:00:00.000Z",
        endedAt: null,
        url: null,
      },
    ]);
    expect(types(await buildMonthlyReport(context(), MONTH, NOW))).toEqual([
      "kpis",
      "goals",
      "forecast",
      "diagnosis",
      "health",
      "actions",
      "content",
      "content",
      "updates",
    ]);
  });

  it("skips a month with a fresh day as not_final", async () => {
    setup({ curComplete: false });
    expect(await buildMonthlyReport(context(), MONTH, NOW)).toEqual({
      skipped: "not_final",
    });
  });

  it("skips as no_data without any impressions", async () => {
    setup({ cur: split(0, 0, 0), prev: split(0, 0, 0) });
    expect(await buildMonthlyReport(context(), MONTH, NOW)).toEqual({
      skipped: "no_data",
    });
  });

  it("skips as missing_summaries when the monthly summaries are not fetched", async () => {
    setup();
    const lagging = context();
    (lagging.link as { lastMonthlyMonth: string | null }).lastMonthlyMonth =
      PREV;
    expect(await buildMonthlyReport(lagging, MONTH, NOW)).toEqual({
      skipped: "missing_summaries",
    });
    mocks.readPeriodCoverage.mockResolvedValue({
      periods: [],
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    });
    expect(await buildMonthlyReport(context(), MONTH, NOW)).toEqual({
      skipped: "missing_summaries",
    });
  });
});
