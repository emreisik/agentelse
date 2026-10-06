import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  GA_TOTALS_SCHEDULE,
  monthlyUsersRequest,
} from "@/lib/website-analytics/catalog";
import {
  dateToDayKey,
  dayKeyToDate,
  daysInRange,
  monthEnd,
  monthStart,
  previousMonthStart,
} from "@/lib/website-analytics/days";
import { dimensionOf, metricOf } from "@/lib/website-analytics/response";
import { finalThrough } from "@/lib/website-analytics/schedule";
import { aggregateSlices } from "@/lib/website-analytics/slices";

import type { GaSyncContext } from "./context";
import { GaQuotaDeferred, runGaRequests } from "./requests";
import { readSlices, sumTotals } from "../store";

// Ay özetleri (GaMonthlySummary; docs/google-analytics-plan.md §4): uzun dönem
// eğilimi ve geçen yılla karşılaştırma için. Yalnız bütün günleri kesinleşmiş
// (atıf penceresi dahil) ve günlük toplamları eksiksiz aylar özetlenir.
// Toplanabilir metrikler günlüklerden, tekil kullanıcılar ay başına tek
// tarih aralığıyla (4 ay tek istekte) Google'dan gelir.

const MONTHS_BACK = 13;
const ATTRIBUTION_WINDOW = 13;
const TOP_PAGES = 50;

function monthsToSummarize(lastFinal: string): string[] {
  const months: string[] = [];
  let month = monthStart(lastFinal);
  if (monthEnd(month) > lastFinal) month = previousMonthStart(month);
  for (let index = 0; index < MONTHS_BACK; index += 1) {
    months.push(month);
    month = previousMonthStart(month);
  }
  return months;
}

export async function syncMonthly(ctx: GaSyncContext): Promise<number> {
  const lastFinal = finalThrough(
    ctx.today,
    Math.max(ATTRIBUTION_WINDOW, GA_TOTALS_SCHEDULE.revisionDays),
  );
  const done = new Set(
    (
      await prisma.gaMonthlySummary.findMany({
        where: { linkId: ctx.link.id, isFinal: true },
        select: { month: true },
      })
    ).map((row) => dateToDayKey(row.month)),
  );

  const candidates: { start: string; end: string }[] = [];
  for (const start of monthsToSummarize(lastFinal)) {
    if (done.has(start)) continue;
    const end = monthEnd(start);
    const days = await prisma.gaDailyTotal.count({
      where: {
        linkId: ctx.link.id,
        date: { gte: dayKeyToDate(start), lte: dayKeyToDate(end) },
      },
    });
    // Geri doldurma o aya henüz ulaşmadı.
    if (days < daysInRange(start, end)) continue;
    candidates.push({ start, end });
    if (candidates.length === 4) break;
  }
  if (candidates.length === 0) return 0;

  let users: Map<string, Record<string, number>>;
  try {
    const [outcome] = await runGaRequests(ctx, [
      monthlyUsersRequest(candidates),
    ]);
    if (!outcome?.ok) return 0;
    users = new Map(
      outcome.report.rows.map((row) => [
        dimensionOf(outcome.report, row, "dateRange") ?? "",
        {
          activeUsers: metricOf(outcome.report, row, "activeUsers"),
          newUsers: metricOf(outcome.report, row, "newUsers"),
          totalUsers: metricOf(outcome.report, row, "totalUsers"),
        },
      ]),
    );
  } catch (error) {
    // Kota payı yoksa ay özetleri bir sonraki tura kalır.
    if (error instanceof GaQuotaDeferred) return 0;
    throw error;
  }

  for (const month of candidates) {
    const rows = await prisma.gaDailyTotal.findMany({
      where: {
        linkId: ctx.link.id,
        date: { gte: dayKeyToDate(month.start), lte: dayKeyToDate(month.end) },
      },
    });
    const totals = sumTotals(rows);
    const channels = aggregateSlices(
      await readSlices(ctx.link.id, "channel", month.start, month.end),
      ["sessionDefaultChannelGroup"],
      ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
    );
    const pages = aggregateSlices(
      await readSlices(ctx.link.id, "landing_page", month.start, month.end),
      ["landingPage"],
      ["sessions", "engagedSessions", "keyEvents"],
    ).slice(0, TOP_PAGES);
    const monthUsers = users.get(`m${month.start.slice(0, 7)}`) ?? {};
    const data = {
      totals: {
        ...totals,
        revenueMicros: totals.revenueMicros.toString(),
        ...monthUsers,
        days: rows.length,
      } as Prisma.InputJsonValue,
      channels: channels as unknown as Prisma.InputJsonValue,
      topPages: pages as unknown as Prisma.InputJsonValue,
      isFinal: true,
    };
    await prisma.gaMonthlySummary.upsert({
      where: {
        linkId_month: { linkId: ctx.link.id, month: dayKeyToDate(month.start) },
      },
      create: {
        linkId: ctx.link.id,
        projectId: ctx.link.projectId,
        month: dayKeyToDate(month.start),
        ...data,
      },
      update: data,
    });
  }
  return candidates.length;
}
