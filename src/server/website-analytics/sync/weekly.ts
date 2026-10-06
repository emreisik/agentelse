import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  activeAddonKeys,
  advanceAddon,
  ensureAddonKeys,
  nextAddonChunks,
  readAddonState,
  writeAddonState,
  type GaAddonChunk,
} from "@/lib/website-analytics/addon-backfill";
import {
  gaReportSpec,
  sliceRequest,
  type GaRunReportRequest,
} from "@/lib/website-analytics/catalog";
import { gaOptionalReportEnabled } from "@/lib/website-analytics/catalog-state";
import { GaFlags } from "@/lib/website-analytics/flags";
import type { GaParsedReport } from "@/lib/website-analytics/response";
import {
  GA_WINDOW_REPORTS,
  gaWeeklySpec,
  weeklyDisableKey,
  weeklySliceRequest,
  windowRequest,
} from "@/lib/website-analytics/weekly";
import { mondaysBetween } from "@/lib/website-analytics/weeks";

import type { GaSyncContext } from "./context";
import { disableReport } from "./daily";
import { runGaRequests } from "./requests";
import {
  dayList,
  writeSlices,
  writeWeekSlices,
  writeWindowSlice,
} from "./write";

// Eklenti aşaması (docs/google-analytics-plan.md §3.3, §5; GA-F2 bölüm 2):
// haftalık dilimler (GA_WEEKLY), google_ads geçmişi ve search_console
// penceresi (GA_CATALOG_CHECKS). Yalnız temel geri doldurma bittikten sonra
// çalışır (aynı turu paylaşmazlar; tur bugünkü en kötü biçimde kalır). Tur
// başına en çok MAX_REQUESTS_PER_RUN istek; önce yeni kesinleşen haftalar
// (P2), sonra geçmiş (P2_BACKFILL). Kota yetmezse GaQuotaDeferred yükselir,
// ilerleme yine kaydedilir.

const MAX_REQUESTS_PER_RUN = 10;

// Mülkün oluşturulduğu gün (mülk saatiyle); ondan önce veri yoktur.
export function gaPropertyCreatedDay(ctx: GaSyncContext): string | null {
  return ctx.link.propertyCreatedAt
    ? dayKeyInTimezone(ctx.link.propertyCreatedAt, ctx.timeZone)
    : null;
}

// Senkron turu ve runner aynı anahtar listesini kullanır.
export function gaActiveAddonKeys(
  catalog: unknown,
  disabled: ReadonlySet<string>,
): string[] {
  const optional = GaFlags.catalogChecks();
  return activeAddonKeys({
    weekly: GaFlags.weekly(),
    googleAds: optional && gaOptionalReportEnabled(catalog, "google_ads"),
    searchConsole:
      optional && gaOptionalReportEnabled(catalog, "search_console"),
    disabled,
  });
}

function requestFor(chunk: GaAddonChunk): GaRunReportRequest | null {
  if (chunk.kind === "week") {
    const spec = gaWeeklySpec(chunk.reportKey);
    return spec ? weeklySliceRequest(spec, chunk.start, chunk.end) : null;
  }
  if (chunk.kind === "day") {
    const spec = gaReportSpec(chunk.reportKey);
    return spec ? sliceRequest(spec, chunk.start, chunk.end) : null;
  }
  const spec = GA_WINDOW_REPORTS.find((item) => item.key === chunk.reportKey);
  return spec ? windowRequest(spec, chunk.start) : null;
}

function disableKeyFor(chunk: GaAddonChunk): string {
  if (chunk.kind === "week") {
    const spec = gaWeeklySpec(chunk.reportKey);
    return spec ? weeklyDisableKey(spec) : chunk.reportKey;
  }
  return chunk.reportKey;
}

async function writeChunk(
  ctx: GaSyncContext,
  chunk: GaAddonChunk,
  report: GaParsedReport,
): Promise<void> {
  if (chunk.kind === "week") {
    const spec = gaWeeklySpec(chunk.reportKey);
    if (spec) {
      await writeWeekSlices(
        ctx,
        spec,
        report,
        mondaysBetween(chunk.start, chunk.end),
      );
    }
    return;
  }
  if (chunk.kind === "day") {
    const spec = gaReportSpec(chunk.reportKey);
    // Doldurulan günler revizyon penceresinin dışındadır: hepsi kesindir.
    if (spec) {
      await writeSlices(
        ctx,
        spec,
        report,
        dayList(chunk.start, chunk.end),
        chunk.end,
      );
    }
    return;
  }
  const spec = GA_WINDOW_REPORTS.find((item) => item.key === chunk.reportKey);
  if (spec) await writeWindowSlice(ctx, spec, report, chunk.start);
}

export async function syncAddons(ctx: GaSyncContext): Promise<void> {
  let keys = gaActiveAddonKeys(ctx.link.catalog, ctx.disabled);
  if (keys.length === 0) return;
  let state = ensureAddonKeys(readAddonState(ctx.link.backfill), keys, {
    today: ctx.today,
    propertyCreated: gaPropertyCreatedDay(ctx),
  });

  let budget = MAX_REQUESTS_PER_RUN;
  try {
    while (budget > 0 && keys.length > 0) {
      const chunks = nextAddonChunks(
        state,
        keys,
        ctx.today,
        Math.min(5, budget),
      ).filter((chunk) => requestFor(chunk) !== null);
      if (chunks.length === 0) break;
      const outcomes = await runGaRequests(
        ctx,
        chunks.map((chunk) => requestFor(chunk)!),
        chunks[0]!.lane,
      );
      for (const [index, chunk] of chunks.entries()) {
        const outcome = outcomes[index];
        if (!outcome) continue;
        if (!outcome.ok) {
          // Durumu korunur; rapor yeniden açılırsa kaldığı yerden sürer.
          await disableReport(ctx, disableKeyFor(chunk), outcome.error);
          keys = keys.filter((key) => key !== chunk.key);
          continue;
        }
        await writeChunk(ctx, chunk, outcome.report);
        state = advanceAddon(state, chunk, ctx.now);
      }
      budget -= chunks.length;
    }
  } finally {
    // Kota bekletse ya da bir istek düşse de ilerleme kaybolmaz.
    ctx.link = await prisma.gaPropertyLink.update({
      where: { id: ctx.link.id },
      data: {
        backfill: writeAddonState(
          ctx.link.backfill,
          state,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
