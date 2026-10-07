import "server-only";

import { randomUUID } from "node:crypto";

import type { GaBigQuerySource, GaPropertyLink, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { gaBigQueryEnabledFor } from "@/lib/website-analytics/agency/flags";
import {
  firstOfNextMonth,
  maxBytesCap,
  monthBudgetState,
  monthKeyOf,
  monthlyBudgetBytes,
  sumBytes,
} from "@/lib/website-analytics/bigquery/budget";
import {
  defaultExportDataset,
  keyEventNamesOf,
} from "@/lib/website-analytics/bigquery/config";
import {
  gaBigQueryErrorOf,
  type GaBigQueryErrorCode,
} from "@/lib/website-analytics/bigquery/errors";
import {
  cellToInt,
  cellToString,
  rowsToRecords,
} from "@/lib/website-analytics/bigquery/rows";
import {
  buildGaStatements,
  exportRangeDays,
  planChunks,
  splitDayRange,
  type GaBqStatements,
} from "@/lib/website-analytics/bigquery/sql";
import {
  addDays,
  dayKeyToDate,
  safeTimezone,
} from "@/lib/website-analytics/days";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import {
  BigQueryError,
  type BigQueryClient,
  type BqQueryResult,
} from "@/server/integrations/google/bigquery";
import { containsGooglePii, maskGooglePath } from "@/server/integrations/google/pii";

import { prepareGaBigQueryClient, type GaBigQueryDeps } from "./verify";

export type { GaBigQueryDeps } from "./verify";

// GA4 BigQuery dışa aktarım okuyucusu (GA-F8, docs/website-agency.md). Kaynak başına
// 5 dakikalık CAS kilidi altında, kaynağın günlük toplamlarını GaBigQueryDay'e yazar.
// Yalnız günlük toplamlar saklanır (ham satır yok). BÜTÇE: günlük + olaylar + sayfalar
// üç ayrı tarama sayılır (event_params en ağır sütun, günlük ve sayfa ifadeleri onu
// ayrı ayrı okur); tahmin ve aylık bütçe üç kuru çalıştırmanın TOPLAMIdır. Tek
// taramalı yeniden yazım belgelenmiş sonraki adımdır. Loga ve lastError'a yalnız
// kısa kod ya da hata adı girer.

const LEASE_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const JITTER_MS = 30 * 60_000;
const FIRST_RUN_DAYS = 28;
const RETENTION_DAYS = 400;
const INT_MAX = 2_147_483_647;
const OVERLAP_DAYS = 2;

type SourceWithLink = GaBigQuerySource & { link: GaPropertyLink };
type SyncResult = "synced" | "skipped" | "error";

function clampInt(value: number): number {
  return Math.max(0, Math.min(INT_MAX, value));
}

function compactToDayKey(compact: string | null): string | null {
  if (!compact || !/^\d{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function retryAfterMs(code: GaBigQueryErrorCode): number {
  return code === "quota" || code === "unavailable" ? HOUR_MS : 6 * HOUR_MS;
}

type DayRow = {
  events: number;
  users: number;
  sessions: number;
  keyEvents: number;
  revenueMicros: number;
  topEvents: [string, number][];
  topPages: [string, number, number][];
};

// Üç sonuç matrisini gün bazında birleştirir (hiçbir ham sayfa yolu saklanmaz).
export function assembleDays(results: {
  daily: BqQueryResult;
  events: BqQueryResult;
  pages: BqQueryResult;
}): Map<string, DayRow> {
  const days = new Map<string, DayRow>();
  for (const record of rowsToRecords(results.daily.columns, results.daily.rows)) {
    const day = compactToDayKey(cellToString(record.day));
    if (!day) continue;
    days.set(day, {
      events: clampInt(cellToInt(record.events)),
      users: clampInt(cellToInt(record.users)),
      sessions: clampInt(cellToInt(record.sessions)),
      keyEvents: clampInt(cellToInt(record.key_events)),
      // Tamsayı güvenli değilse 0 (yalnız bilgi amaçlı).
      revenueMicros: Number.isSafeInteger(cellToInt(record.revenue_micros))
        ? cellToInt(record.revenue_micros)
        : 0,
      topEvents: [],
      topPages: [],
    });
  }
  for (const record of rowsToRecords(results.events.columns, results.events.rows)) {
    const row = days.get(compactToDayKey(cellToString(record.day)) ?? "");
    const name = cellToString(record.event_name);
    if (!row || !name) continue;
    row.topEvents.push([name.slice(0, 80), clampInt(cellToInt(record.events))]);
  }
  for (const record of rowsToRecords(results.pages.columns, results.pages.rows)) {
    const row = days.get(compactToDayKey(cellToString(record.day)) ?? "");
    const raw = cellToString(record.path);
    if (!row || !raw) continue;
    // Kişisel veri taşıyan yollar atılır; kalanlar maskelenir ve birleştirilir.
    if (containsGooglePii(raw)) continue;
    const path = maskGooglePath(raw);
    if (!path) continue;
    const views = clampInt(cellToInt(record.views));
    const users = clampInt(cellToInt(record.users));
    const existing = row.topPages.find((page) => page[0] === path);
    if (existing) {
      existing[1] += views;
      existing[2] += users;
    } else {
      row.topPages.push([path, views, users]);
    }
  }
  return days;
}

async function writeDays(
  source: SourceWithLink,
  days: Map<string, DayRow>,
  now: Date,
): Promise<string | null> {
  if (days.size === 0) return null;
  const operations = [...days.entries()].map(([day, row]) => {
    const data = {
      events: row.events,
      users: row.users,
      sessions: row.sessions,
      keyEvents: row.keyEvents,
      revenueMicros: BigInt(row.revenueMicros),
      topEvents: row.topEvents as Prisma.InputJsonValue,
      topPages: row.topPages as Prisma.InputJsonValue,
      computedAt: now,
    };
    return prisma.gaBigQueryDay.upsert({
      where: {
        linkId_date: { linkId: source.linkId, date: dayKeyToDate(day) },
      },
      create: {
        workspaceId: source.workspaceId,
        projectId: source.projectId,
        linkId: source.linkId,
        date: dayKeyToDate(day),
        ...data,
      },
      update: data,
    });
  });
  await prisma.$transaction(operations);
  return [...days.keys()].sort().at(-1) ?? null;
}

async function finish(
  source: SourceWithLink,
  owner: string,
  data: Prisma.GaBigQuerySourceUpdateManyMutationInput,
): Promise<void> {
  await prisma.gaBigQuerySource.updateMany({
    where: { id: source.id, leaseOwner: owner },
    data: { ...data, leaseUntil: null, leaseOwner: null },
  });
}

async function run(
  source: SourceWithLink,
  owner: string,
  now: Date,
  deps: GaBigQueryDeps,
): Promise<SyncResult> {
  const link = source.link;
  const month = monthKeyOf(now);
  const baseUsed =
    source.usageMonth === month ? Number(source.usageBytes) : 0;
  let usage = 0;
  let lastDay = source.lastDay;

  const usageData = () => ({
    usageMonth: month,
    usageBytes: BigInt(Math.max(0, Math.round(baseUsed + usage))),
  });
  const fail = async (code: GaBigQueryErrorCode): Promise<SyncResult> => {
    await finish(source, owner, {
      status: "ERROR",
      lastError: code,
      nextRunAt: new Date(now.getTime() + retryAfterMs(code)),
      lastDay,
      ...usageData(),
    });
    return "error";
  };

  // Bağlama kuralı her çalıştırmada yeniden doğrulanır: sorgu hiç gitmez.
  if (source.datasetId !== defaultExportDataset(link.propertyId)) {
    return fail("invalid_query");
  }

  const client: BigQueryClient = prepareGaBigQueryClient(deps);
  if (!client.configured()) return fail("not_configured");

  // Aralık: son okunan günden 2 gün geri (geç gelen veri), en çok 28 gün önce,
  // mülk oluşturulmadan önce değil; dün (mülk saat diliminde) dahil.
  const timeZone = safeTimezone(link.timeZone);
  const today = dayKeyInTimezone(now, timeZone);
  const toDay = addDays(today, -1);
  let fromDay = lastDay
    ? addDays(lastDay, -OVERLAP_DAYS)
    : addDays(today, -FIRST_RUN_DAYS);
  const floor = addDays(today, -FIRST_RUN_DAYS);
  if (fromDay < floor) fromDay = floor;
  if (link.propertyCreatedAt) {
    const created = dayKeyInTimezone(link.propertyCreatedAt, timeZone);
    if (fromDay < created) fromDay = created;
  }

  const jitter = Math.floor(Math.random() * JITTER_MS);
  const nextDaily = () => new Date(now.getTime() + DAY_MS + jitter);

  if (fromDay > toDay) {
    await finish(source, owner, {
      status: "OK",
      lastError: null,
      lastRunAt: now,
      nextRunAt: nextDaily(),
      ...usageData(),
    });
    return "skipped";
  }

  const keyEventNames = keyEventNamesOf(link.keyEvents);
  const ref = { projectId: source.gcpProjectId, datasetId: source.datasetId };
  const whole = buildGaStatements(ref, { fromDay, toDay, keyEventNames });
  if (!whole) return fail("invalid_query");

  const cap = maxBytesCap();
  const dryRun = (statements: GaBqStatements) =>
    Promise.all(
      [statements.daily, statements.events, statements.pages].map(
        (statement) =>
          client.dryRun({
            purpose: statement.purpose,
            projectId: source.gcpProjectId,
            location: source.location,
            sql: statement.sql,
            params: statement.params,
            maxBytesBilled: cap,
            maxRows: statement.maxRows,
          }),
      ),
    );

  try {
    // Tahmin = üç kuru çalıştırmanın TOPLAMI.
    const estimate = sumBytes(
      (await dryRun(whole)).map((result) => result.bytesProcessed),
    );
    const budget = monthBudgetState({
      usageMonth: source.usageMonth,
      usageBytes: baseUsed,
      monthlyBytes: monthlyBudgetBytes(),
      estimateBytes: estimate,
      now,
    });
    if (!budget.allowed) {
      // Durum OK kalır; bir sonraki ayın başına kadar okunmaz.
      await finish(source, owner, {
        status: "OK",
        lastError: "budget",
        nextRunAt: firstOfNextMonth(now),
        ...usageData(),
      });
      return "skipped";
    }

    const chunks = planChunks({
      days: exportRangeDays(fromDay, toDay),
      estimatedBytes: estimate,
      capBytes: cap,
    });
    for (const part of splitDayRange(fromDay, toDay, chunks)) {
      const statements = buildGaStatements(ref, {
        fromDay: part.fromDay,
        toDay: part.toDay,
        keyEventNames,
      });
      if (!statements) return fail("invalid_query");
      const run1 = (statement: GaBqStatements["daily"]) =>
        client.query({
          purpose: statement.purpose,
          projectId: source.gcpProjectId,
          location: source.location,
          sql: statement.sql,
          params: statement.params,
          maxBytesBilled: cap,
          maxRows: statement.maxRows,
        });
      const daily = await run1(statements.daily);
      const events = await run1(statements.events);
      const pages = await run1(statements.pages);
      usage += sumBytes(
        [daily, events, pages].map(
          (result) => result.bytesBilled ?? result.bytesProcessed,
        ),
      );
      // Kesilmiş sonuç eksik toplam demektir: bu parça için hiçbir şey yazılmaz.
      if (daily.truncated || events.truncated || pages.truncated) {
        return fail("invalid_query");
      }
      const written = await writeDays(
        source,
        assembleDays({ daily, events, pages }),
        now,
      );
      if (written && (!lastDay || written > lastDay)) lastDay = written;
    }
  } catch (error) {
    if (error instanceof BigQueryError) {
      return fail(gaBigQueryErrorOf(error.code));
    }
    console.error(
      "[ga-bigquery] sync failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return fail("unavailable");
  }

  await finish(source, owner, {
    status: "OK",
    lastError: null,
    lastDay,
    lastRunAt: now,
    nextRunAt: nextDaily(),
    ...usageData(),
  });
  return "synced";
}

export const GaBigQuery = {
  // Tek kaynak: kilit kaynağın kendi satırındadır (CAS). Hiç fırlatmaz.
  async syncSource(
    sourceId: string,
    now: Date,
    deps: GaBigQueryDeps = {},
  ): Promise<SyncResult> {
    let owner: string | null = null;
    try {
      const source = await prisma.gaBigQuerySource.findUnique({
        where: { id: sourceId },
        include: { link: true },
      });
      if (!source) return "skipped";
      if (!gaBigQueryEnabledFor(source.projectId)) return "skipped";
      if (!source.link.isPrimary && !source.link.isSecondary) return "skipped";
      const candidate = `ga-bq:${process.pid}:${randomUUID()}`;
      const claimed = await prisma.gaBigQuerySource.updateMany({
        where: {
          id: source.id,
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        },
        data: {
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          leaseOwner: candidate,
        },
      });
      if (claimed.count !== 1) return "skipped";
      owner = candidate;
      return await run(source, candidate, now, deps);
    } catch (error) {
      console.error(
        "[ga-bigquery] source failed:",
        error instanceof Error ? error.name : "unknown",
      );
      return "error";
    } finally {
      if (owner) {
        await prisma.gaBigQuerySource
          .updateMany({
            where: { id: sourceId, leaseOwner: owner },
            data: { leaseUntil: null, leaseOwner: null },
          })
          .catch(() => undefined);
      }
    }
  },

  // 400 günden eski günlük toplamları siler. Yalnız genel süreçte çalışır
  // (yerel geliştirme canlı veritabanını paylaşırken hiç sorgu yapmaz).
  async retention(now: Date = new Date()): Promise<number> {
    if (!gaGlobalWorkAllowedHere()) return 0;
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const result = await prisma.gaBigQueryDay.deleteMany({
      where: { date: { lt: cutoff } },
    });
    return result.count;
  },
};
