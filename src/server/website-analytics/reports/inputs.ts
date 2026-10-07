import "server-only";

import type { GaFinding, GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, utcToZonedDateTimeLocal } from "@/lib/timezone";
import {
  gaInsightsModeFor,
  type GaInsightsMode,
} from "@/lib/website-analytics/analysis/flags";
import { gaRule } from "@/lib/website-analytics/analysis/registry";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  daysInRange,
  monthEnd,
  previousMonthStart,
  safeTimezone,
} from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import { completeThroughOf } from "@/lib/website-analytics/health/schedule";
import { finalGoalProgress } from "@/lib/website-analytics/reports/pace";
import type { LocalStamp } from "@/lib/website-analytics/reports/schedule";
import type {
  GaReportSettingsView,
} from "@/lib/website-analytics/reports/settings";
import type {
  MonthlyReportInput,
  PlanMonthTotals,
  PlanReportInput,
  PulseInput,
  ReportFindingsInput,
  ReportLinkInfo,
  ReportWindowData,
  WeeklyReportInput,
} from "@/lib/website-analytics/reports/types";
import { sumTotals, type GaPeriodTotals } from "@/lib/website-analytics/totals";
import { SITE_SEARCH_KEY } from "@/lib/website-analytics/weekly";
import { getProjectTimezone } from "@/server/chat/content-plan";
import {
  loadAnalysisDays,
  loadExcludedDays,
  projectCountry,
} from "@/server/website-analytics/analysis/inputs";
import { findingViewOf } from "@/server/website-analytics/analysis/read";
import { loadAgentelseReportSection } from "@/server/website-analytics/attribution/report-section";
import { loadMeasurementSummaryForLink } from "@/server/website-analytics/health/read";
import {
  readDailyTotals,
  readMergedSlices,
  readRollingUsers,
  readSlices,
  readWeekSlices,
} from "@/server/website-analytics/store";

import { loadMonthForecasts } from "./forecast";
import { GaGoals } from "./goals";
import { loadGaReportSettings } from "./settings";

// GA-F5 rapor girdileri: yalnız ambar okur (Google'a çağrı yok). Bağlam
// (saat dilimleri, ayarlar, bayraklar) ve dönem pencereleri burada toplanır;
// rapor metni ve kartlar saf kütüphanede (lib/website-analytics/reports)
// üretilir. Operatör günlükleri yalnız hata adı taşır.

export type GaReportContext = {
  link: GaPropertyLink;
  workspaceId: string;
  projectId: string;
  brandId: string | null;
  projectTimeZone: string;
  propertyTimeZone: string;
  propertyToday: string;
  localNow: LocalStamp;
  completeThrough: string | null;
  settings: GaReportSettingsView;
  insights: GaInsightsMode;
  websitePage: boolean;
  country: string | null;
  now: Date;
};

const PLAN_MONTHS = 16;
const FINDING_ROWS = 40;
const CHANGED_LIMIT = 5;
const OPPORTUNITY_LIMIT = 3;
const EVALUATED_LIMIT = 5;
const PULSE_HISTORY_DAYS = 63;
const PULSE_CHANNEL_DAYS = 56;
const PULSE_ALERT_LIMIT = 5;
const WINDOW28_DAYS = 28;

export async function loadGaReportContext(
  link: GaPropertyLink,
  now: Date,
): Promise<GaReportContext | null> {
  const project = await prisma.project.findUnique({
    where: { id: link.projectId },
    select: { workspaceId: true, status: true },
  });
  if (!project || project.status === "PAUSED" || project.status === "CLOSED") {
    return null;
  }
  const [brand, rawProjectZone, settings, country] = await Promise.all([
    prisma.brand.findFirst({
      where: { projectId: link.projectId, isDefault: true },
      select: { id: true },
    }),
    getProjectTimezone(link.projectId),
    loadGaReportSettings(link.projectId),
    projectCountry(link.projectId),
  ]);
  const projectTimeZone = safeTimezone(rawProjectZone);
  const propertyTimeZone = safeTimezone(link.timeZone);
  return {
    link,
    workspaceId: project.workspaceId,
    projectId: link.projectId,
    brandId: brand?.id ?? null,
    projectTimeZone,
    propertyTimeZone,
    propertyToday: dayKeyInTimezone(now, propertyTimeZone),
    localNow: utcToZonedDateTimeLocal(now, projectTimeZone).slice(0, 16),
    completeThrough: completeThroughOf(link.lastDailyDate),
    settings,
    insights: gaInsightsModeFor(link.projectId),
    websitePage: GaFlags.websitePage(),
    country,
    now,
  };
}

export function reportLinkInfo(ctx: GaReportContext): ReportLinkInfo {
  return {
    projectId: ctx.projectId,
    linkId: ctx.link.id,
    propertyName: ctx.link.propertyName,
    timeZone: ctx.propertyTimeZone,
    currency: ctx.link.currencyCode,
    isMock: ctx.link.isMock,
    dataThrough: ctx.completeThrough ?? "",
    // GA-F8: ek mülkün kartları ?property= taşır.
    propertyId: ctx.link.isPrimary ? null : ctx.link.propertyId,
  };
}

export type ReportWindowReport =
  "channel" | "landing" | "events" | "sourceMedium" | "campaign";

export async function loadReportWindow(
  linkId: string,
  range: { from: string; to: string },
  reports: readonly ReportWindowReport[],
): Promise<ReportWindowData> {
  const wants = (report: ReportWindowReport) => reports.includes(report);
  const [totalRows, channel, landing, events, sourceMedium, campaign] =
    await Promise.all([
      readDailyTotals(linkId, range.from, range.to),
      wants("channel")
        ? readSlices(linkId, "channel", range.from, range.to)
        : Promise.resolve([]),
      wants("landing")
        ? readMergedSlices(linkId, "landing_page", range.from, range.to, {
            edgeWeeks: "majority",
          })
        : Promise.resolve(null),
      wants("events")
        ? readSlices(linkId, "events", range.from, range.to)
        : Promise.resolve([]),
      wants("sourceMedium")
        ? readSlices(linkId, "source_medium", range.from, range.to)
        : Promise.resolve([]),
      wants("campaign")
        ? readSlices(linkId, "campaign", range.from, range.to)
        : Promise.resolve([]),
    ]);
  return {
    from: range.from,
    to: range.to,
    days: daysInRange(range.from, range.to),
    coveredDays: totalRows.length,
    preliminary: totalRows.some((row) => !row.isFinal),
    totals: sumTotals(totalRows),
    channel,
    landing: landing?.slices ?? [],
    events,
    sourceMedium,
    campaign,
    landingMissingDays: landing?.plan.missingDays ?? 0,
  };
}

const NO_FINDINGS: ReportFindingsInput = {
  insights: "off",
  changed: [],
  opportunities: [],
  evaluated: [],
  outcomeCounts: null,
};

function viewsOf(rows: readonly GaFinding[]): GaFindingView[] {
  const result: GaFindingView[] = [];
  for (const row of rows) {
    const view = findingViewOf(row);
    if (view) result.push(view);
  }
  return result;
}

export async function loadReportFindings(
  ctx: GaReportContext,
  range: { from: string; to: string },
  options: { insights: "on" | "pending" | "off"; evaluated: boolean },
): Promise<ReportFindingsInput> {
  if (ctx.insights !== "on") return { ...NO_FINDINGS };
  const linkId = ctx.link.id;
  const rows = await prisma.gaFinding.findMany({
    where: {
      linkId,
      mode: "live",
      periodStart: { lte: dayKeyToDate(range.to) },
      OR: [
        { status: "OPEN" },
        {
          status: { in: ["ACCEPTED", "DONE", "EVALUATED"] },
          periodEnd: { gte: dayKeyToDate(range.from) },
        },
      ],
    },
    orderBy: { priority: "desc" },
    take: FINDING_ROWS,
  });
  const all = viewsOf(rows);
  const changed = all
    .filter(
      (view) =>
        gaRule(view.ruleKey).list === "changed" &&
        view.period.to >= range.from,
    )
    .slice(0, CHANGED_LIMIT);
  const opportunities = all
    .filter(
      (view) =>
        gaRule(view.ruleKey).list === "opportunities" &&
        view.status === "OPEN",
    )
    .slice(0, OPPORTUNITY_LIMIT);
  let evaluated: typeof all = [];
  let outcomeCounts: ReportFindingsInput["outcomeCounts"] = null;
  if (options.evaluated) {
    const evaluatedWhere = {
      linkId,
      mode: "live",
      status: "EVALUATED",
      evaluatedAt: {
        gte: dayKeyToDate(range.from),
        lt: dayKeyToDate(addDays(range.to, 1)),
      },
    };
    const [evaluatedRows, grouped] = await Promise.all([
      prisma.gaFinding.findMany({
        where: evaluatedWhere,
        orderBy: { priority: "desc" },
        take: EVALUATED_LIMIT,
      }),
      prisma.gaFinding.groupBy({
        by: ["outcome"],
        where: evaluatedWhere,
        _count: { _all: true },
      }),
    ]);
    evaluated = viewsOf(evaluatedRows);
    const count = (outcome: string) =>
      grouped.find((row) => row.outcome === outcome)?._count._all ?? 0;
    outcomeCounts = {
      worked: count("WORKED"),
      didnt: count("DIDNT"),
      inconclusive: count("INCONCLUSIVE"),
    };
  }
  return {
    insights: options.insights,
    changed,
    opportunities,
    evaluated,
    outcomeCounts,
  };
}

// Tam aylar (oldest first). Günlük toplamlar ayı tamamen kapsıyorsa onlar,
// değilse tam (isFinal) aylık özet kullanılır; ikisi de yoksa ay atlanır.
export async function loadMonthTotals(
  linkId: string,
  months: readonly string[],
): Promise<PlanMonthTotals[]> {
  const result: PlanMonthTotals[] = [];
  for (const month of [...months].sort()) {
    const start = `${month}-01`;
    const end = monthEnd(start);
    const daysInMonth = daysInRange(start, end);
    const aggregate = await prisma.gaDailyTotal.aggregate({
      where: {
        linkId,
        date: { gte: dayKeyToDate(start), lte: dayKeyToDate(end) },
      },
      _count: { _all: true },
      _sum: { sessions: true, keyEvents: true, revenueMicros: true },
    });
    if (aggregate._count._all === daysInMonth) {
      result.push({
        month,
        days: daysInMonth,
        daysInMonth,
        sessions: aggregate._sum.sessions ?? 0,
        keyEvents: aggregate._sum.keyEvents ?? 0,
        revenue: Number(aggregate._sum.revenueMicros ?? BigInt(0)) / 1e6,
      });
      continue;
    }
    const summary = await prisma.gaMonthlySummary.findFirst({
      where: { linkId, month: dayKeyToDate(start), isFinal: true },
      select: { totals: true },
    });
    const totals = summary ? recordOf(summary.totals) : null;
    if (!totals || numberOf(totals.days) !== daysInMonth) continue;
    result.push({
      month,
      days: daysInMonth,
      daysInMonth,
      sessions: numberOf(totals.sessions),
      keyEvents: numberOf(totals.keyEvents),
      revenue: Number(bigintOf(totals.revenueMicros)) / 1e6,
    });
  }
  return result;
}

export async function historyDaysOf(
  linkId: string,
  through: string,
): Promise<number> {
  const first = await prisma.gaDailyTotal.findFirst({
    where: { linkId },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  return first ? daysInRange(dateToDayKey(first.date), through) : 0;
}

export async function insightsProgressOf(
  linkId: string,
): Promise<{ lastWeek: string | null; lastDailyDay: string | null }> {
  const run = await prisma.gaAnalysisRun.findUnique({
    where: { linkId },
    select: { lastWeek: true, lastDailyDay: true },
  });
  return {
    lastWeek: run?.lastWeek ?? null,
    lastDailyDay: run?.lastDailyDay ?? null,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bigintOf(value: unknown): bigint {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return BigInt(0);
}

// GaMonthlySummary.totals (revenueMicros metin) → dönem toplamları; eksik
// anahtarlar 0 sayılır.
function totalsOfSummary(value: unknown): GaPeriodTotals | null {
  const totals = recordOf(value);
  if (!totals) return null;
  return {
    dailyActiveUsersSum: numberOf(totals.dailyActiveUsersSum),
    newUsers: numberOf(totals.newUsers),
    sessions: numberOf(totals.sessions),
    engagedSessions: numberOf(totals.engagedSessions),
    engagementSec: numberOf(totals.engagementSec),
    sessionDurationSec: numberOf(totals.sessionDurationSec),
    screenPageViews: numberOf(totals.screenPageViews),
    keyEvents: numberOf(totals.keyEvents),
    revenueMicros: bigintOf(totals.revenueMicros),
    transactions: numberOf(totals.transactions),
  };
}

async function lastYearTotals(
  linkId: string,
  range: { from: string; to: string },
): Promise<{ from: string; to: string; totals: GaPeriodTotals } | null> {
  const rows = await readDailyTotals(linkId, range.from, range.to);
  if (rows.length !== daysInRange(range.from, range.to)) return null;
  return { from: range.from, to: range.to, totals: sumTotals(rows) };
}

async function lastYearMonthTotals(
  linkId: string,
  month: string,
): Promise<{ from: string; to: string; totals: GaPeriodTotals } | null> {
  const range = { from: month, to: monthEnd(month) };
  const fromDaily = await lastYearTotals(linkId, range);
  if (fromDaily) return fromDaily;
  const summary = await prisma.gaMonthlySummary.findUnique({
    where: { linkId_month: { linkId, month: dayKeyToDate(range.from) } },
    select: { totals: true },
  });
  const totals = summary ? totalsOfSummary(summary.totals) : null;
  return totals ? { ...range, totals } : null;
}

function sameMonthLastYear(monthStartDay: string): string {
  const [year, month] = monthStartDay.split("-");
  return `${Number(year) - 1}-${month}-01`;
}

const ALL_REPORTS: readonly ReportWindowReport[] = [
  "channel",
  "landing",
  "events",
  "sourceMedium",
  "campaign",
];
const COMPARE_REPORTS: readonly ReportWindowReport[] = [
  "channel",
  "landing",
  "events",
  "sourceMedium",
];

export async function loadWeeklyReportInput(
  ctx: GaReportContext,
  week: { monday: string; sunday: string },
  insights: "on" | "pending" | "off",
): Promise<WeeklyReportInput> {
  const { link } = ctx;
  const { monday, sunday } = week;
  const through = ctx.completeThrough ?? sunday;
  const previousRange = { from: addDays(monday, -7), to: addDays(sunday, -7) };
  const lastYearRange = {
    from: addDays(monday, -364),
    to: addDays(sunday, -364),
  };
  const [
    current,
    previous,
    lastYear,
    currentUsers,
    previousUsers,
    siteSearch,
    measurement,
    findings,
    goals,
    forecasts,
    agentelse,
  ] = await Promise.all([
    loadReportWindow(link.id, { from: monday, to: sunday }, ALL_REPORTS),
    loadReportWindow(link.id, previousRange, COMPARE_REPORTS),
    lastYearTotals(link.id, lastYearRange),
    readRollingUsers(link.id, sunday),
    readRollingUsers(link.id, previousRange.to),
    GaFlags.weekly()
      ? readWeekSlices(link.id, SITE_SEARCH_KEY, monday, monday)
      : Promise.resolve(null),
    loadMeasurementSummaryForLink(link.id),
    loadReportFindings(ctx, { from: monday, to: sunday }, {
      insights,
      evaluated: false,
    }),
    // GA-F8: hedefler projeye aittir; ek mülklerde okunmaz.
    link.isPrimary
      ? GaGoals.loadProgress(ctx.projectId)
      : Promise.resolve([] as Awaited<ReturnType<typeof GaGoals.loadProgress>>),
    loadMonthForecasts({ linkId: link.id, through, country: ctx.country }),
    // GA-F6: bayrak kapalıysa sorgusuz null döner; hata da null'dır.
    loadAgentelseReportSection({
      projectId: ctx.projectId,
      range: { from: monday, to: sunday },
      gaCurrency: link.currencyCode,
    }),
  ]);
  return {
    link: reportLinkInfo(ctx),
    builtAt: ctx.now.toISOString(),
    websitePage: ctx.websitePage,
    current,
    previous,
    lastYear,
    users: {
      current: currentUsers?.[7]?.activeUsers ?? null,
      previous: previousUsers?.[7]?.activeUsers ?? null,
    },
    siteSearch,
    measurement,
    findings,
    goals,
    goalsMonth: through.slice(0, 7),
    forecasts,
    ...(agentelse ? { agentelse } : {}),
  };
}

export async function loadMonthlyReportInput(
  ctx: GaReportContext,
  month: string,
  insights: "on" | "pending" | "off",
): Promise<MonthlyReportInput> {
  const { link } = ctx;
  const from = `${month}-01`;
  const to = monthEnd(from);
  const previousFrom = previousMonthStart(from);
  const previousRange = { from: previousFrom, to: monthEnd(previousFrom) };
  const [
    current,
    previous,
    lastYear,
    measurement,
    findings,
    trackedGoals,
  ] = await Promise.all([
    loadReportWindow(link.id, { from, to }, ALL_REPORTS),
    loadReportWindow(link.id, previousRange, COMPARE_REPORTS),
    lastYearMonthTotals(link.id, sameMonthLastYear(from)),
    loadMeasurementSummaryForLink(link.id),
    loadReportFindings(ctx, { from, to }, { insights, evaluated: true }),
    link.isPrimary
      ? GaGoals.loadTrackedGoals(ctx.projectId)
      : Promise.resolve(
          [] as Awaited<ReturnType<typeof GaGoals.loadTrackedGoals>>,
        ),
  ]);
  // Biten ayın hedef sonucu GaGoalProgress'ten değil, ayın günlük
  // toplamlarından hesaplanır (progress satırı yeni ayı taşıyor olabilir).
  const goals = finalGoalProgress({
    goals: trackedGoals,
    month,
    totals: {
      sessions: current.totals.sessions,
      keyEvents: current.totals.keyEvents,
      revenue: Number(current.totals.revenueMicros) / 1e6,
    },
    updatedAt: ctx.now.toISOString(),
  });
  return {
    link: reportLinkInfo(ctx),
    builtAt: ctx.now.toISOString(),
    websitePage: ctx.websitePage,
    current,
    previous,
    lastYear,
    // Aylık özet sorun penceresinden sonra yazıldığı için ay raporunda
    // tekil kullanıcı satırı yoktur.
    users: { current: null, previous: null },
    siteSearch: null,
    measurement,
    findings,
    goals,
    goalsMonth: month,
    month,
  };
}

function monthKeysBefore(month: string, count: number): string[] {
  const keys: string[] = [];
  let cursor = `${month}-01`;
  for (let index = 0; index < count; index += 1) {
    cursor = previousMonthStart(cursor);
    keys.push(cursor.slice(0, 7));
  }
  return keys.reverse();
}

export async function loadPlanReportInput(
  ctx: GaReportContext,
  month: string,
): Promise<PlanReportInput> {
  const { link } = ctx;
  const through = ctx.completeThrough ?? ctx.propertyToday;
  const window28 = { from: addDays(through, -(WINDOW28_DAYS - 1)), to: through };
  const [months, trackedGoals, findingRows, window, forecasts, historyDays] =
    await Promise.all([
      loadMonthTotals(link.id, monthKeysBefore(month, PLAN_MONTHS)),
      link.isPrimary
        ? GaGoals.loadTrackedGoals(ctx.projectId)
        : Promise.resolve(
            [] as Awaited<ReturnType<typeof GaGoals.loadTrackedGoals>>,
          ),
      ctx.insights === "on"
        ? prisma.gaFinding.findMany({
            where: { linkId: link.id, mode: "live", status: "OPEN" },
            orderBy: { priority: "desc" },
            take: FINDING_ROWS,
          })
        : Promise.resolve([] as GaFinding[]),
      loadReportWindow(link.id, window28, ["channel", "landing"]),
      loadMonthForecasts({ linkId: link.id, through, country: ctx.country }),
      historyDaysOf(link.id, through),
    ]);
  const findings = viewsOf(findingRows)
    .filter((view) => gaRule(view.ruleKey).list === "opportunities")
    .slice(0, OPPORTUNITY_LIMIT);
  return {
    link: reportLinkInfo(ctx),
    builtAt: ctx.now.toISOString(),
    websitePage: ctx.websitePage,
    month,
    months,
    goals: trackedGoals.map((goal) => ({
      id: goal.id,
      metricKey: goal.metricKey,
      targetValue: goal.targetValue,
    })),
    findings,
    window28: window,
    forecasts,
    historyDays,
  };
}

export async function loadPulseInput(
  ctx: GaReportContext,
  day: string,
  alertsSince: Date,
): Promise<PulseInput> {
  const { link } = ctx;
  const range = { from: addDays(day, -PULSE_HISTORY_DAYS), to: day };
  const [days, excluded, channelSlices, alertRows, anomalyRows] =
    await Promise.all([
      loadAnalysisDays(link.id, range),
      loadExcludedDays(link.id, ctx.country, range),
      readSlices(link.id, "channel", addDays(day, -PULSE_CHANNEL_DAYS), day),
      prisma.adsAlert.findMany({
        where: {
          projectId: ctx.projectId,
          source: "GA4",
          status: { in: ["OPEN", "ACKED"] },
          severity: { in: ["WARN", "CRITICAL"] },
        },
        orderBy: [{ severity: "desc" }, { firstSeenAt: "desc" }],
        take: PULSE_ALERT_LIMIT,
        // detail ve data hiç okunmaz (Google verisi taşıyabilir).
        select: {
          id: true,
          kind: true,
          title: true,
          severity: true,
          firstSeenAt: true,
        },
      }),
      ctx.insights === "on"
        ? prisma.gaFinding.findMany({
            where: {
              linkId: link.id,
              mode: "live",
              status: "OPEN",
              ruleKey: "AN1",
              periodStart: dayKeyToDate(day),
            },
            orderBy: { priority: "desc" },
            take: FINDING_ROWS,
          })
        : Promise.resolve([] as GaFinding[]),
    ]);
  // Aynı gün ve ondan önceki 8 haftanın aynı haftanın günü.
  const sameWeekday = new Set(
    Array.from({ length: 9 }, (_, index) => addDays(day, -7 * index)),
  );
  const alerts: PulseInput["alerts"] = [];
  for (const row of alertRows) {
    if (row.severity !== "WARN" && row.severity !== "CRITICAL") continue;
    alerts.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      severity: row.severity,
      firstSeenAt: row.firstSeenAt.toISOString(),
      isNew: row.firstSeenAt.getTime() > alertsSince.getTime(),
    });
  }
  return {
    link: reportLinkInfo(ctx),
    builtAt: ctx.now.toISOString(),
    websitePage: ctx.websitePage,
    day,
    days,
    suspect: excluded.suspect,
    holidays: excluded.holidays,
    channelDays: channelSlices
      .filter((slice) => sameWeekday.has(slice.day))
      .map((slice) => ({ day: slice.day, slice })),
    alerts,
    anomalies: viewsOf(anomalyRows),
  };
}
