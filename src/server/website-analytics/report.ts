import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { finalThrough } from "@/lib/website-analytics/schedule";
import { GA_TOTALS_SCHEDULE } from "@/lib/website-analytics/catalog";
import { safeTimezone } from "@/lib/website-analytics/days";
import {
  resolveWebsitePeriod,
  type WebsitePeriod,
  type WebsitePeriodKey,
} from "@/lib/website-analytics/periods";
import { mergeQuality, qualityNotes } from "@/lib/website-analytics/response";
import {
  aggregateSlices,
  type GaStoredSlice,
} from "@/lib/website-analytics/slices";
import {
  engagementRate,
  engagementSecondsPerSession,
  revenue,
  sumTotals,
  type GaPeriodTotals,
} from "@/lib/website-analytics/totals";
import { dayKeyInTimezone } from "@/lib/timezone";

import {
  gaDataThrough,
  primaryGaLink,
  readDailyTotals,
  readRollingUsers,
  readSlices,
  type GaDayTotals,
} from "./store";

// "Website" sayfasının verisi (docs/google-analytics-plan.md §3.9, GA-F2 v1):
// karşılaştırmalı KPI'lar, günlük trend, kanallar, açılış sayfaları ve key
// event'ler; tazelik ve kalite notlarıyla. Yalnız ambardan okur.

export type WebsiteKpiFormat = "count" | "percent" | "duration" | "money";

export type WebsiteKpi = {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  format: WebsiteKpiFormat;
};

export type WebsiteTableColumn = { label: string; format: WebsiteKpiFormat };

export type WebsiteTable = {
  columns: WebsiteTableColumn[];
  rows: { label: string; values: (number | null)[] }[];
  // Gösterilmeyen satırların toplamı ("Other / not shown").
  other: (number | null)[] | null;
  notes: string[];
};

export type WebsiteTrendPoint = {
  day: string;
  sessions: number;
  keyEvents: number;
  isFinal: boolean;
};

export type WebsiteLinkInfo = {
  propertyId: string;
  propertyName: string | null;
  timeZone: string;
  currencyCode: string | null;
  streamUri: string | null;
  measurementId: string | null;
  health: string;
  healthReason: string | null;
  dataThrough: string | null;
  finalThrough: string | null;
  backfillDone: boolean;
};

export type WebsiteReport = {
  link: WebsiteLinkInfo;
  period: WebsitePeriod;
  coverage: { days: number; expected: number };
  kpis: WebsiteKpi[];
  trend: WebsiteTrendPoint[];
  previousTrend: number[];
  channels: WebsiteTable;
  landingPages: WebsiteTable;
  keyEvents: WebsiteTable;
  notes: string[];
};

const TOP_PAGES = 10;
const TOP_EVENTS = 10;

function linkInfo(
  link: GaPropertyLink,
  through: { through: string | null; finalThrough: string | null },
): WebsiteLinkInfo {
  return {
    propertyId: link.propertyId,
    propertyName: link.propertyName,
    timeZone: safeTimezone(link.timeZone),
    currencyCode: link.currencyCode,
    streamUri: link.streamUri,
    measurementId: link.measurementId,
    health: link.health,
    healthReason: link.healthReason,
    dataThrough: through.through,
    finalThrough: through.finalThrough,
    backfillDone: link.backfillDoneAt !== null,
  };
}

function kpis(
  current: GaPeriodTotals,
  previous: GaPeriodTotals,
  users: { current: number | null; previous: number | null },
): WebsiteKpi[] {
  const list: WebsiteKpi[] = [];
  if (users.current !== null) {
    list.push({
      key: "users",
      label: "Users",
      value: users.current,
      previous: users.previous,
      format: "count",
    });
  }
  list.push(
    {
      key: "sessions",
      label: "Sessions",
      value: current.sessions,
      previous: previous.sessions,
      format: "count",
    },
    {
      key: "newUsers",
      label: "New users",
      value: current.newUsers,
      previous: previous.newUsers,
      format: "count",
    },
    {
      key: "engagementRate",
      label: "Engagement rate",
      value: engagementRate(current),
      previous: engagementRate(previous),
      format: "percent",
    },
    {
      key: "engagementTime",
      label: "Avg. engagement time",
      value: engagementSecondsPerSession(current),
      previous: engagementSecondsPerSession(previous),
      format: "duration",
    },
    {
      key: "keyEvents",
      label: "Key events",
      value: current.keyEvents,
      previous: previous.keyEvents,
      format: "count",
    },
  );
  if (revenue(current) > 0 || revenue(previous) > 0) {
    list.push({
      key: "revenue",
      label: "Revenue",
      value: revenue(current),
      previous: revenue(previous),
      format: "money",
    });
  }
  return list;
}

function notesOf(slices: GaStoredSlice[]): string[] {
  return qualityNotes(mergeQuality(slices.map((slice) => slice.quality)));
}

function channelsTable(
  slices: GaStoredSlice[],
  totals: GaPeriodTotals,
): WebsiteTable {
  const rows = aggregateSlices(
    slices,
    ["sessionDefaultChannelGroup"],
    ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
  );
  const withRevenue = rows.some((row) => (row.values[3] ?? 0) > 0);
  return {
    columns: [
      { label: "Sessions", format: "count" },
      { label: "Share", format: "percent" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key events", format: "count" },
      ...(withRevenue ? [{ label: "Revenue", format: "money" as const }] : []),
    ],
    rows: rows.map((row) => {
      const [sessions = 0, engaged = 0, keyEvents = 0, money = 0] = row.values;
      return {
        label: row.key[0] || "(not set)",
        values: [
          sessions,
          totals.sessions > 0 ? (sessions / totals.sessions) * 100 : null,
          sessions > 0 ? (engaged / sessions) * 100 : null,
          keyEvents,
          ...(withRevenue ? [money] : []),
        ],
      };
    }),
    other: null,
    notes: notesOf(slices),
  };
}

function landingPagesTable(
  slices: GaStoredSlice[],
  totals: GaPeriodTotals,
): WebsiteTable {
  const rows = aggregateSlices(
    slices,
    ["landingPage"],
    ["sessions", "engagedSessions", "keyEvents"],
  );
  const shown = rows.slice(0, TOP_PAGES);
  const shownSessions = shown.reduce(
    (sum, row) => sum + (row.values[0] ?? 0),
    0,
  );
  const otherSessions = Math.max(0, totals.sessions - shownSessions);
  return {
    columns: [
      { label: "Sessions", format: "count" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key events", format: "count" },
    ],
    rows: shown.map((row) => {
      const [sessions = 0, engaged = 0, keyEvents = 0] = row.values;
      return {
        label: row.key[0] || "(not set)",
        values: [
          sessions,
          sessions > 0 ? (engaged / sessions) * 100 : null,
          keyEvents,
        ],
      };
    }),
    // Toplamdan gösterilenler çıkınca kalan: kırpılan ve (other) satırlar.
    other: otherSessions > 0 ? [otherSessions, null, null] : null,
    notes: notesOf(slices),
  };
}

function keyEventsTable(slices: GaStoredSlice[]): WebsiteTable {
  const rows = aggregateSlices(
    slices,
    ["eventName", "isKeyEvent"],
    ["keyEvents", "eventCount"],
  ).filter((row) => row.key[1] === "true");
  return {
    columns: [{ label: "Key events", format: "count" }],
    rows: rows.slice(0, TOP_EVENTS).map((row) => ({
      label: row.key[0] || "(not set)",
      values: [row.values[0] ?? 0],
    })),
    other: null,
    notes: notesOf(slices),
  };
}

function trend(rows: GaDayTotals[]): WebsiteTrendPoint[] {
  return rows.map((row) => ({
    day: row.day,
    sessions: row.sessions,
    keyEvents: row.keyEvents,
    isFinal: row.isFinal,
  }));
}

// Integrations diyaloğundaki mülk kartı ve "Data through …" satırı.
export async function readWebsiteLinkInfo(
  projectId: string,
): Promise<WebsiteLinkInfo | null> {
  const link = await primaryGaLink(projectId);
  if (!link) return null;
  return linkInfo(link, await gaDataThrough(link.id));
}

export type WebsiteReportState =
  | { state: "not_connected" }
  | { state: "waiting"; link: WebsiteLinkInfo }
  | { state: "ready"; report: WebsiteReport };

export async function buildWebsiteReport(
  projectId: string,
  periodKey: WebsitePeriodKey,
  now: Date = new Date(),
): Promise<WebsiteReportState> {
  const link = await primaryGaLink(projectId);
  if (!link) return { state: "not_connected" };
  const through = await gaDataThrough(link.id);
  const info = linkInfo(link, through);
  if (!through.through) return { state: "waiting", link: info };

  const today = dayKeyInTimezone(now, info.timeZone);
  const period = resolveWebsitePeriod(periodKey, today);
  const [currentRows, previousRows, channel, landing, events] =
    await Promise.all([
      readDailyTotals(link.id, period.from, period.to),
      readDailyTotals(link.id, period.previous.from, period.previous.to),
      readSlices(link.id, "channel", period.from, period.to),
      readSlices(link.id, "landing_page", period.from, period.to),
      readSlices(link.id, "events", period.from, period.to),
    ]);
  const current = sumTotals(currentRows);
  const previous = sumTotals(previousRows);

  let users = {
    current: null as number | null,
    previous: null as number | null,
  };
  if (period.rollingWindow) {
    const window = period.rollingWindow;
    const [rollingNow, rollingBefore] = await Promise.all([
      readRollingUsers(link.id, period.to),
      readRollingUsers(link.id, period.previous.to),
    ]);
    users = {
      current: rollingNow?.[window]?.activeUsers ?? null,
      previous: rollingBefore?.[window]?.activeUsers ?? null,
    };
  }

  const notes: string[] = [];
  const lastFinal = finalThrough(today, GA_TOTALS_SCHEDULE.revisionDays);
  if (period.to > lastFinal) {
    notes.push("The last 7 days may still change as Google finalizes them.");
  }
  if (currentRows.length < period.days) {
    notes.push(
      info.backfillDone
        ? "Some days in this period have no data."
        : "Older data is still loading from Google Analytics.",
    );
  }

  return {
    state: "ready",
    report: {
      link: info,
      period,
      coverage: { days: currentRows.length, expected: period.days },
      kpis: kpis(current, previous, users),
      trend: trend(currentRows),
      previousTrend: previousRows.map((row) => row.sessions),
      channels: channelsTable(channel, current),
      landingPages: landingPagesTable(landing, current),
      keyEvents: keyEventsTable(events),
      notes,
    },
  };
}
