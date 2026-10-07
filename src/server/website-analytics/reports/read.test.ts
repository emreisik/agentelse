import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  samplePlanCard,
  samplePulseCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";

// Bu dosyanın kanıtladığı: bayrak kapalıyken tempo haritası boş ve arşiv null
// döner, hiçbir sorgu atılmaz; arşiv yalnız haftalık / aylık / plan önekli
// kartları sorgular, geçersiz kartı düşürür ve sohbet bağlantısını verir.

const mocks = vi.hoisted(() => ({
  commandFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  loadProgress: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    command: { findMany: mocks.commandFindMany },
    gaPropertyLink: { findMany: mocks.linkFindMany },
  },
}));
vi.mock("./goals", () => ({
  GaGoals: { loadProgress: mocks.loadProgress },
}));

const { loadGoalPaceMap, loadWebsiteReportArchive } = await import("./read");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_REPORTS", "true");
  vi.stubEnv("GA_WEBSITE_PAGE", "true");
});

describe("loadGoalPaceMap", () => {
  it("returns an empty map without any call when the flag is off", async () => {
    vi.stubEnv("GA_REPORTS", "false");
    const map = await loadGoalPaceMap("p1");
    expect(map.size).toBe(0);
    expect(mocks.loadProgress).not.toHaveBeenCalled();
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("maps progress by goal id with label, tone and currency", async () => {
    mocks.loadProgress.mockResolvedValue([
      {
        goalId: "g1",
        title: "Website sessions per month",
        status: "ACTIVE",
        metricKey: "web.sessions",
        target: 1000,
        month: "2026-10",
        through: "2026-10-06",
        dayOfMonth: 6,
        daysInMonth: 31,
        monthToDate: 300,
        expectedToDate: 200,
        forecast: 1200,
        forecastLow: 1100,
        forecastHigh: 1300,
        forecastBasis: "ok",
        pace: "on_track",
        paceRatio: 1.2,
        updatedAt: "2026-10-07T08:00:00.000Z",
      },
    ]);
    mocks.linkFindMany.mockResolvedValue([{ currencyCode: "EUR" }]);
    const map = await loadGoalPaceMap("p1");
    const chip = map.get("g1");
    expect(chip).toMatchObject({
      goalId: "g1",
      pace: "on_track",
      label: "On track",
      tone: "good",
      month: "2026-10",
      monthLabel: "October 2026",
      forecast: 1200,
      low: 1100,
      high: 1300,
      format: "count",
      currency: "EUR",
    });
  });
});

describe("loadWebsiteReportArchive", () => {
  it("returns null without a query when the flag is off", async () => {
    vi.stubEnv("GA_REPORTS", "false");
    expect(await loadWebsiteReportArchive("p1")).toBeNull();
    expect(mocks.commandFindMany).not.toHaveBeenCalled();
  });

  it("queries only the weekly, monthly and plan prefixes", async () => {
    mocks.commandFindMany.mockResolvedValue([]);
    await loadWebsiteReportArchive("p1");
    const args = mocks.commandFindMany.mock.calls[0]?.[0] as {
      where: {
        workId: string;
        source: string;
        OR: { id: { startsWith: string } }[];
      };
      take: number;
    };
    expect(args.where.workId).toBe("wkga_p1");
    expect(args.where.source).toBe("SYSTEM");
    expect(args.where.OR.map((clause) => clause.id.startsWith)).toEqual([
      "garep_weekly_",
      "garep_monthly_",
      "garep_plan_",
    ]);
    expect(args.take).toBe(12);
  });

  it("keeps today's exact where without a link filter", async () => {
    mocks.commandFindMany.mockResolvedValue([]);
    await loadWebsiteReportArchive("p1", undefined, { linkId: null });
    await loadWebsiteReportArchive("p1", 12, {});
    const [first, second] = mocks.commandFindMany.mock.calls.map(
      (call) => call[0] as { where: Record<string, unknown> },
    );
    expect(Object.keys(first?.where ?? {})).toEqual([
      "projectId",
      "workId",
      "source",
      "OR",
    ]);
    expect(second?.where).toEqual(first?.where);
  });

  it("filters by link inside the query (Json path), ANDed with the prefixes", async () => {
    mocks.commandFindMany.mockResolvedValue([]);
    await loadWebsiteReportArchive("p1", undefined, { linkId: "l2" });
    const args = mocks.commandFindMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(args.where.parsedIntent).toEqual({
      path: ["card", "linkId"],
      equals: "l2",
    });
    expect(args.where.OR).toHaveLength(3);
    expect(args.take).toBe(12);
  });

  it("drops invalid and non-archive cards and links to the chat", async () => {
    const weekly = sampleWeeklyCard();
    const plan = samplePlanCard();
    mocks.commandFindMany.mockResolvedValue([
      {
        id: "garep_weekly_p1_2026-09-28",
        parsedIntent: { card: weekly },
        createdAt: new Date("2026-10-05T10:00:00Z"),
      },
      {
        id: "garep_weekly_p1_broken",
        parsedIntent: { card: { kind: "website-report", v: 9 } },
        createdAt: new Date("2026-10-04T10:00:00Z"),
      },
      {
        id: "garep_weekly_p1_none",
        parsedIntent: null,
        createdAt: new Date("2026-10-03T10:00:00Z"),
      },
      {
        id: "garep_pulse_p1_2026-10-05",
        parsedIntent: { card: samplePulseCard() },
        createdAt: new Date("2026-10-02T10:00:00Z"),
      },
      {
        id: "garep_plan_p1_2026-10",
        parsedIntent: { card: plan },
        createdAt: new Date("2026-10-01T10:00:00Z"),
      },
    ]);
    const items = await loadWebsiteReportArchive("p1");
    expect(items?.map((item) => item.commandId)).toEqual([
      "garep_weekly_p1_2026-09-28",
      "garep_plan_p1_2026-10",
    ]);
    expect(items?.[0]?.variant).toBe("weekly");
    expect(items?.[0]?.chatHref).toBe("/projects/p1?work=wkga_p1");
  });
});
