import "server-only";

import type { Prisma } from "@prisma/client";

import {
  initialGscBackfill,
  parseGscBackfillState,
  queueHeavy,
} from "@/lib/seo/backfill";
import {
  GSC_PERIOD_KEYS,
  GSC_PERIOD_MAX_PAGES,
  periodRequest,
} from "@/lib/seo/catalog";
import {
  firstWeekStartOnOrAfter,
  googleWindowStart,
  weekEndOf,
} from "@/lib/seo/dates";
import { heavyBlocked } from "@/lib/seo/governor";
import { pendingWeeks } from "@/lib/seo/schedule";
import { prisma } from "@/lib/prisma";

import type { GscSyncContext } from "./context";
import { runGscQuery } from "./requests";
import { hasPeriodFetch, writePeriod } from "./write";

// Haftalık özetler (docs/google-search-console-plan.md §3.4): kesin veri bir
// Pazar'ı geçince o Pazartesi–Pazar haftasının sorgu, sayfa ve sorgu×sayfa
// özetleri çekilir (yalnız web). Bekleyen her hafta yürünür; bu yüzden
// haftalarda boşluk olmaz. Çekilen (hafta, anahtar) çiftleri GscPeriodFetch'te
// işaretlidir: bütçe yarıda biterse kalan anahtarlar sonraki turda çekilir.
// Sorgu×sayfa ağırdır; ağır blok sürerken geri doldurmanın kuyruğuna girer.

async function queueHeavyWeek(ctx: GscSyncContext, week: string) {
  const finalThrough = ctx.link.lastFinalDate ?? week;
  const state =
    parseGscBackfillState(ctx.link.backfill) ??
    initialGscBackfill({
      today: ctx.today,
      finalThrough,
      lastWeeklyWeek: ctx.link.lastWeeklyWeek,
      lastMonthlyMonth: ctx.link.lastMonthlyMonth,
      brandHash: ctx.brand?.hash ?? null,
      now: ctx.now,
    });
  ctx.link = await prisma.gscSiteLink.update({
    where: { id: ctx.link.id },
    data: {
      backfill: queueHeavy(state, week) as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function syncWeekly(ctx: GscSyncContext): Promise<void> {
  const finalThrough = ctx.link.lastFinalDate;
  if (!finalThrough) return;
  const weeks = pendingWeeks({
    lastWeeklyWeek: ctx.link.lastWeeklyWeek,
    finalThrough,
    floor: firstWeekStartOnOrAfter(googleWindowStart(ctx.today)),
  });
  for (const week of weeks) {
    if (ctx.requestsLeft < 1) return;
    for (const key of GSC_PERIOD_KEYS) {
      if (await hasPeriodFetch(ctx.link.id, "WEEK", week, key)) continue;
      if (key === "query_page" && heavyBlocked(ctx.quota, new Date())) {
        await queueHeavyWeek(ctx, week);
        continue;
      }
      const result = await runGscQuery(
        ctx,
        periodRequest(key, week, weekEndOf(week)),
        { maxPages: GSC_PERIOD_MAX_PAGES[key] },
      );
      await writePeriod(ctx, "WEEK", week, key, result);
    }
    ctx.link = await prisma.gscSiteLink.update({
      where: { id: ctx.link.id },
      data: { lastWeeklyWeek: week },
    });
  }
}
