import "server-only";

import type { Prisma } from "@prisma/client";

import {
  addGscGap,
  brandErrorHash,
  isBrandErrorHash,
  parseGscBackfillState,
  retargetBrand,
  type GscBackfillState,
} from "@/lib/seo/backfill";
import {
  GSC_OPTIONAL_TYPES,
  GSC_SLICE_KINDS,
  GSC_SLICE_MAX_PAGES,
  GSC_TOTALS_MAX_PAGES,
  brandTotalsRequest,
  sliceDayRequest,
  sliceRequest,
  totalsRequest,
  type GscSliceKind,
} from "@/lib/seo/catalog";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  dayRange,
  googleWindowStart,
  maxDay,
} from "@/lib/seo/dates";
import {
  GSC_APPEARANCE_DAYS_PER_RUN,
  GSC_DAILY_WINDOW_DAYS,
  dailySlot,
  detectGap,
  planDailyWrites,
  resolveFinalThrough,
} from "@/lib/seo/schedule";
import { prisma } from "@/lib/prisma";
import { isGscValidationError } from "@/server/integrations/search-console/errors";

import {
  saveSearchTypes,
  serializeSearchTypes,
  type GscSyncContext,
} from "./context";
import { runGscQuery } from "./requests";
import {
  dayMetrics,
  metricsByDay,
  writeBrandSeries,
  writeDailyTotals,
  writeSliceDay,
  writeSlices,
} from "./write";

// Günlük çekim (docs/google-search-console-plan.md §3.3 "Kesin ve taze"):
// today−10 … dün için web toplamları iki kez istenir (dataState=all ve
// final). finalThrough'a kadar olan günler kesin yanıttan (fresh=false),
// sonrası taze yanıttan (fresh=true) yazılır. Ardından isteğe bağlı türler,
// marka serisi ve kırılımlar yalnız kesin günler için. Hiçbir istek 90 günü
// aşmaz (ağır sayılmaz). Pencerenin gerisinde kalan günler geri doldurmaya
// boşluk olarak eklenir.

async function saveBackfill(
  ctx: GscSyncContext,
  state: GscBackfillState,
  extra: Prisma.GscSiteLinkUpdateInput = {},
): Promise<void> {
  ctx.link = await prisma.gscSiteLink.update({
    where: { id: ctx.link.id },
    data: {
      backfill: state as unknown as Prisma.InputJsonValue,
      ...extra,
    },
  });
}

// Google marka regex'ini geçersiz saydı (RE2): ayrım "error" olur, marka
// anahtarı aynı terimlerle bir daha istenmez; kullanıcı terimleri
// düzeltince (yeni özet) yeniden açılır.
export async function markBrandError(
  ctx: GscSyncContext,
  state: GscBackfillState | null,
): Promise<GscBackfillState | null> {
  console.warn(
    `[gsc-sync] brand filter rejected for site ${ctx.link.siteUrl}; brand split disabled until the terms change`,
  );
  if (!state) {
    ctx.link = await prisma.gscSiteLink.update({
      where: { id: ctx.link.id },
      data: { brandSeriesHash: "error" },
    });
    return null;
  }
  const next = retargetBrand(state, {
    hash: brandErrorHash(ctx.brand?.hash ?? "none"),
    hasRegex: false,
    floor: googleWindowStart(ctx.today),
    end: addDays(ctx.today, -GSC_DAILY_WINDOW_DAYS - 1),
  }).state;
  await saveBackfill(ctx, next, { brandSeriesHash: "error" });
  return next;
}

// Google bir kırılımı geçersiz saydı: görünüm önce gün gün çekime geçer,
// yine reddedilirse (ya da ülke/cihazda) kırılım kapanır.
export async function disableSlice(
  ctx: GscSyncContext,
  kind: GscSliceKind,
): Promise<void> {
  const perDay = kind === "appearance" && !ctx.searchTypes.appearancePerDay;
  if (perDay) ctx.searchTypes.appearancePerDay = true;
  else ctx.searchTypes.disabledSlices.add(kind);
  console.warn(
    `[gsc-sync] ${kind} breakdown rejected for site ${ctx.link.siteUrl}; ${perDay ? "fetching it day by day" : "disabled"}`,
  );
  await saveSearchTypes(ctx);
}

async function syncAppearanceDays(
  ctx: GscSyncContext,
  start: string,
  finalThrough: string,
): Promise<void> {
  const stored = await prisma.gscDailySlice.findMany({
    where: {
      linkId: ctx.link.id,
      kind: "appearance",
      date: { gte: dayKeyToDate(start), lte: dayKeyToDate(finalThrough) },
    },
    select: { date: true },
  });
  const have = new Set(stored.map((row) => dateToDayKey(row.date)));
  const missing = dayRange(start, finalThrough)
    .filter((day) => !have.has(day))
    .slice(0, GSC_APPEARANCE_DAYS_PER_RUN);
  for (const day of missing) {
    try {
      const result = await runGscQuery(
        ctx,
        sliceDayRequest("appearance", day),
        {
          maxPages: GSC_SLICE_MAX_PAGES,
        },
      );
      await writeSliceDay(
        ctx,
        "appearance",
        day,
        result.rows,
        result.truncated,
      );
    } catch (error) {
      if (!isGscValidationError(error)) throw error;
      await disableSlice(ctx, "appearance");
      return;
    }
  }
}

export async function syncDaily(ctx: GscSyncContext): Promise<void> {
  const start = addDays(ctx.today, -GSC_DAILY_WINDOW_DAYS);
  const yesterday = addDays(ctx.today, -1);
  const previous = ctx.link.lastFinalDate;

  // (1) Web: taze + kesin.
  const all = await runGscQuery(
    ctx,
    totalsRequest("web", start, yesterday, "all"),
    { maxPages: GSC_TOTALS_MAX_PAGES },
  );
  const final = await runGscQuery(
    ctx,
    totalsRequest("web", start, yesterday, "final"),
    { maxPages: GSC_TOTALS_MAX_PAGES },
  );
  const allByDay = metricsByDay(all.rows);
  const finalByDay = metricsByDay(final.rows);
  const finalThrough = resolveFinalThrough({
    finalRowMax: maxDay(...finalByDay.keys()),
    firstIncompleteDate: all.firstIncompleteDate,
    today: ctx.today,
    previous,
  });
  const writes = planDailyWrites({
    start,
    yesterday,
    finalThrough,
    firstIncompleteDate: all.firstIncompleteDate,
    allDays: new Set(allByDay.keys()),
  });
  const zero = { clicks: 0, impressions: 0, positionWeighted: 0 };
  await writeDailyTotals(
    ctx,
    "web",
    writes.map((write) => ({
      day: write.day,
      fresh: write.fresh,
      ...((write.source === "final" ? finalByDay : allByDay).get(write.day) ??
        zero),
    })),
  );

  // Bağ bir süre senkronlanamadıysa aradaki günler boşluk olur.
  const gap = detectGap({
    previousFinal: previous,
    dailyStart: start,
    windowStart: googleWindowStart(ctx.today),
  });
  const state = parseGscBackfillState(ctx.link.backfill);
  ctx.link = await prisma.gscSiteLink.update({
    where: { id: ctx.link.id },
    data: {
      lastFinalDate: finalThrough,
      ...(gap && state
        ? {
            backfill: addGscGap(state, gap) as unknown as Prisma.InputJsonValue,
          }
        : {}),
    },
  });
  if (gap) {
    console.info(
      `[gsc-sync] site ${ctx.link.siteUrl}: ${gap.start}…${gap.end} missed, queued for backfill`,
    );
  }

  const finalDays = dayRange(start, finalThrough);
  if (finalDays.length > 0) {
    // (2) İsteğe bağlı türler: yalnız kesin günler.
    for (const type of GSC_OPTIONAL_TYPES) {
      if (ctx.searchTypes.empty.has(type)) continue;
      try {
        const result = await runGscQuery(
          ctx,
          totalsRequest(type, start, finalThrough, "final"),
          { maxPages: GSC_TOTALS_MAX_PAGES },
        );
        // Satırsız tür sıfırla doldurulmaz (çoğu mülkte news/discover yok).
        if (result.rows.length > 0) {
          await writeDailyTotals(
            ctx,
            type,
            dayMetrics(finalDays, metricsByDay(result.rows)).map((row) => ({
              ...row,
              fresh: false,
            })),
          );
        }
      } catch (error) {
        // Mülk bu türü desteklemiyor: boş tür gibi ayda bir yoklanır.
        if (!isGscValidationError(error)) throw error;
        ctx.searchTypes.empty.add(type);
        await saveSearchTypes(ctx);
      }
    }

    // (3) Marka serisi (Google tarafında regex süzgeci).
    const current = parseGscBackfillState(ctx.link.backfill);
    if (ctx.brand?.regex && !isBrandErrorHash(current?.brandHash)) {
      try {
        const result = await runGscQuery(
          ctx,
          brandTotalsRequest(ctx.brand.regex, start, finalThrough),
          { maxPages: GSC_TOTALS_MAX_PAGES },
        );
        await writeBrandSeries(
          ctx,
          dayMetrics(finalDays, metricsByDay(result.rows)),
        );
      } catch (error) {
        if (!isGscValidationError(error)) throw error;
        await markBrandError(ctx, current);
      }
    }

    // (4) Kırılımlar: ülke, cihaz, arama görünümü.
    for (const kind of GSC_SLICE_KINDS) {
      if (ctx.searchTypes.disabledSlices.has(kind)) continue;
      if (kind === "appearance" && ctx.searchTypes.appearancePerDay) continue;
      try {
        const result = await runGscQuery(
          ctx,
          sliceRequest(kind, start, finalThrough),
          { maxPages: GSC_SLICE_MAX_PAGES },
        );
        await writeSlices(ctx, kind, finalDays, result.rows, result.truncated);
      } catch (error) {
        if (!isGscValidationError(error)) throw error;
        await disableSlice(ctx, kind);
      }
    }
    if (
      ctx.searchTypes.appearancePerDay &&
      !ctx.searchTypes.disabledSlices.has("appearance")
    ) {
      await syncAppearanceDays(ctx, start, finalThrough);
    }
  }

  // (5) Pencere tamamlandı.
  ctx.link = await prisma.gscSiteLink.update({
    where: { id: ctx.link.id },
    data: {
      lastDailyAt: ctx.now,
      lastDailySlot: dailySlot(ctx.now),
      lastFreshAt: ctx.now,
      searchTypes: serializeSearchTypes(ctx.searchTypes, ctx.now),
    },
  });
}
