import type { GscSiteLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DiagnoseInput,
  SearchDiagnosis,
  SeoRange,
  SeoReportHealth,
} from "@/lib/seo/reports/types";
import type { GscSplit, GscTotals } from "@/lib/seo/totals";

const mocks = vi.hoisted(() => ({
  gscDataThrough: vi.fn(),
  readPeriodCoverage: vi.fn(),
  readFinalWindow: vi.fn(),
  readRankedDeltas: vi.fn(),
  readAnonymousShare: vi.fn(),
  readHealthSummary: vi.fn(),
  readOpportunities: vi.fn(),
  readActions: vi.fn(),
  readUpdates: vi.fn(),
  loadDiagnoseInput: vi.fn(),
  diagnoseSearchDrop: vi.fn(),
  writes: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const model = {
    create: mocks.writes,
    createMany: mocks.writes,
    update: mocks.writes,
    updateMany: mocks.writes,
    upsert: mocks.writes,
    delete: mocks.writes,
    deleteMany: mocks.writes,
    findMany: vi.fn(async () => []),
  };
  return {
    prisma: new Proxy(
      { $executeRaw: mocks.writes, $transaction: mocks.writes },
      {
        get: (target, key) =>
          key in target ? Reflect.get(target, key) : model,
      },
    ),
  };
});
vi.mock("@/server/seo/store", () => ({
  gscDataThrough: mocks.gscDataThrough,
  readPeriodCoverage: mocks.readPeriodCoverage,
}));
vi.mock("./inputs", () => ({
  readFinalWindow: mocks.readFinalWindow,
  readRankedDeltas: mocks.readRankedDeltas,
  readAnonymousShare: mocks.readAnonymousShare,
  readHealthSummary: mocks.readHealthSummary,
  readOpportunities: mocks.readOpportunities,
  readActions: mocks.readActions,
  readUpdates: mocks.readUpdates,
}));
vi.mock("./diagnose", () => ({ loadDiagnoseInput: mocks.loadDiagnoseInput }));
vi.mock("@/lib/seo/reports/diagnose", async () => ({
  ...(await vi.importActual<typeof import("@/lib/seo/reports/diagnose")>(
    "@/lib/seo/reports/diagnose",
  )),
  diagnoseSearchDrop: mocks.diagnoseSearchDrop,
}));

import { buildWeeklyReport, primaryMetricDropped } from "./weekly";
import type { ReportLinkContext } from "./inputs";

const WEEK = "2026-09-28";
const PREV_WEEK = "2026-09-21";
const NOW = new Date("2026-10-07T12:00:00Z");

function totals(clicks: number, impressions: number): GscTotals {
  return { clicks, impressions, positionWeighted: impressions * 5 };
}

// toplam, marka ve markasız (marka ayrımı varsa).
function split(clicks: number, impressions: number, brand = 20): GscSplit {
  return {
    total: totals(clicks, impressions),
    brand: totals(brand, impressions / 5),
    nonBrand: totals(clicks - brand, impressions - impressions / 5),
  };
}

function plainSplit(clicks: number, impressions: number): GscSplit {
  return { total: totals(clicks, impressions), brand: null, nonBrand: null };
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

function context(
  overrides: Partial<ReportLinkContext> = {},
): ReportLinkContext {
  return {
    link: {
      id: "link1",
      isMock: false,
      lastWeeklyWeek: WEEK,
      lastMonthlyMonth: "2026-09-01",
    } as unknown as GscSiteLink,
    projectId: "p1",
    workspaceId: "w1",
    brandId: "b1",
    language: "en",
    timezone: "UTC",
    finalThrough: "2026-10-04",
    brandSplitReady: true,
    siteLabel: "example.com",
    ...overrides,
  };
}

function delta(
  label: string,
  current: number,
  previous: number,
  impressions = 100,
  previousImpressions = impressions,
) {
  return {
    id: label,
    label,
    url: null,
    isBrand: false,
    firstSeen: PREV_WEEK,
    current: totals(current, impressions),
    previous: totals(previous, previousImpressions),
  };
}

const HEALTH: SeoReportHealth = {
  score: 80,
  cappedByCritical: false,
  critical: 0,
  warn: 1,
  issues: [],
  coverage: null,
  cwv: null,
};

function diagnosis(dropped: boolean): SearchDiagnosis {
  return {
    v: 1,
    metric: "nonBrandClicks",
    window: {
      current: { from: WEEK, to: "2026-10-04" },
      previous: { from: PREV_WEEK, to: "2026-09-27" },
    },
    current: 70,
    previous: 100,
    changePct: -0.3,
    dropped,
    primary: dropped ? "demand" : null,
    also: [],
    steps: [],
    askUser: [],
    summary: "Clicks dropped.",
  };
}

type Windows = { cur: GscSplit; prev: GscSplit | null; curComplete?: boolean };

function setup(windows: Windows) {
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
      periods: [PREV_WEEK, WEEK].filter((day) => day >= from && day <= to),
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    }),
  );
  mocks.readFinalWindow.mockImplementation(
    async (_link: string, range: SeoRange) => {
      if (range.from === WEEK)
        return windowOf(windows.cur, windows.curComplete ?? true);
      if (range.from === PREV_WEEK) {
        return windowOf(
          windows.prev ?? plainSplit(0, 0),
          windows.prev !== null,
        );
      }
      // geçen yıl
      return windowOf(split(60, 600));
    },
  );
  mocks.readRankedDeltas.mockResolvedValue([]);
  mocks.readAnonymousShare.mockResolvedValue({ share: 0.1, truncated: false });
  mocks.readHealthSummary.mockResolvedValue(null);
  mocks.readOpportunities.mockResolvedValue(null);
  mocks.readActions.mockResolvedValue(null);
  mocks.readUpdates.mockResolvedValue(null);
  mocks.loadDiagnoseInput.mockResolvedValue({} as DiagnoseInput);
  mocks.diagnoseSearchDrop.mockReturnValue(diagnosis(true));
}

function sectionTypes(result: Awaited<ReturnType<typeof buildWeeklyReport>>) {
  if (!("snapshot" in result)) throw new Error("rapor beklendi");
  return result.snapshot.sections.map((section) => section.type);
}

describe("buildWeeklyReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips a week with a fresh day as not_final", async () => {
    setup({
      cur: split(100, 1000),
      prev: split(100, 1000),
      curComplete: false,
    });
    expect(await buildWeeklyReport(context(), WEEK, NOW)).toEqual({
      skipped: "not_final",
    });
    expect(mocks.readRankedDeltas).not.toHaveBeenCalled();
  });

  it("skips as missing_summaries when the weekly summaries are not fetched yet", async () => {
    setup({ cur: split(100, 1000), prev: split(100, 1000) });
    const lagging = context({
      link: {
        id: "link1",
        isMock: false,
        lastWeeklyWeek: PREV_WEEK,
      } as unknown as GscSiteLink,
    });
    expect(await buildWeeklyReport(lagging, WEEK, NOW)).toEqual({
      skipped: "missing_summaries",
    });

    // Bağın işareti güncel ama bu haftanın sorgu özeti yok.
    mocks.readPeriodCoverage.mockResolvedValue({
      periods: [],
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    });
    expect(await buildWeeklyReport(context(), WEEK, NOW)).toEqual({
      skipped: "missing_summaries",
    });
  });

  it("skips as no_data when both weeks have zero impressions", async () => {
    setup({ cur: split(0, 0, 0), prev: split(0, 0, 0) });
    expect(await buildWeeklyReport(context(), WEEK, NOW)).toEqual({
      skipped: "no_data",
    });
  });

  it("leaves out health, opportunities, actions and updates when their readers return null", async () => {
    setup({ cur: split(100, 1000), prev: split(100, 1000) });
    const result = await buildWeeklyReport(context(), WEEK, NOW);
    expect(sectionTypes(result)).toEqual(["kpis"]);
    // Boş okuyucu sonuçları (boş liste) da bölüm üretmez.
    mocks.readOpportunities.mockResolvedValue([]);
    mocks.readUpdates.mockResolvedValue([]);
    expect(sectionTypes(await buildWeeklyReport(context(), WEEK, NOW))).toEqual(
      ["kpis"],
    );
  });

  it("adds the sections in order when everything is on", async () => {
    setup({ cur: split(70, 1000), prev: split(100, 1000) });
    mocks.readRankedDeltas.mockImplementation(
      async (input: { dimension: string }) =>
        input.dimension === "query"
          ? [
              delta("lost one", 5, 20),
              delta("won one", 30, 10),
              delta("fresh one", 4, 0, 200, 0),
            ]
          : [delta("/lost", 4, 30), delta("/won", 25, 5)],
    );
    mocks.readHealthSummary.mockResolvedValue(HEALTH);
    mocks.readOpportunities.mockResolvedValue([
      {
        id: "f1",
        title: "Fix titles",
        action: "Rewrite titles",
        impactPerMonth: 12,
        reachPerMonth: null,
        confidence: "Solid",
        effort: "Low",
        status: "OPEN",
        priority: 80,
      },
    ]);
    mocks.readActions.mockResolvedValue({
      accepted: 1,
      done: 0,
      evaluated: 0,
      items: [{ title: "Fix titles", status: "ACCEPTED", outcome: null }],
    });
    mocks.readUpdates.mockResolvedValue([
      {
        name: "Core update",
        kind: "CORE",
        startedAt: "2026-09-29T00:00:00.000Z",
        endedAt: null,
        url: null,
      },
    ]);
    const result = await buildWeeklyReport(context(), WEEK, NOW);
    expect(sectionTypes(result)).toEqual([
      "kpis",
      "diagnosis",
      "table",
      "table",
      "table",
      "table",
      "table",
      "health",
      "opportunities",
      "actions",
      "updates",
    ]);
    if (!("snapshot" in result)) return;
    const tables = result.snapshot.sections.flatMap((section) =>
      section.type === "table" ? [section.table] : [],
    );
    expect(tables.map((table) => table.key)).toEqual([
      "losing_queries",
      "winning_queries",
      "rising_queries",
      "losing_pages",
      "winning_pages",
    ]);
    expect(tables.map((table) => table.aggregation)).toEqual([
      "By property",
      "By property",
      "By property",
      "By page",
      "By page",
    ]);
    expect(tables[0]!.rows.map((row) => row.label)).toEqual(["lost one"]);
    expect(tables[2]!.rows.map((row) => row.label)).toEqual(["fresh one"]);
    expect(result.snapshot.periodKey).toBe(`W:${WEEK}`);
    expect(result.snapshot.title).toBe("Weekly SEO report");
    expect(result.snapshot.period).toMatchObject({
      from: WEEK,
      to: "2026-10-04",
    });
    expect(result.snapshot.compare).toMatchObject({
      from: PREV_WEEK,
      to: "2026-09-27",
    });
    expect(result.snapshot.yearAgo).toMatchObject({ from: "2025-09-29" });
    expect(result.snapshot.site).toEqual({
      label: "example.com",
      isMock: false,
    });
    expect(result.snapshot.anonymousShare).toBe(0.1);
  });

  it("omits empty tables", async () => {
    setup({ cur: split(100, 1000), prev: split(100, 1000) });
    mocks.readRankedDeltas.mockResolvedValue([delta("same", 10, 10)]);
    expect(sectionTypes(await buildWeeklyReport(context(), WEEK, NOW))).toEqual(
      ["kpis"],
    );
  });

  it("adds a diagnosis for a 30% drop and uses the 7-day window ending on Sunday", async () => {
    setup({ cur: split(70, 1000), prev: split(100, 1000) });
    const result = await buildWeeklyReport(context(), WEEK, NOW);
    expect(sectionTypes(result)).toEqual(["kpis", "diagnosis"]);
    expect(mocks.loadDiagnoseInput).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      { days: 7, end: "2026-10-04", now: NOW },
    );
  });

  it("adds no diagnosis when the diagnosis tree does not confirm a drop", async () => {
    setup({ cur: split(70, 1000), prev: split(100, 1000) });
    mocks.diagnoseSearchDrop.mockReturnValue(diagnosis(false));
    expect(sectionTypes(await buildWeeklyReport(context(), WEEK, NOW))).toEqual(
      ["kpis"],
    );
  });

  it("does not load diagnosis input without a drop", async () => {
    setup({ cur: split(95, 1000), prev: split(100, 1000) });
    await buildWeeklyReport(context(), WEEK, NOW);
    expect(mocks.loadDiagnoseInput).not.toHaveBeenCalled();
  });

  it("does not diagnose a drop from a tiny previous value", async () => {
    // Birincil ölçü markasız: 20 → 10 (−50%) ama önceki değer 30'un altında.
    setup({ cur: split(15, 1000, 5), prev: split(40, 1000, 20) });
    await buildWeeklyReport(context(), WEEK, NOW);
    expect(mocks.loadDiagnoseInput).not.toHaveBeenCalled();
  });

  it("drops the brand KPIs and adds the note when the brand split is not ready", async () => {
    setup({ cur: plainSplit(100, 1000), prev: plainSplit(100, 1000) });
    const result = await buildWeeklyReport(
      context({ brandSplitReady: false }),
      WEEK,
      NOW,
    );
    if (!("snapshot" in result)) throw new Error("rapor beklendi");
    const kpis = result.snapshot.sections[0];
    expect(kpis?.type).toBe("kpis");
    if (kpis?.type !== "kpis") return;
    expect(kpis.kpis.map((kpi) => kpi.key)).toEqual([
      "clicks",
      "impressions",
      "ctr",
      "position",
    ]);
    expect(result.snapshot.brandSplit).toBe(false);
    expect(result.snapshot.notes).toContain(
      "Brand and non-brand split isn't ready yet, so totals are shown.",
    );
    expect(mocks.readRankedDeltas).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: "query", nonBrandOnly: false }),
    );
  });

  it("builds the KPI values from the mocked sums", async () => {
    setup({ cur: split(120, 2000, 30), prev: split(100, 1600, 20) });
    const result = await buildWeeklyReport(context(), WEEK, NOW);
    if (!("snapshot" in result)) throw new Error("rapor beklendi");
    const kpis = result.snapshot.sections[0];
    if (kpis?.type !== "kpis") throw new Error("kpis beklendi");
    const byKey = Object.fromEntries(kpis.kpis.map((kpi) => [kpi.key, kpi]));
    expect(byKey.clicks).toMatchObject({
      value: 120,
      previous: 100,
      yearAgo: 60,
    });
    expect(byKey.nonBrandClicks).toMatchObject({ value: 90, previous: 80 });
    expect(byKey.brandClicks).toMatchObject({ value: 30, previous: 20 });
    expect(byKey.impressions).toMatchObject({ value: 2000, previous: 1600 });
    expect(byKey.ctr?.value).toBe(6);
    expect(byKey.position?.value).toBe(5);
    expect(kpis.compareLabel).toBe("vs the week before");
    expect(kpis.yearAgoLabel).toBe("vs last year");
    expect(result.snapshot.notes).toContain(
      "10% of clicks come from searches Google doesn't show.",
    );
  });

  it("does not read last year when the warehouse starts later", async () => {
    setup({ cur: split(100, 1000), prev: split(100, 1000) });
    mocks.gscDataThrough.mockResolvedValue({
      through: "2026-10-05",
      finalThrough: "2026-10-04",
      earliest: "2026-01-01",
    });
    const result = await buildWeeklyReport(context(), WEEK, NOW);
    if (!("snapshot" in result)) throw new Error("rapor beklendi");
    expect(result.snapshot.yearAgo).toBeNull();
    const kpis = result.snapshot.sections[0];
    if (kpis?.type !== "kpis") throw new Error("kpis beklendi");
    expect(kpis.yearAgoLabel).toBeNull();
    expect(mocks.readFinalWindow).toHaveBeenCalledTimes(2);
  });

  it("reads actions for the week and updates for the period", async () => {
    setup({ cur: split(100, 1000), prev: split(100, 1000) });
    await buildWeeklyReport(context(), WEEK, NOW);
    expect(mocks.readActions).toHaveBeenCalledWith("p1", {
      from: new Date("2026-09-28T00:00:00.000Z"),
      to: new Date("2026-10-05T00:00:00.000Z"),
    });
    expect(mocks.readUpdates).toHaveBeenCalledWith(
      { from: WEEK, to: "2026-10-04" },
      NOW,
    );
    expect(mocks.readOpportunities).toHaveBeenCalledWith("p1", 5);
  });

  it("writes nothing", async () => {
    setup({ cur: split(70, 1000), prev: split(100, 1000) });
    mocks.readHealthSummary.mockResolvedValue(HEALTH);
    await buildWeeklyReport(context(), WEEK, NOW);
    expect(mocks.writes).not.toHaveBeenCalled();
  });
});

describe("primaryMetricDropped", () => {
  it("falls back to total clicks when only the current period has the brand split", () => {
    // Ayrım dönem ortasında hazır oldu: önceki dönemde markasız değer yok.
    expect(
      primaryMetricDropped(split(60, 1000, 10), plainSplit(200, 1000)),
    ).toBe(true);
  });

  it("compares non-brand clicks when both periods have them", () => {
    expect(
      primaryMetricDropped(split(100, 1000, 60), split(100, 1000, 20)),
    ).toBe(true);
    expect(
      primaryMetricDropped(split(100, 1000, 20), split(100, 1000, 20)),
    ).toBe(false);
  });
});
