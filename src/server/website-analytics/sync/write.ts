import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ROLLING_USERS_KEY,
  type GaReportSpec,
} from "@/lib/website-analytics/catalog";
import { addDays, daysInRange, gaDateKey } from "@/lib/website-analytics/days";
import {
  dimensionOf,
  metricOf,
  type GaParsedReport,
  type GaQuality,
} from "@/lib/website-analytics/response";
import { splitReportByDay } from "@/lib/website-analytics/slices";

import type { GaSyncContext } from "./context";

// Ambara yazım (docs/google-analytics-plan.md §3.3): günlük toplamlar ve
// rapor dilimleri tek ifadeli toplu upsert ile (geri doldurmada yüzlerce
// satır tek gidiş-dönüşte). Aynı gün yeniden çekilince (revizyon) üzerine
// yazılır.

const ROWS_PER_STATEMENT = 200;

export function dayList(start: string, end: string): string[] {
  return Array.from({ length: daysInRange(start, end) }, (_, index) =>
    addDays(start, index),
  );
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

type TotalsRow = {
  day: string;
  activeUsers: number;
  newUsers: number;
  sessions: number;
  engagedSessions: number;
  engagementSec: number;
  sessionDurationSec: number;
  screenPageViews: number;
  keyEvents: number;
  revenueMicros: bigint;
  transactions: number;
};

function totalsRow(report: GaParsedReport, day: string): TotalsRow {
  const row = report.rows.find(
    (candidate) => gaDateKey(dimensionOf(report, candidate, "date")) === day,
  );
  const metric = (name: string) => (row ? metricOf(report, row, name) : 0);
  const sessions = Math.round(metric("sessions"));
  return {
    day,
    activeUsers: Math.round(metric("activeUsers")),
    newUsers: Math.round(metric("newUsers")),
    sessions,
    engagedSessions: Math.round(metric("engagedSessions")),
    engagementSec: metric("userEngagementDuration"),
    sessionDurationSec: metric("averageSessionDuration") * sessions,
    screenPageViews: Math.round(metric("screenPageViews")),
    keyEvents: metric("keyEvents"),
    revenueMicros: BigInt(Math.round(metric("totalRevenue") * 1_000_000)),
    transactions: Math.round(metric("transactions")),
  };
}

// [start, end] günlerinin toplamlarını yazar. Satırı gelmeyen gün trafik
// yok demektir ve sıfırla yazılır. Günlük çekimde `end` dündür (`pendingEnd`):
// satırı yoksa Google onu henüz işlememiştir ve yazılmaz. Dönüş: `end`'in
// verisi geldi mi.
export async function writeTotals(
  ctx: GaSyncContext,
  report: GaParsedReport,
  range: {
    start: string;
    end: string;
    finalThrough: string;
    pendingEnd: boolean;
  },
): Promise<boolean> {
  const present = new Set(
    report.rows
      .map((row) => gaDateKey(dimensionOf(report, row, "date")))
      .filter((day): day is string => day !== null),
  );
  const endIn = present.has(range.end);
  const days = dayList(range.start, range.end).filter(
    (day) => day !== range.end || endIn || !range.pendingEnd,
  );
  const quality: GaQuality = report.quality;
  const fetchedAt = new Date();
  for (const part of chunks(days, ROWS_PER_STATEMENT)) {
    const values = part.map((day) => {
      const row = totalsRow(report, day);
      return Prisma.sql`(${randomUUID()}, ${ctx.link.id}, ${ctx.link.projectId}, ${day}::date, ${row.activeUsers}::int, ${row.newUsers}::int, ${row.sessions}::int, ${row.engagedSessions}::int, ${row.engagementSec}::double precision, ${row.sessionDurationSec}::double precision, ${row.screenPageViews}::int, ${row.keyEvents}::double precision, ${row.revenueMicros}::bigint, ${row.transactions}::int, ${json(quality)}::jsonb, ${day <= range.finalThrough}, ${fetchedAt})`;
    });
    await prisma.$executeRaw`
      INSERT INTO "GaDailyTotal" ("id", "linkId", "projectId", "date", "activeUsers", "newUsers", "sessions", "engagedSessions", "engagementSec", "sessionDurationSec", "screenPageViews", "keyEvents", "revenueMicros", "transactions", "quality", "isFinal", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("linkId", "date") DO UPDATE SET
        "activeUsers" = EXCLUDED."activeUsers",
        "newUsers" = EXCLUDED."newUsers",
        "sessions" = EXCLUDED."sessions",
        "engagedSessions" = EXCLUDED."engagedSessions",
        "engagementSec" = EXCLUDED."engagementSec",
        "sessionDurationSec" = EXCLUDED."sessionDurationSec",
        "screenPageViews" = EXCLUDED."screenPageViews",
        "keyEvents" = EXCLUDED."keyEvents",
        "revenueMicros" = EXCLUDED."revenueMicros",
        "transactions" = EXCLUDED."transactions",
        "quality" = EXCLUDED."quality",
        "isFinal" = EXCLUDED."isFinal",
        "fetchedAt" = EXCLUDED."fetchedAt"
    `;
  }
  return endIn;
}

type SliceInput = {
  reportKey: string;
  specVersion: number;
  day: string;
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: unknown;
  rowCount: number;
  truncated: boolean;
  otherRow: unknown;
  quality: GaQuality;
  isFinal: boolean;
};

async function upsertSlices(
  ctx: GaSyncContext,
  slices: SliceInput[],
): Promise<void> {
  const fetchedAt = new Date();
  for (const part of chunks(slices, ROWS_PER_STATEMENT)) {
    const values = part.map(
      (slice) =>
        Prisma.sql`(${randomUUID()}, ${ctx.link.id}, ${ctx.link.projectId}, ${slice.reportKey}, 'DAY', ${slice.day}::date, ${slice.specVersion}::int, ${slice.dimensionHeaders}::text[], ${slice.metricHeaders}::text[], ${json(slice.rows)}::jsonb, ${slice.rowCount}::int, ${slice.truncated}, ${slice.otherRow === null ? null : json(slice.otherRow)}::jsonb, ${json(slice.quality)}::jsonb, ${slice.isFinal}, ${fetchedAt})`,
    );
    await prisma.$executeRaw`
      INSERT INTO "GaReportSlice" ("id", "linkId", "projectId", "reportKey", "grain", "periodStart", "specVersion", "dimensionHeaders", "metricHeaders", "rows", "rowCount", "truncated", "otherRow", "quality", "isFinal", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("linkId", "reportKey", "grain", "periodStart") DO UPDATE SET
        "specVersion" = EXCLUDED."specVersion",
        "dimensionHeaders" = EXCLUDED."dimensionHeaders",
        "metricHeaders" = EXCLUDED."metricHeaders",
        "rows" = EXCLUDED."rows",
        "rowCount" = EXCLUDED."rowCount",
        "truncated" = EXCLUDED."truncated",
        "otherRow" = EXCLUDED."otherRow",
        "quality" = EXCLUDED."quality",
        "isFinal" = EXCLUDED."isFinal",
        "fetchedAt" = EXCLUDED."fetchedAt"
    `;
  }
}

// Raporu `days` günlerinin dilimlerine böler ve yazar.
export async function writeSlices(
  ctx: GaSyncContext,
  spec: GaReportSpec,
  report: GaParsedReport,
  days: string[],
  finalThrough: string,
): Promise<void> {
  if (days.length === 0) return;
  const slices = splitReportByDay(report, spec, days).map((slice) => ({
    reportKey: spec.key,
    specVersion: spec.version,
    day: slice.day,
    dimensionHeaders: slice.dimensionHeaders,
    metricHeaders: slice.metricHeaders,
    rows: slice.rows,
    rowCount: slice.rowCount,
    truncated: slice.truncated,
    otherRow: slice.otherRow,
    quality: {
      ...report.quality,
      ...(slice.truncated ? { truncated: true } : {}),
    },
    isFinal: slice.day <= finalThrough,
  }));
  await upsertSlices(ctx, slices);
}

// Kayan pencere kullanıcıları (7/28/90 gün, `end`'de biten).
export async function writeRollingUsers(
  ctx: GaSyncContext,
  report: GaParsedReport,
  end: string,
): Promise<void> {
  const rows = report.rows.map((row) => [
    dimensionOf(report, row, "dateRange") ?? "",
    ...row.metrics,
  ]);
  await upsertSlices(ctx, [
    {
      reportKey: ROLLING_USERS_KEY,
      specVersion: 1,
      day: end,
      dimensionHeaders: ["window"],
      metricHeaders: report.metricHeaders,
      rows,
      rowCount: rows.length,
      truncated: false,
      otherRow: null,
      quality: report.quality,
      isFinal: false,
    },
  ]);
}
