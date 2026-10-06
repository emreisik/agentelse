import "server-only";

import type { Prisma } from "@prisma/client";

import { isHeavyRequest, type GscQueryRequest } from "@/lib/seo/catalog";
import {
  GSC_MAX_CONCURRENT,
  applyQuotaError,
  createMinuteLimiter,
  gscQuotaDecision,
} from "@/lib/seo/governor";
import { prisma } from "@/lib/prisma";
import { gscQuotaKind } from "@/server/integrations/search-console/errors";
import {
  gscMockMode,
  querySearchAnalyticsPaged,
  type GscPagedResult,
} from "@/server/integrations/search-console/search-analytics";
import { GoogleApiError } from "@/server/integrations/google/errors";

import type { GscSyncContext } from "./context";

// Search Console isteklerinin kota yöneticisi altında yürütülmesi
// (docs/google-search-console-plan.md §3.3 "Kota yöneticisi";
// docs/search-analytics.md): her sayfa isteğinden önce turun bütçesi ve
// süresi, kota kararı (RATE > LOAD > HEAVY) ve site başına dakikalık sınır
// sınanır. Kota hataları aynı sitenin aynı kipteki birincil bağlarına yazılır
// (birincilliğini kaybetmiş bağlara asla: yazım onları canlı tutmasın).

// Kota payı yok: iş `retryAt`'e kadar bekler (hata sayılmaz).
export class GscQuotaDeferred extends Error {
  constructor(
    readonly retryAt: Date,
    readonly reason: "RATE" | "LOAD" | "HEAVY" | "CONCURRENCY",
  ) {
    super(`Search Console quota: waiting until ${retryAt.toISOString()}`);
    this.name = "GscQuotaDeferred";
  }
}

// Turun istek bütçesi ya da süresi bitti: iş yumuşakça durur, kalan sonraki
// tura kalır (hata değil).
export class GscRunBudgetSpent extends Error {
  constructor() {
    super("Search Console run budget spent");
    this.name = "GscRunBudgetSpent";
  }
}

// Süreç içi sınırlar: site başına dakikada en çok 30 istek ve en çok 2
// eşzamanlı istek. Birden çok süreçte kısa süre aşılabilir; Google'ın site
// başına dakikalık sınırının çok altındadır.
const limiter = createMinuteLimiter();
const inFlight = new Map<string, number>();

async function withSlot<T>(siteUrl: string, run: () => Promise<T>) {
  const busy = inFlight.get(siteUrl) ?? 0;
  if (busy >= GSC_MAX_CONCURRENT) {
    throw new GscQuotaDeferred(new Date(Date.now() + 60_000), "CONCURRENCY");
  }
  inFlight.set(siteUrl, busy + 1);
  try {
    return await run();
  } finally {
    const left = (inFlight.get(siteUrl) ?? 1) - 1;
    if (left <= 0) inFlight.delete(siteUrl);
    else inFlight.set(siteUrl, left);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// Her Google isteğinden hemen önce (sayfa sayfa).
async function beforeRequest(
  ctx: GscSyncContext,
  heavy: boolean,
): Promise<void> {
  if (ctx.requestsLeft <= 0 || Date.now() >= ctx.deadline) {
    throw new GscRunBudgetSpent();
  }
  const decision = gscQuotaDecision({
    heavy,
    now: new Date(),
    state: ctx.quota,
  });
  if (!decision.ok)
    throw new GscQuotaDeferred(decision.retryAt, decision.reason);
  if (!gscMockMode()) {
    for (;;) {
      const taken = limiter.take(ctx.link.siteUrl, Date.now());
      if (taken.ok) break;
      // Dakikalık pay süre dolmadan açılıyorsa beklenir; açılmıyorsa tur
      // yumuşakça biter.
      if (taken.retryAt >= ctx.deadline) throw new GscRunBudgetSpent();
      await sleep(taken.retryAt - Date.now());
    }
  }
  ctx.requestsLeft -= 1;
}

// Kota hatası: durum güncellenir ve sitenin birincil bağlarına yazılır.
async function recordQuotaError(
  ctx: GscSyncContext,
  error: unknown,
): Promise<void> {
  const kind = gscQuotaKind(error);
  if (!kind) return;
  ctx.quota = applyQuotaError({
    kind,
    state: ctx.quota,
    now: new Date(),
    retryAfterMs:
      error instanceof GoogleApiError ? error.retryAfterMs : undefined,
  });
  await prisma.gscSiteLink.updateMany({
    where: {
      siteUrl: ctx.link.siteUrl,
      isPrimary: true,
      isMock: ctx.link.isMock,
    },
    data: {
      rateLimitedUntil: ctx.quota.rateLimitedUntil,
      loadLimitedUntil: ctx.quota.loadLimitedUntil,
      heavyLimitedUntil: ctx.quota.heavyLimitedUntil,
      loadErrors: (ctx.quota.loadErrors ??
        null) as unknown as Prisma.InputJsonValue,
    },
  });
}

// Search Analytics sorgusu (sayfalı). Bütçe/süre bitince GscRunBudgetSpent,
// kota yoksa GscQuotaDeferred; Google hataları (kota hataları kaydedildikten
// sonra) olduğu gibi yükselir.
export async function runGscQuery(
  ctx: GscSyncContext,
  request: GscQueryRequest,
  options: { maxPages: number },
): Promise<GscPagedResult> {
  const heavy = isHeavyRequest(request);
  try {
    return await withSlot(ctx.link.siteUrl, () =>
      querySearchAnalyticsPaged(ctx.accessToken, ctx.link.siteUrl, request, {
        maxPages: options.maxPages,
        beforePage: () => beforeRequest(ctx, heavy),
      }),
    );
  } catch (error) {
    await recordQuotaError(ctx, error);
    throw error;
  }
}

// Tek basit çağrı (sites.get): bütçe, kota kararı ve dakikalık sınır; ağır
// sayılmaz.
export async function runGscSimple<T>(
  ctx: GscSyncContext,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withSlot(ctx.link.siteUrl, async () => {
      await beforeRequest(ctx, false);
      return fn();
    });
  } catch (error) {
    await recordQuotaError(ctx, error);
    throw error;
  }
}
