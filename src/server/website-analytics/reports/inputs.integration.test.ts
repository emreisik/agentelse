import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { addDays, dayKeyToDate, monthEnd } from "@/lib/website-analytics/days";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  historyDaysOf,
  insightsProgressOf,
  loadGaReportContext,
  loadMonthlyReportInput,
  loadMonthTotals,
  loadPlanReportInput,
  loadPulseInput,
  loadReportFindings,
  loadWeeklyReportInput,
  type GaReportContext,
} from "./inputs";
import { GaGoals } from "./goals";
import { cleanupGaReportSeed, seedGaReportLink } from "./test-support";

// GA-F5 rapor girdileri gerçek Postgres'e karşı (Google'a hiç gidilmez):
// 120 günlük ambar; son tam hafta ve önceki ay girdileri tohumla birebir
// uyuşur, geçen yıl yoksa null, kullanıcılar aylıkta null; kısmi ay
// loadMonthTotals'ta atlanır; GA_INSIGHTS kapalıyken bulgu sorgusu yok;
// nabız uyarılarında isNew yalnız firstSeenAt > alertsSince için true.

const TIME_ZONE = "Europe/Istanbul";
// 2026-10-04 Pazar: son tam hafta 28 Eylül - 4 Ekim.
const THROUGH = "2026-10-04";
const DAYS = 120;
const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };

function sessionsOf(_day: string, index: number): number {
  return 100 + (index % 7) * 10;
}

describeIntegration("GA report inputs (GA-F5)", () => {
  const runId = randomUUID().slice(0, 8);
  const saved = {
    sync: process.env.GA_SYNC,
    reports: process.env.GA_REPORTS,
    insights: process.env.GA_INSIGHTS,
    weekly: process.env.GA_WEEKLY,
  };
  const now = zonedDateTimeToUtc("2026-10-07T10:00", TIME_ZONE);
  let fixture: AgencyFixture;
  let linkId: string;
  let ctx: GaReportContext;

  const first = addDays(THROUGH, -(DAYS - 1));
  const sessionsBetween = (from: string, to: string) => {
    let sum = 0;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      let index = 0;
      for (let d = first; d < day; d = addDays(d, 1)) index += 1;
      sum += sessionsOf(day, index);
    }
    return sum;
  };

  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeAll(async () => {
    process.env.GA_SYNC = "true";
    process.env.GA_REPORTS = "true";
    delete process.env.GA_INSIGHTS;
    delete process.env.GA_WEEKLY;
    fixture = await createAgencyFixture(`ga-inputs-${runId}`);
    const seeded = await seedGaReportLink({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      through: THROUGH,
      days: DAYS,
      sessions: sessionsOf,
      timeZone: TIME_ZONE,
    });
    linkId = seeded.linkId;
    const link = await prisma.gaPropertyLink.findUniqueOrThrow({
      where: { id: linkId },
    });
    const loaded = await loadGaReportContext(link, now);
    if (!loaded) throw new Error("context missing");
    ctx = loaded;
  });

  afterAll(async () => {
    restore("GA_SYNC", saved.sync);
    restore("GA_REPORTS", saved.reports);
    restore("GA_INSIGHTS", saved.insights);
    restore("GA_WEEKLY", saved.weekly);
    await cleanupGaReportSeed(fixture.projectId);
    await teardownAgencyFixture(fixture.workspaceId);
  });

  it("builds the context from the link and project", () => {
    expect(ctx.propertyTimeZone).toBe(TIME_ZONE);
    expect(ctx.propertyToday).toBe("2026-10-07");
    expect(ctx.completeThrough).toBe(THROUGH);
    expect(ctx.localNow).toMatch(/^2026-10-07T\d\d:\d\d$/);
    expect(ctx.brandId).toBe(fixture.brandId);
    expect(ctx.insights).toBe("off");
    expect(ctx.settings.stored).toBe(false);
  });

  it("returns no context for a paused project", async () => {
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { status: "PAUSED" },
    });
    expect(await loadGaReportContext(ctx.link, now)).toBeNull();
    await prisma.project.update({
      where: { id: fixture.projectId },
      data: { status: "ACTIVE" },
    });
    expect(await loadGaReportContext(ctx.link, now)).not.toBeNull();
  });

  it("loads the weekly input for the last full week", async () => {
    const input = await loadWeeklyReportInput(ctx, WEEK, "off");
    expect(input.current.from).toBe(WEEK.monday);
    expect(input.current.to).toBe(WEEK.sunday);
    expect(input.current.days).toBe(7);
    expect(input.current.coveredDays).toBe(7);
    expect(input.current.totals.sessions).toBe(
      sessionsBetween(WEEK.monday, WEEK.sunday),
    );
    expect(input.current.channel.length).toBe(7);
    expect(input.current.landing.length).toBe(7);
    expect(input.current.events.length).toBe(7);
    expect(input.current.sourceMedium.length).toBe(7);
    expect(input.previous.totals.sessions).toBe(
      sessionsBetween(addDays(WEEK.monday, -7), addDays(WEEK.sunday, -7)),
    );
    // Önceki hafta için kampanya okunmaz.
    expect(input.previous.campaign).toEqual([]);
    expect(input.lastYear).toBeNull();
    expect(input.siteSearch).toBeNull();
    expect(input.findings.insights).toBe("off");
    expect(input.goalsMonth).toBe("2026-10");
    expect(input.link.dataThrough).toBe(THROUGH);
    expect(input.users).toEqual({ current: null, previous: null });
  });

  it("loads the monthly input with final goal results and no users", async () => {
    const goal = await prisma.projectGoal.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Website sessions per month",
        metricKey: "web.sessions",
        targetValue: 1_000_000,
        status: "ACTIVE",
      },
    });
    const input = await loadMonthlyReportInput(ctx, "2026-09", "off");
    const monthTotal = sessionsBetween("2026-09-01", "2026-09-30");
    expect(input.month).toBe("2026-09");
    expect(input.current.from).toBe("2026-09-01");
    expect(input.current.to).toBe(monthEnd("2026-09-01"));
    expect(input.current.totals.sessions).toBe(monthTotal);
    expect(input.users).toEqual({ current: null, previous: null });
    expect(input.siteSearch).toBeNull();
    expect(input.goalsMonth).toBe("2026-09");
    const goalView = input.goals.find((view) => view.goalId === goal.id);
    expect(goalView).toMatchObject({
      month: "2026-09",
      forecastBasis: "complete",
      monthToDate: monthTotal,
      forecast: monthTotal,
      dayOfMonth: 30,
      daysInMonth: 30,
      pace: "behind",
    });
    expect(input.lastYear).toBeNull();
  });

  it("skips partial months in loadMonthTotals", async () => {
    const months = await loadMonthTotals(linkId, [
      "2026-05",
      "2026-06",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    // 120 günlük veri 7 Haziran'da başlar: Mayıs yok, Haziran kısmi, Ekim
    // henüz bitmedi.
    expect(months.map((entry) => entry.month)).toEqual(["2026-08", "2026-09"]);
    expect(months[1]?.sessions).toBe(sessionsBetween("2026-09-01", "2026-09-30"));
    expect(months[1]?.days).toBe(30);
  });

  it("uses a final monthly summary for a partial month", async () => {
    await prisma.gaMonthlySummary.create({
      data: {
        linkId,
        projectId: fixture.projectId,
        month: dayKeyToDate("2026-05-01"),
        totals: {
          sessions: 4000,
          keyEvents: 200,
          revenueMicros: "12500000",
          days: 31,
        },
        channels: [],
        topPages: [],
        isFinal: true,
      },
    });
    const months = await loadMonthTotals(linkId, ["2026-05"]);
    expect(months).toEqual([
      {
        month: "2026-05",
        days: 31,
        daysInMonth: 31,
        sessions: 4000,
        keyEvents: 200,
        revenue: 12.5,
      },
    ]);
  });

  it("measures history and insights progress", async () => {
    expect(await historyDaysOf(linkId, THROUGH)).toBe(DAYS);
    expect(await insightsProgressOf(linkId)).toEqual({
      lastWeek: null,
      lastDailyDay: null,
    });
    await prisma.gaAnalysisRun.create({
      data: {
        linkId,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        lastWeek: WEEK.monday,
        lastDailyDay: THROUGH,
      },
    });
    expect(await insightsProgressOf(linkId)).toEqual({
      lastWeek: WEEK.monday,
      lastDailyDay: THROUGH,
    });
  });

  it("loads no findings while GA_INSIGHTS is unset", async () => {
    const result = await loadReportFindings(ctx, { from: WEEK.monday, to: WEEK.sunday }, {
      insights: "on",
      evaluated: true,
    });
    expect(result).toEqual({
      insights: "off",
      changed: [],
      opportunities: [],
      evaluated: [],
      outcomeCounts: null,
    });
  });

  it("builds the plan input with months, goals and forecasts", async () => {
    const input = await loadPlanReportInput(ctx, "2026-10");
    expect(input.month).toBe("2026-10");
    expect(input.months.map((entry) => entry.month)).toContain("2026-09");
    expect(input.historyDays).toBe(DAYS);
    expect(input.goals).toHaveLength(1);
    expect(input.findings).toEqual([]);
    expect(input.window28.to).toBe(THROUGH);
    expect(input.window28.from).toBe(addDays(THROUGH, -27));
    expect(input.window28.channel).toHaveLength(28);
    expect(input.forecasts.map((entry) => entry.metric)).toEqual([
      "sessions",
      "keyEvents",
    ]);
    // Gelir yok: gelir tahmini üretilmez.
    expect(await GaGoals.loadTrackedGoals(fixture.projectId)).toHaveLength(1);
  });

  it("marks only newer pulse alerts as new and never reads detail", async () => {
    const since = new Date("2026-10-05T00:00:00.000Z");
    const base = {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      source: "GA4",
      detail: "page /secret?token=abc",
    };
    await prisma.adsAlert.createMany({
      data: [
        {
          ...base,
          kind: "GA_MH6",
          severity: "WARN",
          dedupeKey: `ga:${linkId}:old`,
          title: "Old warning",
          firstSeenAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        {
          ...base,
          kind: "GA_MH24",
          severity: "CRITICAL",
          dedupeKey: `ga:${linkId}:new`,
          title: "New critical",
          firstSeenAt: new Date("2026-10-06T00:00:00.000Z"),
        },
        {
          ...base,
          kind: "GA_MH7",
          severity: "INFO",
          dedupeKey: `ga:${linkId}:info`,
          title: "Info only",
          firstSeenAt: new Date("2026-10-06T00:00:00.000Z"),
        },
      ],
    });
    const input = await loadPulseInput(ctx, THROUGH, since);
    expect(input.alerts.map((alert) => [alert.title, alert.isNew])).toEqual([
      ["New critical", true],
      ["Old warning", false],
    ]);
    expect(JSON.stringify(input.alerts)).not.toContain("secret");
    expect(input.days.at(-1)?.day).toBe(THROUGH);
    expect(input.days).toHaveLength(64);
    // Aynı gün + önceki 8 haftanın aynı günü.
    expect(input.channelDays.map((entry) => entry.day)).toEqual(
      Array.from({ length: 9 }, (_, index) => addDays(THROUGH, -7 * (8 - index))),
    );
    expect(input.anomalies).toEqual([]);
  });
});
