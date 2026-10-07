import "server-only";

import type { GscBqSource, GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { BqSourceErrorCode } from "@/lib/seo/agency/bq/copy";
import {
  currentUsageMonth,
  recordSpend,
  type BqUsage,
} from "@/lib/seo/agency/bq/cost";
import {
  hardMaxBytes,
  hardMonthlyBytes,
} from "@/lib/seo/agency/bq/limits";
import {
  bqPeriodKey,
  planBqPeriods,
  type BqFetchState,
} from "@/lib/seo/agency/bq/plan";
import { normalizeSiteUrl } from "@/lib/seo/agency/bq/rows";
import { gscBigQueryActiveFor, gscBigQueryOn } from "@/lib/seo/agency/flags";
import type { BqBadge } from "@/lib/seo/agency/types";
import { addDays, dateToDayKey, dayKeyToDate, gscToday } from "@/lib/seo/dates";
import { gscRestrictedProjects, gscSyncAllowedFor } from "@/lib/seo/flags";
import { quotaStateOf } from "@/lib/seo/governor";
import { GSC_SYNC_LEASE_MS } from "@/lib/seo/schedule";
import {
  BigQueryError,
  bigQueryClient,
  classifyBigQueryError,
  type BigQueryClient,
} from "@/server/integrations/google/bigquery";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import {
  GscPageGroups,
  pageGroupRulesForLink,
} from "@/server/seo/agency/page-groups";
import { brandContextForLink } from "@/server/seo/brand-terms";
import { parseSearchTypes, type GscSyncContext } from "@/server/seo/sync/context";
import { writePeriod } from "@/server/seo/sync/write";

import { readBqPeriod } from "./reader";
import { addBqUsage, bqOwnershipHolds, usageOf } from "./source";
import { readBqCoverage, type BqRun } from "./verify";
// Yalnız yan etki: "gsc." sahte işleyicisini kaydeder (mock arka uç dışında
// erişilemez).
import "./mock-export";

// BigQuery içe aktarma işi (docs/search-agency.md): `gsc-agency` tick adımının
// BigQuery kolu. Her tur önce sahipliği ve mülk eşleşmesini YENİDEN denetler
// (izin düştüyse ya da mülk değiştiyse kaynak ERROR olur), kapsamı en çok 6
// saatte bir tazeler, planı çıkarır ve dönemleri sırayla içe aktarır. Dönem
// başına bağın senkron kilidi CAS ile alınır (API senkronuyla aynı satırı
// yazmasınlar); kilit meşgulse tur durur. GscDailyTotal'a BigQuery asla yazmaz.

const SOURCE_LEASE_MS = 10 * 60_000;
const COVERAGE_EVERY_MS = 6 * 3_600_000;
const IDLE_WAIT_MS = 6 * 3_600_000;
const MORE_WAIT_MS = 2 * 60_000;
const BACKOFF_BASE_MS = 30 * 60_000;
// Bu kadar süre kalmadıysa yeni dönem başlatılmaz (100.000 satırlık yazım
// yumuşakça taşabilir).
const MIN_PERIOD_MS = 20_000;
const MAX_IMPORTS_PER_RUN = 6;
// Plan penceresi: aşırı büyük dönemler atlansa da sıradakilere ulaşılır.
const PLAN_WINDOW = 60;
const DEFAULT_RUN_MS = 60_000;
const EXPORT_LATE_DAYS = 7;
const VERIFY_QUERY_BYTES = 1024 ** 3;
const REGROUP_BUDGET_MS = 15_000;

type SyncResult = { imported: number; status: BqBadge; reason: string | null };

// Kullanıcının düzeltmesi gereken hatalar: kaynak ERROR olur, yeniden doğrulanır.
const FATAL_CODES: readonly BqSourceErrorCode[] = [
  "NO_ACCESS",
  "NOT_FOUND",
  "BILLING_DISABLED",
  "SA_AUTH",
  "NOT_CONFIGURED",
  "INVALID_QUERY",
  "INVALID_REQUEST",
  "NO_EXPORT_DATA",
];

const BADGES: readonly BqBadge[] = [
  "DRAFT",
  "VERIFIED",
  "ACTIVE",
  "PAUSED",
  "ERROR",
  "BUDGET",
];

function badgeOf(status: string): BqBadge {
  return (BADGES as readonly string[]).includes(status)
    ? (status as BqBadge)
    : "DRAFT";
}

function logFailure(scope: string, error: unknown): void {
  console.error(
    `[gsc-bigquery] ${scope} failed:`,
    error instanceof Error ? error.name : "error",
  );
}

async function claimLink(linkId: string, owner: string): Promise<boolean> {
  const at = new Date();
  const claimed = await prisma.gscSiteLink.updateMany({
    where: {
      id: linkId,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: at } }],
    },
    data: {
      syncLeaseUntil: new Date(at.getTime() + GSC_SYNC_LEASE_MS),
      syncLeaseOwner: owner,
    },
  });
  return claimed.count === 1;
}

async function releaseLink(linkId: string, owner: string): Promise<void> {
  await prisma.gscSiteLink.updateMany({
    where: { id: linkId, syncLeaseOwner: owner },
    data: { syncLeaseUntil: null, syncLeaseOwner: null },
  });
}

async function loadFetched(
  linkId: string,
  start: string,
  through: string,
): Promise<Map<string, BqFetchState>> {
  const rows = await prisma.gscPeriodFetch.findMany({
    where: {
      linkId,
      periodStart: { gte: dayKeyToDate(start), lte: dayKeyToDate(through) },
    },
    select: { grain: true, periodStart: true, key: true, source: true, truncated: true },
  });
  return new Map(
    rows.map((row) => [
      bqPeriodKey(
        row.grain === "MONTH" ? "MONTH" : "WEEK",
        dateToDayKey(row.periodStart),
        row.key,
      ),
      { source: row.source === "BQ" ? "BQ" : "API", truncated: row.truncated },
    ]),
  );
}

type Held = { source: GscBqSource; owner: string };

async function failSource(
  source: GscBqSource,
  code: BqSourceErrorCode,
  imported = 0,
): Promise<SyncResult> {
  await prisma.gscBqSource.update({
    where: { id: source.id },
    data: { status: "ERROR", lastError: code, nextRunAt: null },
  });
  return { imported, status: "ERROR", reason: code };
}

async function runHeld(
  held: Held,
  now: Date,
  deadlineAt: number,
  client: BigQueryClient,
): Promise<SyncResult> {
  const { source } = held;
  const link = await prisma.gscSiteLink.findUnique({
    where: {
      projectId_siteUrl: { projectId: source.projectId, siteUrl: source.siteUrl },
    },
  });
  if (
    !link ||
    link.isMock !== source.isMock ||
    !(link.isPrimary || link.isSecondary)
  ) {
    await prisma.gscBqSource.update({
      where: { id: source.id },
      data: { status: "PAUSED", nextRunAt: null },
    });
    return { imported: 0, status: "PAUSED", reason: "NO_LINK" };
  }
  // Her turda yeniden: sahiplik ve mülk eşleşmesi (tek hesap, çok müşteri).
  // Saklanan sahiplik yetmez: bağ sağlığı ve kimlik bilgisi de aranır (Google
  // erişimi geri alındıysa değer eski kalır, senkron durur).
  if (!(await bqOwnershipHolds(link))) return failSource(source, "NOT_OWNER");
  if (
    !source.bqSiteUrl ||
    normalizeSiteUrl(source.bqSiteUrl) !== normalizeSiteUrl(link.siteUrl)
  ) {
    return failSource(source, "SITE_MISMATCH");
  }

  const target = { projectId: source.bqProjectId, dataset: source.dataset };
  const today = gscToday(now);
  let usage: BqUsage = usageOf(source, now);
  let queries = 0;
  let billed = 0;

  // Kapsam: en çok 6 saatte bir (ya da hiç yoksa) ExportLog'dan tazelenir.
  let exportStart = source.exportStart;
  let exportedThrough = source.exportedThrough;
  let coverageCheckedAt = source.coverageCheckedAt;
  const stale =
    !exportStart ||
    !exportedThrough ||
    !coverageCheckedAt ||
    now.getTime() - coverageCheckedAt.getTime() >= COVERAGE_EVERY_MS;
  if (stale) {
    const run: BqRun = async (built, maxRows) => {
      queries += 1;
      const result = await client.query({
        purpose: built.purpose,
        projectId: source.bqProjectId,
        location: source.location,
        sql: built.sql,
        params: built.params,
        maxBytesBilled: Math.min(Number(source.maxBytesPerQuery), VERIFY_QUERY_BYTES),
        maxRows,
        timeoutMs: Math.max(5_000, Math.min(60_000, deadlineAt - Date.now())),
      });
      billed += result.bytesBilled ?? result.bytesProcessed;
      return result;
    };
    try {
      const coverage = await readBqCoverage(run, target, link, today);
      if (!coverage?.exportStart || !coverage.exportedThrough) {
        await addBqUsage(source.id, billed, queries, now).catch(() => undefined);
        return failSource(source, "NO_EXPORT_DATA");
      }
      exportStart = coverage.exportStart;
      exportedThrough = coverage.exportedThrough;
      coverageCheckedAt = now;
    } catch (error) {
      if (queries > 0) {
        await addBqUsage(source.id, billed, queries, now).catch(() => undefined);
      }
      return finishWithError(source, error, 0);
    }
    if (queries > 0) {
      await addBqUsage(source.id, billed, queries, now);
      usage = {
        ...usage,
        bytesBilledMonth: usage.bytesBilledMonth + billed,
        queriesMonth: usage.queriesMonth + queries,
      };
    }
  }
  if (!exportStart || !exportedThrough) return failSource(source, "NO_EXPORT_DATA");

  const fetched = await loadFetched(link.id, exportStart, exportedThrough);
  const plan = planBqPeriods({
    exportStart,
    exportedThrough,
    importAll: source.importAll,
    fetched,
    maxTasks: PLAN_WINDOW,
  });

  const hardMax = hardMaxBytes();
  const hardMonthly = hardMonthlyBytes();
  let imported = 0;
  let skippedBig = 0;
  let outcome: "ok" | "budget" | "fatal" | "transient" = "ok";
  let errorCode: BqSourceErrorCode | null = null;

  for (const task of plan) {
    if (imported >= MAX_IMPORTS_PER_RUN) break;
    // Yeni dönem başlatmak için yeterli süre kalmalı.
    if (deadlineAt - Date.now() < MIN_PERIOD_MS) break;
    const owner = `gsc-bq:${process.pid}:${Date.now()}`;
    if (!(await claimLink(link.id, owner))) break;
    try {
      const read = await readBqPeriod({
        client,
        source,
        link,
        task,
        usage,
        hardMax,
        hardMonthly,
        deadlineAt,
        // Yarıda kalan sorgu da faturalanabilir: tahmini bayt aylık sayaca yazılır.
        onUnfinished: async (chargedBytes) => {
          await addBqUsage(source.id, chargedBytes, 1, now).catch(() => undefined);
          usage = recordSpend(usage, chargedBytes);
        },
      });
      if (!read.ok) {
        if (read.reason === "OVER_QUERY_CAP") {
          skippedBig += 1;
          continue;
        }
        outcome = "budget";
        break;
      }
      // Para harcandı: yazım başarısız olsa da sayaç artar.
      await addBqUsage(source.id, read.billedBytes, 1, now);
      usage = recordSpend(usage, read.billedBytes);
      const ctx: GscSyncContext = {
        link,
        accessToken: "",
        now,
        today,
        lane: "P2",
        deadline: deadlineAt,
        quota: quotaStateOf(link),
        requestsLeft: 0,
        brand: await brandContextForLink(link).catch(() => null),
        searchTypes: parseSearchTypes(link.searchTypes),
      };
      await writePeriod(ctx, task.grain, task.periodStart, task.key, read.result, "BQ");
      imported += 1;
    } catch (error) {
      const code = classifyBigQueryError(error).code;
      if (code === "COST_CAP") {
        // Gerçek sorgu tahminden büyük çıktı: dönem bu tur atlanır.
        skippedBig += 1;
        continue;
      }
      errorCode = code;
      outcome = FATAL_CODES.includes(code) ? "fatal" : "transient";
      if (!(error instanceof BigQueryError)) logFailure("period import", error);
      break;
    } finally {
      await releaseLink(link.id, owner).catch((error: unknown) =>
        logFailure("link lease release", error),
      );
    }
  }

  if (imported > 0) await regroupAfterImport(link, now);

  const refreshed = stale
    ? {
        exportStart,
        exportedThrough,
        coverageCheckedAt,
      }
    : {};
  const handled = imported + skippedBig;

  if (outcome === "fatal" && errorCode) {
    await prisma.gscBqSource.update({
      where: { id: source.id },
      data: { ...refreshed, status: "ERROR", lastError: errorCode, nextRunAt: null },
    });
    return { imported, status: "ERROR", reason: errorCode };
  }
  if (outcome === "budget") {
    await prisma.gscBqSource.update({
      where: { id: source.id },
      data: { ...refreshed, status: "BUDGET", lastError: null, nextRunAt: null },
    });
    return { imported, status: "BUDGET", reason: "OVER_MONTHLY_BUDGET" };
  }
  if (outcome === "transient" && errorCode) {
    const failures = source.consecutiveFailures + 1;
    const wait = Math.min(IDLE_WAIT_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    await prisma.gscBqSource.update({
      where: { id: source.id },
      data: {
        ...refreshed,
        consecutiveFailures: failures,
        lastError: errorCode,
        nextRunAt: new Date(now.getTime() + wait),
      },
    });
    return { imported, status: "ACTIVE", reason: errorCode };
  }

  const pending = plan.length - handled > 0;
  const late = exportedThrough < addDays(today, -EXPORT_LATE_DAYS);
  const lastError: BqSourceErrorCode | null =
    skippedBig > 0 ? "PERIOD_TOO_BIG" : late ? "EXPORT_LATE" : null;
  await prisma.gscBqSource.update({
    where: { id: source.id },
    data: {
      ...refreshed,
      consecutiveFailures: 0,
      lastSyncAt: now,
      lastError,
      nextRunAt: new Date(now.getTime() + (pending ? MORE_WAIT_MS : IDLE_WAIT_MS)),
    },
  });
  return { imported, status: "ACTIVE", reason: lastError };
}

// Kapsam yenilemesi sırasındaki hata: sabit koda çevrilir.
async function finishWithError(
  source: GscBqSource,
  error: unknown,
  imported: number,
): Promise<SyncResult> {
  const code = classifyBigQueryError(error).code;
  if (FATAL_CODES.includes(code)) return failSource(source, code, imported);
  const failures = source.consecutiveFailures + 1;
  const wait = Math.min(IDLE_WAIT_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
  await prisma.gscBqSource.update({
    where: { id: source.id },
    data: {
      consecutiveFailures: failures,
      lastError: code,
      nextRunAt: new Date(Date.now() + wait),
    },
  });
  return { imported, status: "ACTIVE", reason: code };
}

// Kurallar varsa, API'nin henüz ulaşmadığı haftalarda doğan sayfalar da gruba
// girsin (bölünmüş test nüfusu okunmadan önce).
async function regroupAfterImport(link: GscSiteLink, now: Date): Promise<void> {
  try {
    const rules = await pageGroupRulesForLink(link);
    if (rules && rules.rules.length > 0) {
      await GscPageGroups.regroupLink(link.id, { budgetMs: REGROUP_BUDGET_MS, now });
    }
  } catch (error) {
    logFailure("regroup", error);
  }
}

async function syncSource(
  sourceId: string,
  options: { now?: Date; deadlineAt?: number; client?: BigQueryClient } = {},
): Promise<SyncResult> {
  if (!gscBigQueryOn()) return { imported: 0, status: "OFF", reason: "FLAG_OFF" };
  const now = options.now ?? new Date();
  const deadlineAt = options.deadlineAt ?? Date.now() + DEFAULT_RUN_MS;
  const source = await prisma.gscBqSource.findUnique({ where: { id: sourceId } });
  if (!source) return { imported: 0, status: "OFF", reason: "MISSING" };
  const badge = badgeOf(source.status);
  if (!gscBigQueryActiveFor(source.projectId) || source.isMock !== gscMockMode()) {
    return { imported: 0, status: badge, reason: "NOT_ALLOWED" };
  }
  if (source.status !== "ACTIVE") {
    return { imported: 0, status: badge, reason: "NOT_ACTIVE" };
  }

  const owner = `gsc-bq:${process.pid}:${Date.now()}`;
  const claimed = await prisma.gscBqSource.updateMany({
    where: {
      id: source.id,
      status: "ACTIVE",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseUntil: new Date(now.getTime() + SOURCE_LEASE_MS),
      leaseOwner: owner,
    },
  });
  if (claimed.count !== 1) return { imported: 0, status: badge, reason: "BUSY" };

  try {
    return await runHeld(
      { source, owner },
      now,
      deadlineAt,
      options.client ?? bigQueryClient(),
    );
  } catch (error) {
    // Beklenmeyen hata (ör. veritabanı): tur kaybolur, kaynak ACTIVE kalır.
    logFailure("run", error);
    return { imported: 0, status: badge, reason: "UNKNOWN" };
  } finally {
    await prisma.gscBqSource
      .updateMany({
        where: { id: source.id, leaseOwner: owner },
        data: { leaseUntil: null, leaseOwner: null },
      })
      .catch((error: unknown) => logFailure("lease release", error));
  }
}

async function runDue(
  limit = 3,
  now: Date = new Date(),
  deadlineAt: number = Date.now() + DEFAULT_RUN_MS,
): Promise<number> {
  if (!gscBigQueryOn()) return 0;
  // Geliştirme süreci canlı veritabanını paylaşırken yalnız izinli projeler.
  const restricted = gscRestrictedProjects();
  if (restricted !== null && restricted.length === 0) return 0;
  const scope = restricted ? { projectId: { in: restricted } } : {};
  const isMock = gscMockMode();
  const month = currentUsageMonth(now);

  // Yeni aya geçen BUDGET kaynakları yeniden çalışır.
  await prisma.gscBqSource.updateMany({
    where: {
      status: "BUDGET",
      isMock,
      ...scope,
      OR: [{ usageMonth: null }, { usageMonth: { not: month } }],
    },
    data: { status: "ACTIVE", nextRunAt: null },
  });

  const due = await prisma.gscBqSource.findMany({
    where: {
      status: "ACTIVE",
      isMock,
      ...scope,
      AND: [
        { OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      ],
    },
    orderBy: [{ nextRunAt: { sort: "asc", nulls: "first" } }],
    select: { id: true, projectId: true },
    take: 25,
  });

  let total = 0;
  let started = 0;
  for (const entry of due) {
    if (started >= limit) break;
    if (deadlineAt - Date.now() < MIN_PERIOD_MS) break;
    if (!gscSyncAllowedFor(entry.projectId)) continue;
    started += 1;
    const result = await syncSource(entry.id, { now, deadlineAt });
    total += result.imported;
  }
  return total;
}

export const GscBigQuerySync = { runDue, syncSource };
