import "server-only";

import {
  GSC_PERIOD_MAX_PAGES,
  GSC_TOTALS_MAX_PAGES,
  periodRequest,
  totalsRequest,
  type GscPeriodKey,
} from "@/lib/seo/catalog";
import {
  firstMonthStartOnOrAfter,
  googleWindowStart,
  monthEnd,
} from "@/lib/seo/dates";
import { pendingMonths } from "@/lib/seo/schedule";
import { prisma } from "@/lib/prisma";
import { isGscValidationError } from "@/server/integrations/search-console/errors";

import { saveSearchTypes, type GscSyncContext } from "./context";
import { runGscQuery } from "./requests";
import { hasPeriodFetch, writePeriod } from "./write";

// Aylık özetler (docs/google-search-console-plan.md §3.4, §4): kesin veri ay
// sonunu geçince ayın sorgu ve sayfa özetleri çekilir (yalnız web; en çok 31
// gün, ağır değil). Arşiv açıkken kalıcıdır. Ayda bir, boş sayılan isteğe
// bağlı türler biten ay üzerinden yeniden yoklanır: satır gelirse günlük
// aşama onları yeniden çeker (geri doldurma anahtarı kapalı kalır).

export const GSC_MONTHLY_KEYS: readonly GscPeriodKey[] = ["query", "page"];

// Ayın eksik anahtarlarını çeker (yeniden başlatılabilir).
export async function fetchMonth(
  ctx: GscSyncContext,
  month: string,
): Promise<void> {
  for (const key of GSC_MONTHLY_KEYS) {
    if (await hasPeriodFetch(ctx.link.id, "MONTH", month, key)) continue;
    const result = await runGscQuery(
      ctx,
      periodRequest(key, month, monthEnd(month)),
      { maxPages: GSC_PERIOD_MAX_PAGES[key] },
    );
    await writePeriod(ctx, "MONTH", month, key, result);
  }
}

async function reprobeEmptyTypes(
  ctx: GscSyncContext,
  month: string,
): Promise<void> {
  if (ctx.searchTypes.empty.size === 0) return;
  let changed = false;
  for (const type of [...ctx.searchTypes.empty]) {
    if (ctx.requestsLeft < 1) break;
    const result = await runGscQuery(
      ctx,
      totalsRequest(type, month, monthEnd(month), "final"),
      { maxPages: GSC_TOTALS_MAX_PAGES },
    ).catch((error: unknown) => {
      if (isGscValidationError(error)) return null;
      throw error;
    });
    if (result && result.rows.length > 0) {
      ctx.searchTypes.empty.delete(type);
      changed = true;
    }
  }
  if (changed) await saveSearchTypes(ctx);
}

export async function syncMonthly(ctx: GscSyncContext): Promise<void> {
  const finalThrough = ctx.link.lastFinalDate;
  if (!finalThrough) return;
  const months = pendingMonths({
    lastMonthlyMonth: ctx.link.lastMonthlyMonth,
    finalThrough,
    floor: firstMonthStartOnOrAfter(googleWindowStart(ctx.today)),
  });
  let finished: string | null = null;
  for (const month of months) {
    if (ctx.requestsLeft < 1) break;
    await fetchMonth(ctx, month);
    ctx.link = await prisma.gscSiteLink.update({
      where: { id: ctx.link.id },
      data: { lastMonthlyMonth: month },
    });
    finished = month;
  }
  if (finished) await reprobeEmptyTypes(ctx, finished);
}
