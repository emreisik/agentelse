import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  holidayCountryOf,
  holidaysBetween,
} from "@/lib/website-analytics/analysis/holidays";
import {
  WEBSITE_GOAL_KEYS,
  type GaAnalysisDay,
  type GaDailyAnalysisInput,
  type GaGoalInput,
  type GaRange,
  type GaWebsiteGoalKey,
  type GaWeeklyAnalysisInput,
  type GaWindowReport,
} from "@/lib/website-analytics/analysis/types";
import {
  addDays,
  monthEnd,
  previousMonthStart,
  safeTimezone,
} from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import { aggregateSlices } from "@/lib/website-analytics/slices";
import { SITE_SEARCH_KEY } from "@/lib/website-analytics/weekly";
import {
  loadMeasurementSummaryForLink,
  readGaSuspectDays,
} from "@/server/website-analytics/health/read";
import {
  readDailyTotals,
  readSlices,
  readWeekSlices,
} from "@/server/website-analytics/store";

import { loadAdsCrossCheckInput } from "@/server/website-analytics/attribution/read";

import { loadGaWindowTables } from "./windows";

// GA-F4 kural girdileri (docs/website-insights.md "Veri"): günlük ve haftalık
// kısım için ambar okumaları. Şüpheli günler GA-F3'ün GaHealthRun.suspectDays
// alanından (bayrağa bağlı değil), tatiller projenin ülkesinden gelir. Ham
// pencereler (current/previous/lastYear/month) hiçbir günü dışarıda bırakmaz;
// 28 günlük pencereler ve 8 hafta şüpheli günleri dışarıda bırakır.

const HISTORY_DAYS = 400;
const CHANNEL_DAYS = 58;
const LAST_YEAR_DAYS = 364;
const AUDIENCE_WEEKS = 8;
const SITE_SEARCH_WEEKS = 4;

const RAW_WEEK_REPORTS: readonly GaWindowReport[] = [
  "channel",
  "landing",
  "pages",
  "events",
];
const WINDOW_REPORTS: readonly GaWindowReport[] = [
  "channel",
  "landing",
  "sourceMedium",
  "campaign",
  "device",
];
const AUDIENCE_REPORTS: readonly GaWindowReport[] = ["events", "newReturning"];
const MONTH_REPORTS: readonly GaWindowReport[] = ["channel", "landing"];
const NOTHING: ReadonlySet<string> = new Set();

export async function projectCountry(
  projectId: string,
): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { country: true, countries: true },
  });
  return project ? holidayCountryOf(project) : null;
}

export async function loadExcludedDays(
  linkId: string,
  country: string | null,
  range: GaRange,
): Promise<{ suspect: Set<string>; holidays: Set<string> }> {
  const suspect = await readGaSuspectDays(linkId, range.from, range.to);
  return {
    suspect: new Set(suspect.keys()),
    holidays: holidaysBetween(country, range.from, range.to),
  };
}

export async function loadAnalysisDays(
  linkId: string,
  range: GaRange,
): Promise<GaAnalysisDay[]> {
  const rows = await readDailyTotals(linkId, range.from, range.to);
  return rows.map((row) => ({
    day: row.day,
    sessions: row.sessions,
    engagedSessions: row.engagedSessions,
    keyEvents: row.keyEvents,
    revenue: Number(row.revenueMicros) / 1e6,
    transactions: row.transactions,
    isFinal: row.isFinal,
  }));
}

// GA-F3 özetinde kritik sorun varsa bütün adaylar DIRECTIONAL olur;
// GA_HEALTH kapalıyken özet null, kapı kapalı.
async function measurementDegraded(linkId: string): Promise<boolean> {
  const summary = await loadMeasurementSummaryForLink(linkId);
  return (summary?.critical ?? 0) > 0;
}

function isWebsiteGoalKey(value: string | null): value is GaWebsiteGoalKey {
  return (WEBSITE_GOAL_KEYS as readonly string[]).includes(value ?? "");
}

async function websiteGoals(projectId: string): Promise<GaGoalInput[]> {
  const rows = await prisma.projectGoal.findMany({
    where: {
      projectId,
      status: { in: ["APPROVED", "ACTIVE"] },
      isMock: false,
      metricKey: { in: [...WEBSITE_GOAL_KEYS] },
      targetValue: { gt: 0 },
    },
    select: { id: true, title: true, metricKey: true, targetValue: true },
    orderBy: { createdAt: "asc" },
  });
  const goals: GaGoalInput[] = [];
  for (const row of rows) {
    if (!isWebsiteGoalKey(row.metricKey) || !row.targetValue) continue;
    goals.push({
      id: row.id,
      title: row.title,
      metricKey: row.metricKey,
      target: row.targetValue,
    });
  }
  return goals;
}

function todayOf(link: GaPropertyLink, now: Date): string {
  return dayKeyInTimezone(now, safeTimezone(link.timeZone));
}

export async function loadDailyAnalysisInput(
  link: GaPropertyLink,
  targets: string[],
  now: Date,
): Promise<GaDailyAnalysisInput> {
  const through = targets[targets.length - 1] ?? todayOf(link, now);
  const range = { from: addDays(through, -HISTORY_DAYS), to: through };
  const country = await projectCountry(link.projectId);
  const [days, excluded, channelSlices, goals, degraded] = await Promise.all([
    loadAnalysisDays(link.id, range),
    loadExcludedDays(link.id, country, range),
    readSlices(link.id, "channel", addDays(through, -CHANNEL_DAYS), through),
    websiteGoals(link.projectId),
    measurementDegraded(link.id),
  ]);
  return {
    linkId: link.id,
    today: todayOf(link, now),
    targets,
    country,
    days,
    suspect: excluded.suspect,
    holidays: excluded.holidays,
    channelDays: channelSlices.map((slice) => ({
      day: slice.day,
      rows: aggregateSlices(
        [slice],
        ["sessionDefaultChannelGroup"],
        ["sessions", "keyEvents", "totalRevenue"],
      ),
    })),
    goals,
    measurementDegraded: degraded,
  };
}

function covers(days: readonly GaAnalysisDay[], range: GaRange): boolean {
  const present = new Set(days.map((day) => day.day));
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    if (!present.has(day)) return false;
  }
  return true;
}

async function siteSearchWeeks(
  linkId: string,
  monday: string,
): Promise<GaWeeklyAnalysisInput["siteSearch"]> {
  if (!GaFlags.weekly()) return null;
  const slices = await readWeekSlices(
    linkId,
    SITE_SEARCH_KEY,
    addDays(monday, -7 * (SITE_SEARCH_WEEKS - 1)),
    monday,
  );
  return slices.slice(-SITE_SEARCH_WEEKS).map((slice) => ({
    monday: slice.day,
    rows: aggregateSlices([slice], ["searchTerm"], ["eventCount"]),
  }));
}

export async function loadWeeklyAnalysisInput(
  link: GaPropertyLink,
  week: { monday: string; sunday: string },
  month: string | null,
  now: Date,
): Promise<GaWeeklyAnalysisInput> {
  const { monday, sunday } = week;
  const history = { from: addDays(sunday, -HISTORY_DAYS), to: sunday };
  const country = await projectCountry(link.projectId);
  const [days, excluded] = await Promise.all([
    loadAnalysisDays(link.id, history),
    loadExcludedDays(link.id, country, history),
  ]);
  const suspect = excluded.suspect;
  const lastYearRange = {
    from: addDays(monday, -LAST_YEAR_DAYS),
    to: addDays(sunday, -LAST_YEAR_DAYS),
  };
  const raw = (range: GaRange, reports: readonly GaWindowReport[]) =>
    loadGaWindowTables(link.id, range, { exclude: NOTHING, reports });
  const clean = (range: GaRange, reports: readonly GaWindowReport[]) =>
    loadGaWindowTables(link.id, range, { exclude: suspect, reports });
  const mondays = Array.from({ length: AUDIENCE_WEEKS }, (_, index) =>
    addDays(monday, -7 * (AUDIENCE_WEEKS - 1 - index)),
  );
  const monthStartDay = month ? `${month}-01` : null;
  const previousMonth = monthStartDay
    ? previousMonthStart(monthStartDay)
    : null;

  const [
    current,
    previous,
    lastYear,
    window28,
    window28Previous,
    weeks,
    monthCurrent,
    monthPrevious,
    siteSearch,
    degraded,
  ] = await Promise.all([
    raw({ from: monday, to: sunday }, RAW_WEEK_REPORTS),
    raw(
      { from: addDays(monday, -7), to: addDays(sunday, -7) },
      RAW_WEEK_REPORTS,
    ),
    covers(days, lastYearRange)
      ? raw(lastYearRange, RAW_WEEK_REPORTS)
      : Promise.resolve(null),
    clean({ from: addDays(sunday, -27), to: sunday }, WINDOW_REPORTS),
    clean(
      { from: addDays(sunday, -55), to: addDays(sunday, -28) },
      WINDOW_REPORTS,
    ),
    Promise.all(
      mondays.map((start) =>
        clean({ from: start, to: addDays(start, 6) }, AUDIENCE_REPORTS),
      ),
    ),
    monthStartDay
      ? raw({ from: monthStartDay, to: monthEnd(monthStartDay) }, MONTH_REPORTS)
      : Promise.resolve(null),
    previousMonth
      ? raw({ from: previousMonth, to: monthEnd(previousMonth) }, MONTH_REPORTS)
      : Promise.resolve(null),
    siteSearchWeeks(link.id, monday),
    measurementDegraded(link.id),
  ]);

  // GA-F6: AN13/AN14 girdisi. Bayrak kapalıyken sorgu yok ve `ads` anahtarı
  // hiç eklenmez. 28 günlük penceredeki "campaign" tablosunda reklam içeriği
  // boyutu yok, bu yüzden ayrı okunur.
  const ads = await loadAdsCrossCheckInput({
    link,
    window: { from: window28.from, to: window28.to },
    previousWindow: {
      from: window28Previous.from,
      to: window28Previous.to,
    },
    exclude: new Set([
      ...window28.excludedDays,
      ...window28Previous.excludedDays,
    ]),
  }).catch(() => null);

  return {
    linkId: link.id,
    today: todayOf(link, now),
    week,
    country,
    days,
    suspect,
    holidays: excluded.holidays,
    current,
    previous,
    lastYear,
    window28,
    window28Previous,
    weeks,
    month:
      month && monthCurrent && monthPrevious
        ? { month, current: monthCurrent, previous: monthPrevious }
        : null,
    siteSearch,
    currency: link.currencyCode,
    measurementDegraded: degraded,
    ...(ads ? { ads } : {}),
  };
}
