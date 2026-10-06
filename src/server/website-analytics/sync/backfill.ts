import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  TOTALS_KEY,
  advanceBackfill,
  backfillComplete,
  initialBackfill,
  nextBackfillChunks,
  parseBackfillState,
  type GaBackfillState,
} from "@/lib/website-analytics/backfill";
import {
  gaReportSpec,
  sliceRequest,
  totalsRequest,
} from "@/lib/website-analytics/catalog";

import type { GaSyncContext } from "./context";
import { disableReport } from "./daily";
import { runGaRequests } from "./requests";
import { gaPropertyCreatedDay } from "./weekly";
import { dayList, writeSlices, writeTotals } from "./write";

// Geri doldurma (docs/google-analytics-plan.md §3.3): bağlanınca bir kez,
// arka plan şeridinde ve kota yöneticisinin geri doldurma payıyla (saatlik
// payın yarısı). Tur başına en çok MAX_REQUESTS_PER_RUN istek; kota yetmezse
// GaQuotaDeferred yükselir ve kalan iş sonraki saate kalır. Doldurulan günler
// revizyon penceresinin dışındadır: hepsi kesindir.

const MAX_REQUESTS_PER_RUN = 10;

async function saveState(
  ctx: GaSyncContext,
  state: GaBackfillState,
  done: boolean,
): Promise<void> {
  const next = done ? { ...state, doneAt: ctx.now.toISOString() } : state;
  // Var olan JSON'a birleşir: eklenti durumu (`addons`) korunur.
  const existing =
    ctx.link.backfill &&
    typeof ctx.link.backfill === "object" &&
    !Array.isArray(ctx.link.backfill)
      ? (ctx.link.backfill as Record<string, unknown>)
      : {};
  ctx.link = await prisma.gaPropertyLink.update({
    where: { id: ctx.link.id },
    data: {
      backfill: { ...existing, ...next } as unknown as Prisma.InputJsonValue,
      ...(done ? { backfillDoneAt: ctx.now } : {}),
    },
  });
}

export async function syncBackfill(ctx: GaSyncContext): Promise<boolean> {
  let state =
    parseBackfillState(ctx.link.backfill) ??
    initialBackfill({
      today: ctx.today,
      propertyCreated: gaPropertyCreatedDay(ctx),
      now: ctx.now,
    });

  let budget = MAX_REQUESTS_PER_RUN;
  let done = false;
  try {
    while (budget > 0) {
      const chunks = nextBackfillChunks(
        state,
        Math.min(5, budget),
        ctx.disabled,
      );
      if (chunks.length === 0) break;
      const requests = chunks.map((chunk) => {
        if (chunk.key === TOTALS_KEY)
          return totalsRequest(chunk.start, chunk.end);
        return sliceRequest(gaReportSpec(chunk.key)!, chunk.start, chunk.end);
      });
      const outcomes = await runGaRequests(ctx, requests, "P2_BACKFILL");
      for (const [index, chunk] of chunks.entries()) {
        const outcome = outcomes[index];
        if (!outcome) continue;
        if (!outcome.ok) {
          if (chunk.key === TOTALS_KEY) throw outcome.error;
          await disableReport(ctx, chunk.key, outcome.error);
          continue;
        }
        if (chunk.key === TOTALS_KEY) {
          // Doldurulan aralığın son günü dün değildir: satırı yoksa sıfırdır.
          await writeTotals(ctx, outcome.report, {
            start: chunk.start,
            end: chunk.end,
            finalThrough: chunk.end,
            pendingEnd: false,
          });
        } else {
          await writeSlices(
            ctx,
            gaReportSpec(chunk.key)!,
            outcome.report,
            dayList(chunk.start, chunk.end),
            chunk.end,
          );
        }
        state = advanceBackfill(state, chunk);
      }
      budget -= chunks.length;
    }
    done = backfillComplete(state, ctx.disabled);
  } finally {
    // Kota bekletse ya da bir istek düşse de ilerleme kaybolmaz.
    await saveState(ctx, state, done);
  }
  return done;
}
