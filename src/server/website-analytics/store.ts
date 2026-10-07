import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ROLLING_USERS_KEY,
  ROLLING_WINDOWS,
  type RollingWindow,
} from "@/lib/website-analytics/catalog";
import { dateToDayKey, dayKeyToDate } from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import type { GaQuality } from "@/lib/website-analytics/response";
import type { GaSliceRow, GaStoredSlice } from "@/lib/website-analytics/slices";
import type { GaTotalsRow } from "@/lib/website-analytics/totals";
import {
  planSliceSources,
  type GaSlicePlan,
} from "@/lib/website-analytics/weekly";
import { isoWeekMonday } from "@/lib/website-analytics/weeks";
import { selectedGaLinkFor } from "@/server/website-analytics/agency/selected-link";

export { sumTotals } from "@/lib/website-analytics/totals";

// Ambarın tek okuma kapısı (docs/google-analytics-plan.md §3.3 "Okuyucuların
// ambara geçişi"): Website sayfası, Analytics modülü, ANALYTICS_ANALYSIS
// görevi, tarayıcı ve sohbet buradan okur. Google'a çağrı yapmaz.

export type GaDayTotals = GaTotalsRow & { day: string; isFinal: boolean };

export type RollingUsers = Record<
  RollingWindow,
  { activeUsers: number; newUsers: number; totalUsers: number }
>;

export async function primaryGaLink(
  projectId: string,
): Promise<GaPropertyLink | null> {
  // GA-F8: Website sayfası bir ek mülk seçtiyse okuyucular onu görür; kapsam
  // yoksa sorgu bugünküyle aynı.
  const selected = selectedGaLinkFor(projectId);
  if (selected) return selected;
  return prisma.gaPropertyLink.findFirst({
    where: { projectId, isPrimary: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function readDailyTotals(
  linkId: string,
  from: string,
  to: string,
): Promise<GaDayTotals[]> {
  const rows = await prisma.gaDailyTotal.findMany({
    where: {
      linkId,
      date: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) },
    },
    orderBy: { date: "asc" },
  });
  return rows.map((row) => ({
    day: dateToDayKey(row.date),
    isFinal: row.isFinal,
    activeUsers: row.activeUsers,
    newUsers: row.newUsers,
    sessions: row.sessions,
    engagedSessions: row.engagedSessions,
    engagementSec: row.engagementSec,
    sessionDurationSec: row.sessionDurationSec,
    screenPageViews: row.screenPageViews,
    keyEvents: row.keyEvents,
    revenueMicros: row.revenueMicros,
    transactions: row.transactions,
  }));
}

type SliceRecord = {
  periodStart: Date;
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: unknown;
  truncated: boolean;
  otherRow: unknown;
  quality: unknown;
};

function storedSlice(row: SliceRecord): GaStoredSlice {
  return {
    day: dateToDayKey(row.periodStart),
    dimensionHeaders: row.dimensionHeaders,
    metricHeaders: row.metricHeaders,
    rows: (row.rows ?? []) as GaSliceRow[],
    truncated: row.truncated,
    otherRow: (row.otherRow ?? null) as number[] | null,
    quality: (row.quality ?? {}) as GaQuality,
  };
}

async function readGrain(
  linkId: string,
  reportKey: string,
  grain: "DAY" | "WEEK",
  from: string,
  to: string,
): Promise<GaStoredSlice[]> {
  const rows = await prisma.gaReportSlice.findMany({
    where: {
      linkId,
      reportKey,
      grain,
      periodStart: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) },
    },
    orderBy: { periodStart: "asc" },
  });
  return rows.map(storedSlice);
}

export async function readSlices(
  linkId: string,
  reportKey: string,
  from: string,
  to: string,
): Promise<GaStoredSlice[]> {
  return readGrain(linkId, reportKey, "DAY", from, to);
}

// Haftalık dilimler (grain WEEK); .day haftanın Pazartesi'sidir.
export async function readWeekSlices(
  linkId: string,
  reportKey: string,
  fromMonday: string,
  toMonday: string,
): Promise<GaStoredSlice[]> {
  return readGrain(linkId, reportKey, "WEEK", fromMonday, toMonday);
}

export type GaMergedSlices = { slices: GaStoredSlice[]; plan: GaSlicePlan };

// [from, to] için günler ve haftalar tek tabloda (planSliceSources: hiçbir
// gün iki kez sayılmaz). GA_WEEKLY kapalıyken yalnız günler okunur; plan
// eksik günleri yine söyler. Dönen dilimler zaman sırasındadır; WEEK
// dilimlerini plan.weeks'ten ayırt edin.
export async function readMergedSlices(
  linkId: string,
  reportKey: string,
  from: string,
  to: string,
  options: { edgeWeeks?: "exclude" | "majority" } = {},
): Promise<GaMergedSlices> {
  const weekly = GaFlags.weekly();
  const [days, weeks] = await Promise.all([
    readSlices(linkId, reportKey, from, to),
    weekly
      ? readWeekSlices(linkId, reportKey, isoWeekMonday(from), isoWeekMonday(to))
      : Promise.resolve([]),
  ]);
  const plan = planSliceSources({
    from,
    to,
    dayKeys: new Set(days.map((slice) => slice.day)),
    weekStarts: new Set(weeks.map((slice) => slice.day)),
    edgeWeeks: options.edgeWeeks ?? "exclude",
  });
  const chosenDays = new Set(plan.days);
  const chosenWeeks = new Set(plan.weeks);
  const slices = [
    ...days.filter((slice) => chosenDays.has(slice.day)),
    ...weeks.filter((slice) => chosenWeeks.has(slice.day)),
  ].sort((a, b) => a.day.localeCompare(b.day));
  return { slices, plan };
}

// Raporun en yeni WEEK dilimi (search_console penceresi); yoksa null.
export async function readLatestWindowSlice(
  linkId: string,
  reportKey: string,
): Promise<GaStoredSlice | null> {
  const row = await prisma.gaReportSlice.findFirst({
    where: { linkId, reportKey, grain: "WEEK" },
    orderBy: { periodStart: "desc" },
  });
  return row ? storedSlice(row) : null;
}

// `end`'de biten 7/28/90 günlük tekil kullanıcılar; o gün için yoksa null.
export async function readRollingUsers(
  linkId: string,
  end: string,
): Promise<RollingUsers | null> {
  const slice = await prisma.gaReportSlice.findUnique({
    where: {
      linkId_reportKey_grain_periodStart: {
        linkId,
        reportKey: ROLLING_USERS_KEY,
        grain: "DAY",
        periodStart: dayKeyToDate(end),
      },
    },
  });
  if (!slice) return null;
  const rows = (slice.rows ?? []) as GaSliceRow[];
  const metric = (row: GaSliceRow, name: string) => {
    const index = slice.metricHeaders.indexOf(name);
    return index < 0 ? 0 : Number(row[1 + index] ?? 0);
  };
  const result = {} as RollingUsers;
  for (const window of ROLLING_WINDOWS) {
    const row = rows.find((candidate) => candidate[0] === `d${window}`);
    result[window] = {
      activeUsers: row ? metric(row, "activeUsers") : 0,
      newUsers: row ? metric(row, "newUsers") : 0,
      totalUsers: row ? metric(row, "totalUsers") : 0,
    };
  }
  return result;
}

// Ambarın kapsadığı son gün ve kesinleşen son gün.
export async function gaDataThrough(
  linkId: string,
): Promise<{ through: string | null; finalThrough: string | null }> {
  const [latest, latestFinal] = await Promise.all([
    prisma.gaDailyTotal.findFirst({
      where: { linkId },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    prisma.gaDailyTotal.findFirst({
      where: { linkId, isFinal: true },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
  ]);
  return {
    through: latest ? dateToDayKey(latest.date) : null,
    finalThrough: latestFinal ? dateToDayKey(latestFinal.date) : null,
  };
}
