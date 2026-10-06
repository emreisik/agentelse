import type { GscSiteLink } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SearchForecast,
  SeoReportGoal,
  SeoReportOpportunity,
} from "@/lib/seo/reports/types";

const mocks = vi.hoisted(() => ({
  readOpportunities: vi.fn(),
  readOpenSearchAlerts: vi.fn(),
  readQuickWins: vi.fn(),
  readContentPlan: vi.fn(),
  listSeoGoals: vi.fn(),
  forecastSearchMonth: vi.fn(),
  readAuditSummary: vi.fn(),
}));

vi.mock("./inputs", () => ({
  readOpportunities: mocks.readOpportunities,
  readOpenSearchAlerts: mocks.readOpenSearchAlerts,
  readQuickWins: mocks.readQuickWins,
  readContentPlan: mocks.readContentPlan,
}));
vi.mock("./goals", () => ({ listSeoGoals: mocks.listSeoGoals }));
vi.mock("./forecast", () => ({
  forecastSearchMonth: mocks.forecastSearchMonth,
}));
vi.mock("@/server/seo/crawl/audit-summary", () => ({
  readAuditSummary: mocks.readAuditSummary,
}));

import { buildRoadmapReport } from "./roadmap";
import type { ReportLinkContext } from "./inputs";

const NEXT = "2026-10-01";
const NOW = new Date("2026-10-04T12:00:00Z");

function context(): ReportLinkContext {
  return {
    link: { id: "link1", isMock: false } as unknown as GscSiteLink,
    projectId: "p1",
    workspaceId: "w1",
    brandId: "b1",
    language: "en",
    timezone: "UTC",
    finalThrough: "2026-10-03",
    brandSplitReady: true,
    siteLabel: "example.com",
  };
}

function opportunity(id: string, priority: number): SeoReportOpportunity {
  return {
    id,
    title: `Opportunity ${id}`,
    action: "Rewrite titles",
    impactPerMonth: 20,
    reachPerMonth: null,
    confidence: "Solid",
    effort: "Low",
    status: "OPEN",
    priority,
  };
}

const GOAL: SeoReportGoal = {
  goalId: "g1",
  title: "Reach 1,200 search clicks a month",
  metricKey: "gsc.clicks",
  target: 1200,
  current: 900,
  pace: "behind",
  paceLabel: "Behind",
  measuredThrough: "2026-10-03",
  projected: 1000,
  projectedLow: 900,
  projectedHigh: 1100,
};

const FORECAST: SearchForecast = {
  metric: "clicks",
  month: NEXT,
  value: 950,
  low: 800,
  high: 1100,
  method: "trend",
  historyMonths: 6,
  errorPct: 0.15,
  newContent: null,
};

const savedHealth = process.env.SEO_HEALTH;

describe("buildRoadmapReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SEO_HEALTH = "true";
    mocks.readOpportunities.mockResolvedValue(null);
    mocks.readOpenSearchAlerts.mockResolvedValue(null);
    mocks.readQuickWins.mockResolvedValue([]);
    mocks.readContentPlan.mockResolvedValue([]);
    mocks.listSeoGoals.mockResolvedValue([]);
    mocks.forecastSearchMonth.mockResolvedValue(null);
    mocks.readAuditSummary.mockResolvedValue(null);
  });

  afterEach(() => {
    if (savedHealth === undefined) delete process.env.SEO_HEALTH;
    else process.env.SEO_HEALTH = savedHealth;
  });

  it("lists CRITICAL alerts first, then the opportunities with their finding ids", async () => {
    mocks.readOpportunities.mockResolvedValue([
      opportunity("f1", 90),
      opportunity("f2", 70),
    ]);
    mocks.readOpenSearchAlerts.mockResolvedValue([
      { kind: "SEO_ROBOTS_BLOCK", title: "Robots block", severity: "CRITICAL" },
    ]);
    const result = await buildRoadmapReport(context(), NEXT, NOW);
    if (!("snapshot" in result)) throw new Error("yol haritası beklendi");
    const section = result.snapshot.sections[0];
    if (section?.type !== "roadmap") throw new Error("roadmap beklendi");
    expect(section.actions.map((item) => item.source)).toEqual([
      "health",
      "opportunity",
      "opportunity",
    ]);
    expect(section.actions.map((item) => item.findingId)).toEqual([
      null,
      "f1",
      "f2",
    ]);
    expect(mocks.readOpportunities).toHaveBeenCalledWith("p1", 10);
    expect(result.snapshot).toMatchObject({
      kind: "ROADMAP",
      title: "SEO roadmap",
      periodKey: "M:2026-10",
      period: { from: NEXT, to: "2026-10-31", label: "October 2026" },
      compare: null,
      yearAgo: null,
      anonymousShare: null,
    });
  });

  it("reads quick wins only when there are no opportunities", async () => {
    mocks.readOpportunities.mockResolvedValue([opportunity("f1", 90)]);
    await buildRoadmapReport(context(), NEXT, NOW);
    expect(mocks.readQuickWins).not.toHaveBeenCalled();

    mocks.readOpportunities.mockResolvedValue(null);
    mocks.readQuickWins.mockResolvedValue([
      { query: "running shoes", impressions: 900, position: 9 },
    ]);
    const result = await buildRoadmapReport(context(), NEXT, NOW);
    expect(mocks.readQuickWins).toHaveBeenCalledTimes(1);
    if (!("snapshot" in result)) throw new Error("yol haritası beklendi");
    const section = result.snapshot.sections[0];
    if (section?.type !== "roadmap") throw new Error("roadmap beklendi");
    expect(section.actions.map((item) => item.source)).toEqual(["quick_win"]);
    expect(section.actions[0]!.findingId).toBeNull();
  });

  it("reads the technical audit only with SEO_HEALTH on", async () => {
    mocks.readOpenSearchAlerts.mockResolvedValue([
      { kind: "GSC_LOST_URLS", title: "Lost pages", severity: "WARN" },
    ]);
    mocks.readAuditSummary.mockResolvedValue({
      groups: [
        {
          code: "TA1",
          title: "Missing titles",
          severity: "WARN",
          count: 12,
          samples: [],
        },
      ],
    });
    const on = await buildRoadmapReport(context(), NEXT, NOW);
    expect(mocks.readAuditSummary).toHaveBeenCalledWith("p1");
    if (!("snapshot" in on)) throw new Error("yol haritası beklendi");
    const section = on.snapshot.sections[0];
    if (section?.type !== "roadmap") throw new Error("roadmap beklendi");
    expect(section.techDebt.map((item) => item.source)).toContain("audit");

    mocks.readAuditSummary.mockClear();
    process.env.SEO_HEALTH = "false";
    const off = await buildRoadmapReport(context(), NEXT, NOW);
    expect(mocks.readAuditSummary).not.toHaveBeenCalled();
    if (!("snapshot" in off)) throw new Error("yol haritası beklendi");
    const offSection = off.snapshot.sections[0];
    if (offSection?.type !== "roadmap") throw new Error("roadmap beklendi");
    expect(offSection.techDebt.map((item) => item.source)).not.toContain(
      "audit",
    );
  });

  it("adds the planned articles, goals and the forecast for the planned month in order", async () => {
    mocks.readOpportunities.mockResolvedValue([opportunity("f1", 90)]);
    mocks.readContentPlan.mockResolvedValue([
      { title: "Trail guide", date: "2026-10-09", status: "APPROVED" },
    ]);
    mocks.listSeoGoals.mockResolvedValue([GOAL]);
    mocks.forecastSearchMonth.mockResolvedValue(FORECAST);
    const result = await buildRoadmapReport(context(), NEXT, NOW);
    if (!("snapshot" in result)) throw new Error("yol haritası beklendi");
    expect(result.snapshot.sections.map((section) => section.type)).toEqual([
      "roadmap",
      "content",
      "goals",
      "forecast",
    ]);
    const content = result.snapshot.sections[1];
    if (content?.type !== "content") return;
    expect(content.title).toBe("Planned SEO articles");
    expect(mocks.readContentPlan).toHaveBeenCalledWith("p1", NEXT, "UTC");
    expect(mocks.forecastSearchMonth).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      NEXT,
    );
  });

  it("still posts when only goals exist", async () => {
    mocks.listSeoGoals.mockResolvedValue([GOAL]);
    const result = await buildRoadmapReport(context(), NEXT, NOW);
    if (!("snapshot" in result)) throw new Error("yol haritası beklendi");
    expect(result.snapshot.sections.map((section) => section.type)).toEqual([
      "goals",
    ]);
  });

  it("skips as no_data when everything is empty", async () => {
    expect(await buildRoadmapReport(context(), NEXT, NOW)).toEqual({
      skipped: "no_data",
    });
  });
});
