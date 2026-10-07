import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type {
  GscGrain,
  GscPeriodKey,
  GscSearchType,
  GscSliceKind,
} from "@/lib/seo/catalog";
import { dayKeyToDate, weekStartOf } from "@/lib/seo/dates";
import {
  mergeRows,
  normalizePageUrl,
  normalizeQueryText,
  pairKey,
  textHash,
  type GscMetrics,
} from "@/lib/seo/normalize";
import { positionWeighted, type GscRow } from "@/lib/seo/response";
import { trimSliceDay, type SliceRow } from "@/lib/seo/slices";
import { prisma } from "@/lib/prisma";
import type { GscPagedResult } from "@/server/integrations/search-console/search-analytics";

import type { GscSyncContext } from "./context";
import { upsertPages, upsertQueries } from "./dictionary";

// Ambara yazım (docs/google-search-console-plan.md §3.3, §4): günlük
// toplamlar ve kırılımlar tek ifadeli toplu upsert ile (200 satır); dönem
// özetleri (hafta/ay × sorgu/sayfa/sorgu×sayfa) tek işlemde sil-yeniden-yaz.
// Kesin satır taze veriyle asla ezilmez. Konumlar position × gösterim olarak
// saklanır (dönem konumu = Σ ağırlıklı / Σ gösterim).

const ROWS_PER_STATEMENT = 200;
const PERIOD_ROWS_PER_INSERT = 500;
const PERIOD_TX_TIMEOUT_MS = 60_000;

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

export type DailyTotalRow = GscMetrics & { day: string; fresh: boolean };

// Yanıt satırlarını güne göre (keys[0] = date) metriklere çevirir.
export function metricsByDay(rows: readonly GscRow[]): Map<string, GscMetrics> {
  const out = new Map<string, GscMetrics>();
  for (const row of rows) {
    const day = row.keys[0];
    if (!day) continue;
    const current = out.get(day) ?? {
      clicks: 0,
      impressions: 0,
      positionWeighted: 0,
    };
    current.clicks += row.clicks;
    current.impressions += row.impressions;
    current.positionWeighted += positionWeighted(row);
    out.set(day, current);
  }
  return out;
}

const ZERO: GscMetrics = { clicks: 0, impressions: 0, positionWeighted: 0 };

// Günler için metrik satırları; satırı gelmeyen gün sıfırdır.
export function dayMetrics(
  days: readonly string[],
  byDay: ReadonlyMap<string, GscMetrics>,
): (GscMetrics & { day: string })[] {
  return days.map((day) => ({ day, ...(byDay.get(day) ?? ZERO) }));
}

export async function writeDailyTotals(
  ctx: GscSyncContext,
  type: GscSearchType,
  rows: readonly DailyTotalRow[],
): Promise<void> {
  const fetchedAt = new Date();
  for (const part of chunks([...rows], ROWS_PER_STATEMENT)) {
    const values = part.map(
      (row) =>
        Prisma.sql`(${randomUUID()}, ${ctx.link.id}, ${ctx.link.projectId}, ${row.day}::date, ${type}, ${Math.round(row.clicks)}::int, ${Math.round(row.impressions)}::int, ${row.positionWeighted}::double precision, ${row.fresh}, ${fetchedAt})`,
    );
    // Kesin satır (fresh=false) yalnız kesin veriyle güncellenir.
    await prisma.$executeRaw`
      INSERT INTO "GscDailyTotal" ("id", "linkId", "projectId", "date", "searchType", "clicks", "impressions", "positionWeighted", "fresh", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("linkId", "date", "searchType") DO UPDATE SET
        "clicks" = EXCLUDED."clicks",
        "impressions" = EXCLUDED."impressions",
        "positionWeighted" = EXCLUDED."positionWeighted",
        "fresh" = EXCLUDED."fresh",
        "fetchedAt" = EXCLUDED."fetchedAt"
      WHERE "GscDailyTotal"."fresh" = true OR EXCLUDED."fresh" = false
    `;
  }
}

// Marka serisi yalnız var olan web satırlarına yazılır (satır eklemez).
export async function writeBrandSeries(
  ctx: GscSyncContext,
  rows: readonly (GscMetrics & { day: string })[],
): Promise<void> {
  for (const part of chunks([...rows], ROWS_PER_STATEMENT)) {
    const values = part.map(
      (row) =>
        Prisma.sql`(${row.day}::date, ${Math.round(row.clicks)}::int, ${Math.round(row.impressions)}::int, ${row.positionWeighted}::double precision)`,
    );
    await prisma.$executeRaw`
      UPDATE "GscDailyTotal" AS t SET
        "brandClicks" = v."clicks",
        "brandImpressions" = v."impressions",
        "brandPositionWeighted" = v."positionWeighted"
      FROM (VALUES ${Prisma.join(values)}) AS v("day", "clicks", "impressions", "positionWeighted")
      WHERE t."linkId" = ${ctx.link.id} AND t."searchType" = 'web' AND t."date" = v."day"
    `;
  }
}

// Terimler kalktı: marka serisi boşalır (ayrım "none").
export async function clearBrandSeries(linkId: string): Promise<void> {
  await prisma.gscDailyTotal.updateMany({
    where: { linkId, searchType: "web" },
    data: {
      brandClicks: null,
      brandImpressions: null,
      brandPositionWeighted: null,
    },
  });
}

type SliceInput = {
  kind: string;
  day: string;
  rows: SliceRow[];
  other: [number, number, number] | null;
  rowCount: number;
  truncated: boolean;
};

export async function upsertSliceRows(
  ctx: GscSyncContext,
  slices: readonly SliceInput[],
): Promise<void> {
  const fetchedAt = new Date();
  for (const part of chunks([...slices], ROWS_PER_STATEMENT)) {
    const values = part.map(
      (slice) =>
        Prisma.sql`(${randomUUID()}, ${ctx.link.id}, ${ctx.link.projectId}, ${slice.kind}, ${slice.day}::date, ${json(slice.rows)}::jsonb, ${slice.other === null ? null : json(slice.other)}::jsonb, ${slice.rowCount}::int, ${slice.truncated}, ${fetchedAt})`,
    );
    await prisma.$executeRaw`
      INSERT INTO "GscDailySlice" ("id", "linkId", "projectId", "kind", "date", "rows", "other", "rowCount", "truncated", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("linkId", "kind", "date") DO UPDATE SET
        "rows" = EXCLUDED."rows",
        "other" = EXCLUDED."other",
        "rowCount" = EXCLUDED."rowCount",
        "truncated" = EXCLUDED."truncated",
        "fetchedAt" = EXCLUDED."fetchedAt"
    `;
  }
}

function sliceRow(key: string, row: GscRow): SliceRow {
  return [key, row.clicks, row.impressions, positionWeighted(row)];
}

// ["date", boyut] yanıtı: güne göre bölünür, her gün kırpılır; satırı
// gelmeyen gün boş dizi olarak yazılır.
export async function writeSlices(
  ctx: GscSyncContext,
  kind: GscSliceKind,
  days: readonly string[],
  rows: readonly GscRow[],
  truncated: boolean,
): Promise<void> {
  if (days.length === 0) return;
  const byDay = new Map<string, SliceRow[]>();
  for (const row of rows) {
    const [day, key] = row.keys;
    if (!day || key === undefined) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), sliceRow(key, row)]);
  }
  await upsertSliceRows(
    ctx,
    days.map((day) => {
      const dayRows = byDay.get(day) ?? [];
      const trimmed = trimSliceDay(kind, dayRows);
      return {
        kind,
        day,
        rows: trimmed.rows,
        other: trimmed.other,
        rowCount: dayRows.length,
        truncated,
      };
    }),
  );
}

// Görünüm yedeği: tek günün [boyut] yanıtı.
export async function writeSliceDay(
  ctx: GscSyncContext,
  kind: GscSliceKind,
  day: string,
  rows: readonly GscRow[],
  truncated: boolean,
): Promise<void> {
  const dayRows = rows
    .filter((row) => row.keys[0] !== undefined)
    .map((row) => sliceRow(row.keys[0]!, row));
  const trimmed = trimSliceDay(kind, dayRows);
  await upsertSliceRows(ctx, [
    {
      kind,
      day,
      rows: trimmed.rows,
      other: trimmed.other,
      rowCount: dayRows.length,
      truncated,
    },
  ]);
}

type QueryItem = GscMetrics & { text: string; hash: string };
type PageItem = GscMetrics & {
  url: string;
  hash: string;
  path: string;
  pageGroup: string;
};
type PairItem = GscMetrics & {
  query: { text: string; hash: string };
  page: { url: string; hash: string; path: string; pageGroup: string };
};

function metrics(row: GscRow): GscMetrics {
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    positionWeighted: positionWeighted(row),
  };
}

function queryOf(value: string | undefined) {
  if (value === undefined) return null;
  const text = normalizeQueryText(value);
  return text ? { text, hash: textHash(text) } : null;
}

function pageOf(value: string | undefined) {
  if (value === undefined) return null;
  const page = normalizePageUrl(value);
  return page
    ? {
        url: page.url,
        hash: page.hash,
        path: page.path,
        pageGroup: page.pageGroup,
      }
    : null;
}

type PeriodRow = {
  queryId?: string;
  pageId?: string;
} & GscMetrics;

// Normalleştirilmiş dönem satırları (sözlük kimlikleriyle).
async function periodRows(
  ctx: GscSyncContext,
  key: GscPeriodKey,
  rows: readonly GscRow[],
  seenWeek: string,
): Promise<PeriodRow[]> {
  if (key === "query") {
    const items = mergeRows<QueryItem>(
      rows.flatMap((row) => {
        const query = queryOf(row.keys[0]);
        return query ? [{ ...query, ...metrics(row) }] : [];
      }),
      (item) => item.hash,
    );
    const ids = await upsertQueries(ctx, items, seenWeek, {
      classify: ctx.brand !== null,
    });
    return items.flatMap((item) => {
      const queryId = ids.get(item.hash);
      return queryId ? [{ ...item, queryId }] : [];
    });
  }
  if (key === "page") {
    const items = mergeRows<PageItem>(
      rows.flatMap((row) => {
        const page = pageOf(row.keys[0]);
        return page ? [{ ...page, ...metrics(row) }] : [];
      }),
      (item) => item.hash,
    );
    const ids = await upsertPages(ctx, items, seenWeek);
    return items.flatMap((item) => {
      const pageId = ids.get(item.hash);
      return pageId ? [{ ...item, pageId }] : [];
    });
  }
  const items = mergeRows<PairItem>(
    rows.flatMap((row) => {
      const query = queryOf(row.keys[0]);
      const page = pageOf(row.keys[1]);
      return query && page ? [{ query, page, ...metrics(row) }] : [];
    }),
    (item) => pairKey(item.query.hash, item.page.hash),
  );
  const queryIds = await upsertQueries(
    ctx,
    items.map((item) => item.query),
    seenWeek,
    { classify: ctx.brand !== null },
  );
  const pageIds = await upsertPages(
    ctx,
    items.map((item) => item.page),
    seenWeek,
  );
  return items.flatMap((item) => {
    const queryId = queryIds.get(item.query.hash);
    const pageId = pageIds.get(item.page.hash);
    return queryId && pageId
      ? [
          {
            queryId,
            pageId,
            clicks: item.clicks,
            impressions: item.impressions,
            positionWeighted: item.positionWeighted,
          },
        ]
      : [];
  });
}

// Dönem özeti: normalleştir → çakışanları topla → sözlükler → tek işlemde
// eski satırları sil, yenilerini yaz → GscPeriodFetch. Boş yanıt da
// "çekildi" olarak işaretlenir (rowCount 0).
export async function writePeriod(
  ctx: GscSyncContext,
  grain: GscGrain,
  periodStart: string,
  key: GscPeriodKey,
  result: GscPagedResult,
  // SC-F9: BigQuery dönemleri "BQ" damgasıyla yazılır; mevcut çağıranlar
  // varsayılan "API" ile değişmez.
  source: "API" | "BQ" = "API",
): Promise<void> {
  if (grain === "MONTH" && key === "query_page") {
    throw new Error("Monthly query×page summaries are not stored");
  }
  const seenWeek = weekStartOf(periodStart);
  const rows = await periodRows(ctx, key, result.rows, seenWeek);
  const rowClicks = result.rows.reduce((sum, row) => sum + row.clicks, 0);
  const rowImpressions = result.rows.reduce(
    (sum, row) => sum + row.impressions,
    0,
  );
  const period = dayKeyToDate(periodStart);
  const linkId = ctx.link.id;
  const fetchedAt = new Date();

  await prisma.$transaction(
    async (tx) => {
      const data = rows.map((row) => ({
        linkId,
        projectId: ctx.link.projectId,
        queryId: row.queryId,
        pageId: row.pageId,
        clicks: Math.round(row.clicks),
        impressions: Math.round(row.impressions),
        positionWeighted: row.positionWeighted,
      }));
      if (grain === "WEEK" && key === "query") {
        await tx.gscWeeklyQuery.deleteMany({
          where: { linkId, weekStart: period },
        });
        for (const part of chunks(data, PERIOD_ROWS_PER_INSERT)) {
          await tx.gscWeeklyQuery.createMany({
            data: part.map((row) => ({
              linkId: row.linkId,
              projectId: row.projectId,
              weekStart: period,
              queryId: row.queryId!,
              clicks: row.clicks,
              impressions: row.impressions,
              positionWeighted: row.positionWeighted,
            })),
          });
        }
      } else if (grain === "WEEK" && key === "page") {
        await tx.gscWeeklyPage.deleteMany({
          where: { linkId, weekStart: period },
        });
        for (const part of chunks(data, PERIOD_ROWS_PER_INSERT)) {
          await tx.gscWeeklyPage.createMany({
            data: part.map((row) => ({
              linkId: row.linkId,
              projectId: row.projectId,
              weekStart: period,
              pageId: row.pageId!,
              clicks: row.clicks,
              impressions: row.impressions,
              positionWeighted: row.positionWeighted,
            })),
          });
        }
      } else if (grain === "WEEK") {
        await tx.gscWeeklyQueryPage.deleteMany({
          where: { linkId, weekStart: period },
        });
        for (const part of chunks(data, PERIOD_ROWS_PER_INSERT)) {
          await tx.gscWeeklyQueryPage.createMany({
            data: part.map((row) => ({
              linkId: row.linkId,
              projectId: row.projectId,
              weekStart: period,
              queryId: row.queryId!,
              pageId: row.pageId!,
              clicks: row.clicks,
              impressions: row.impressions,
              positionWeighted: row.positionWeighted,
            })),
          });
        }
      } else if (key === "query") {
        await tx.gscMonthlyQuery.deleteMany({
          where: { linkId, month: period },
        });
        for (const part of chunks(data, PERIOD_ROWS_PER_INSERT)) {
          await tx.gscMonthlyQuery.createMany({
            data: part.map((row) => ({
              linkId: row.linkId,
              projectId: row.projectId,
              month: period,
              queryId: row.queryId!,
              clicks: row.clicks,
              impressions: row.impressions,
              positionWeighted: row.positionWeighted,
            })),
          });
        }
      } else {
        await tx.gscMonthlyPage.deleteMany({
          where: { linkId, month: period },
        });
        for (const part of chunks(data, PERIOD_ROWS_PER_INSERT)) {
          await tx.gscMonthlyPage.createMany({
            data: part.map((row) => ({
              linkId: row.linkId,
              projectId: row.projectId,
              month: period,
              pageId: row.pageId!,
              clicks: row.clicks,
              impressions: row.impressions,
              positionWeighted: row.positionWeighted,
            })),
          });
        }
      }
      const fetch = {
        rowCount: rows.length,
        truncated: result.truncated,
        rowClicks: Math.round(rowClicks),
        rowImpressions: Math.round(rowImpressions),
        pages: result.pages,
        fetchedAt,
        source,
      };
      await tx.gscPeriodFetch.upsert({
        where: {
          linkId_grain_periodStart_key: {
            linkId,
            grain,
            periodStart: period,
            key,
          },
        },
        create: {
          linkId,
          projectId: ctx.link.projectId,
          grain,
          periodStart: period,
          key,
          ...fetch,
        },
        update: fetch,
      });
    },
    // SC-F9: BigQuery dönemleri 100.000 satıra varabilir; süre satır sayısıyla
    // ölçeklenir (üst sınır 5 dk).
    {
      timeout: Math.min(
        300_000,
        PERIOD_TX_TIMEOUT_MS + Math.ceil(rows.length / 1000) * 1_000,
      ),
    },
  );
}

export async function hasPeriodFetch(
  linkId: string,
  grain: GscGrain,
  periodStart: string,
  key: GscPeriodKey,
): Promise<boolean> {
  const row = await prisma.gscPeriodFetch.findUnique({
    where: {
      linkId_grain_periodStart_key: {
        linkId,
        grain,
        periodStart: dayKeyToDate(periodStart),
        key,
      },
    },
    select: { id: true },
  });
  return row !== null;
}
