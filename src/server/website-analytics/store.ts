import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ROLLING_USERS_KEY,
  ROLLING_WINDOWS,
  type RollingWindow,
} from "@/lib/website-analytics/catalog";
import { dateToDayKey, dayKeyToDate } from "@/lib/website-analytics/days";
import type { GaQuality } from "@/lib/website-analytics/response";
import type { GaSliceRow, GaStoredSlice } from "@/lib/website-analytics/slices";
import type { GaTotalsRow } from "@/lib/website-analytics/totals";

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

export async function readSlices(
  linkId: string,
  reportKey: string,
  from: string,
  to: string,
): Promise<GaStoredSlice[]> {
  const rows = await prisma.gaReportSlice.findMany({
    where: {
      linkId,
      reportKey,
      grain: "DAY",
      periodStart: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) },
    },
    orderBy: { periodStart: "asc" },
  });
  return rows.map((row) => ({
    day: dateToDayKey(row.periodStart),
    dimensionHeaders: row.dimensionHeaders,
    metricHeaders: row.metricHeaders,
    rows: (row.rows ?? []) as GaSliceRow[],
    truncated: row.truncated,
    otherRow: (row.otherRow ?? null) as number[] | null,
    quality: (row.quality ?? {}) as GaQuality,
  }));
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
