import "server-only";

import type { Prisma } from "@prisma/client";

import {
  advanceGscBackfill,
  brandKeyDone,
  dropFinishedGaps,
  gscBackfillComplete,
  initialGscBackfill,
  isBrandErrorHash,
  nextGscBackfillChunk,
  noteTotalsChunk,
  parseGscBackfillState,
  queueHeavy,
  setZeroPending,
  skipGscBackfillKey,
  takeHeavy,
  type GscBackfillChunk,
  type GscBackfillState,
} from "@/lib/seo/backfill";
import {
  GSC_PERIOD_KEYS,
  GSC_PERIOD_MAX_PAGES,
  GSC_SEARCH_TYPES,
  GSC_SLICE_KINDS,
  GSC_SLICE_MAX_PAGES,
  GSC_TOTALS_MAX_PAGES,
  brandTotalsRequest,
  periodRequest,
  sliceRequest,
  totalsRequest,
  type GscSearchType,
  type GscSliceKind,
} from "@/lib/seo/catalog";
import {
  dayRange,
  googleWindowStart,
  maxDay,
  weekEndOf,
} from "@/lib/seo/dates";
import { heavyBlocked } from "@/lib/seo/governor";
import { backfillWriteDays } from "@/lib/seo/schedule";
import { prisma } from "@/lib/prisma";
import { isGscValidationError } from "@/server/integrations/search-console/errors";

import {
  gscBackfillSkipKeys,
  saveSearchTypes,
  serializeSearchTypes,
  type GscSyncContext,
} from "./context";
import { disableSlice, markBrandError } from "./daily";
import { fetchMonth } from "./monthly";
import { GscQuotaDeferred, runGscQuery } from "./requests";
import {
  dayMetrics,
  metricsByDay,
  writeBrandSeries,
  writeDailyTotals,
  writePeriod,
  writeSlices,
  hasPeriodFetch,
} from "./write";

// Geri doldurma (docs/google-search-console-plan.md §3.3 "Geri doldurma";
// docs/search-analytics.md "Senkron"): Google'ın 16 aylık penceresi bağ
// başına bir kez, yeniden eskiye ve parça parça (toplamlar ve marka 90 gün,
// kırılımlar 30 gün, aylar ve haftalar tek dönem). Önce boşluklar. Durum her
// parçadan sonra bellekte ilerler ve turun sonunda (kota bekletse ya da bütçe
// bitse de) kaydedilir. Ağır blok yalnız o parçanın anahtarını bu tur için
// atlatır; diğer işler sürer.

function typeOf(key: string): GscSearchType | null {
  const type = key.slice("totals:".length);
  return (GSC_SEARCH_TYPES as readonly string[]).includes(type)
    ? (type as GscSearchType)
    : null;
}

function sliceKindOf(key: string): GscSliceKind | null {
  const kind = key.slice("slice:".length);
  return (GSC_SLICE_KINDS as readonly string[]).includes(kind)
    ? (kind as GscSliceKind)
    : null;
}

async function fetchWeek(
  ctx: GscSyncContext,
  state: GscBackfillState,
  week: string,
): Promise<GscBackfillState> {
  let next = state;
  for (const key of GSC_PERIOD_KEYS) {
    if (await hasPeriodFetch(ctx.link.id, "WEEK", week, key)) continue;
    if (key === "query_page" && heavyBlocked(ctx.quota, new Date())) {
      next = queueHeavy(next, week);
      continue;
    }
    const result = await runGscQuery(
      ctx,
      periodRequest(key, week, weekEndOf(week)),
      { maxPages: GSC_PERIOD_MAX_PAGES[key] },
    );
    await writePeriod(ctx, "WEEK", week, key, result);
  }
  return next;
}

// Tek parça; dönüş: ilerlemiş durum.
async function runChunk(
  ctx: GscSyncContext,
  state: GscBackfillState,
  chunk: GscBackfillChunk,
  skip: ReadonlySet<string>,
  window: string,
): Promise<GscBackfillState> {
  const { key } = chunk;

  // Dönemler: pencereden önce başlayan dönem artık eksik gelir, atlanır.
  if (key === "monthly" || key === "weekly") {
    if (chunk.start < window) return advanceGscBackfill(state, chunk, skip);
    if (key === "monthly") {
      await fetchMonth(ctx, chunk.start);
      return advanceGscBackfill(state, chunk, skip);
    }
    const next = await fetchWeek(ctx, state, chunk.start);
    return advanceGscBackfill(next, chunk, skip);
  }

  // Günlük anahtarlar: başlangıç istek anında pencereye kırpılır.
  const start = maxDay(chunk.start, window) ?? chunk.start;
  if (start > chunk.end) return advanceGscBackfill(state, chunk, skip);
  const days = dayRange(start, chunk.end);
  const atFloor =
    chunk.gapStart === null && chunk.start <= (state.floor[key] ?? chunk.start);
  // Yazılacak günler: ilk satırdan önceki günler daha eski bir parçada satır
  // gelene dek sıfır sayılmaz (yeni doğrulanmış mülkte sahte sıfır olmasın).
  const fillFor = (returned: ReadonlySet<string>) =>
    backfillWriteDays({
      days,
      returned,
      atFloor,
      gap: chunk.gapStart !== null,
      pendingTo: state.zeroPendingTo[key] ?? null,
    });

  if (key === "brand") {
    const regex = ctx.brand?.regex ?? null;
    if (!regex) return skipGscBackfillKey(state, key);
    try {
      const result = await runGscQuery(
        ctx,
        brandTotalsRequest(regex, start, chunk.end),
        { maxPages: GSC_TOTALS_MAX_PAGES },
      );
      // Yalnız var olan web satırlarını günceller: web verisi olmayan güne
      // marka yazılmaz, bu yüzden bütün günler sıfırla doldurulabilir.
      await writeBrandSeries(ctx, dayMetrics(days, metricsByDay(result.rows)));
    } catch (error) {
      if (!isGscValidationError(error)) throw error;
      return (await markBrandError(ctx, state)) ?? state;
    }
    return advanceGscBackfill(state, chunk, skip);
  }

  const kind = sliceKindOf(key);
  if (kind) {
    try {
      const result = await runGscQuery(
        ctx,
        sliceRequest(kind, start, chunk.end),
        { maxPages: GSC_SLICE_MAX_PAGES },
      );
      const fill = fillFor(
        new Set(
          result.rows.flatMap((row) => (row.keys[0] ? [row.keys[0]] : [])),
        ),
      );
      await writeSlices(ctx, kind, fill.days, result.rows, result.truncated);
      return advanceGscBackfill(
        setZeroPending(state, key, fill.pendingTo),
        chunk,
        skip,
      );
    } catch (error) {
      if (!isGscValidationError(error)) throw error;
      await disableSlice(ctx, kind);
      return skipGscBackfillKey(state, key);
    }
  }

  const type = typeOf(key);
  if (!type) return skipGscBackfillKey(state, key);
  const result = await runGscQuery(
    ctx,
    totalsRequest(type, start, chunk.end, "final"),
    { maxPages: GSC_TOTALS_MAX_PAGES },
  );
  const byDay = metricsByDay(result.rows);
  const fill = fillFor(new Set(byDay.keys()));
  // Satırsız isteğe bağlı tür parçası sıfır satırla doldurulmaz (çoğu mülkte
  // news/discover hiç yoktur).
  if (
    fill.days.length > 0 &&
    (key === "totals:web" || result.rows.length > 0)
  ) {
    await writeDailyTotals(
      ctx,
      type,
      dayMetrics(fill.days, byDay).map((row) => ({ ...row, fresh: false })),
    );
  }
  if (chunk.gapStart !== null) return advanceGscBackfill(state, chunk, skip);
  const noted = noteTotalsChunk(
    setZeroPending(state, key, fill.pendingTo),
    key,
    result.rows.length > 0,
  );
  if (noted.empty) {
    ctx.searchTypes.empty.add(type);
    await saveSearchTypes(ctx);
    return skipGscBackfillKey(noted.state, key);
  }
  return advanceGscBackfill(noted.state, chunk, skip);
}

// Ağır kuyruk: blok kalkınca bekleyen sorgu×sayfa haftaları çekilir.
async function drainHeavy(
  ctx: GscSyncContext,
  state: GscBackfillState,
  window: string,
): Promise<GscBackfillState> {
  let current = state;
  while (
    current.heavyPending.length > 0 &&
    ctx.requestsLeft >= 1 &&
    !heavyBlocked(ctx.quota, new Date())
  ) {
    const { week, state: rest } = takeHeavy(current);
    if (!week) break;
    if (
      week >= window &&
      !(await hasPeriodFetch(ctx.link.id, "WEEK", week, "query_page"))
    ) {
      try {
        const result = await runGscQuery(
          ctx,
          periodRequest("query_page", week, weekEndOf(week)),
          { maxPages: GSC_PERIOD_MAX_PAGES.query_page },
        );
        await writePeriod(ctx, "WEEK", week, "query_page", result);
      } catch (error) {
        if (error instanceof GscQuotaDeferred && error.reason === "HEAVY") {
          break;
        }
        throw error;
      }
    }
    current = rest;
  }
  return current;
}

async function saveState(
  ctx: GscSyncContext,
  state: GscBackfillState,
  skip: ReadonlySet<string>,
): Promise<void> {
  const data: Prisma.GscSiteLinkUpdateInput = {
    searchTypes: serializeSearchTypes(ctx.searchTypes, ctx.now),
  };
  let saved = state;
  if (brandKeyDone(state)) {
    if (state.brandHash === "none") {
      data.brandSeriesHash = "none";
    } else if (
      state.brandHash &&
      !isBrandErrorHash(state.brandHash) &&
      state.brandHash === ctx.brand?.hash
    ) {
      data.brandSeriesHash = state.brandHash;
    }
  }
  if (!ctx.link.backfillDoneAt && gscBackfillComplete(state, skip)) {
    saved = { ...state, doneAt: ctx.now.toISOString() };
    data.backfillDoneAt = ctx.now;
  }
  data.backfill = saved as unknown as Prisma.InputJsonValue;
  ctx.link = await prisma.gscSiteLink.update({
    where: { id: ctx.link.id },
    data,
  });
}

export async function syncBackfill(ctx: GscSyncContext): Promise<void> {
  const finalThrough = ctx.link.lastFinalDate;
  if (!finalThrough) return;
  let state =
    parseGscBackfillState(ctx.link.backfill) ??
    initialGscBackfill({
      today: ctx.today,
      finalThrough,
      lastWeeklyWeek: ctx.link.lastWeeklyWeek,
      lastMonthlyMonth: ctx.link.lastMonthlyMonth,
      brandHash: ctx.brand?.hash ?? null,
      now: ctx.now,
    });
  const window = googleWindowStart(ctx.today);
  const skip = gscBackfillSkipKeys(ctx, state);
  // Ağır blok yüzünden bu tur atlanan anahtarlar (tamamlanmaya sayılmaz).
  const deferred = new Set(skip);
  state = dropFinishedGaps(state, skip);

  try {
    for (;;) {
      const chunk = nextGscBackfillChunk(state, deferred);
      if (!chunk || ctx.requestsLeft < chunk.requests) break;
      try {
        state = await runChunk(ctx, state, chunk, skip, window);
      } catch (error) {
        if (error instanceof GscQuotaDeferred && error.reason === "HEAVY") {
          deferred.add(chunk.key);
          continue;
        }
        throw error;
      }
      // Durum değişince (ör. marka hatası, boş tür) atlama kümesi güncellenir.
      for (const key of gscBackfillSkipKeys(ctx, state)) {
        deferred.add(key);
      }
    }
    state = await drainHeavy(ctx, state, window);
  } finally {
    // Kota bekletse ya da bütçe bitse de ilerleme kaybolmaz.
    await saveState(ctx, state, gscBackfillSkipKeys(ctx, state));
  }
}
