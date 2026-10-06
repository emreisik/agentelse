import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import {
  GA_MAX_CONCURRENT,
  countServerError,
  gaQuotaDecision,
  nextHour,
  nextQuotaDay,
  serverErrorBudgetSpent,
  type GaLane,
} from "@/lib/website-analytics/governor";
import type {
  GaParsedReport,
  GaPropertyQuota,
} from "@/lib/website-analytics/response";
import {
  GA_BATCH_SIZE,
  runGaReport,
  runGaReportBatch,
} from "@/server/integrations/google-analytics/data-api";
import { GoogleApiError } from "@/server/integrations/google/errors";

import type { GaSyncContext } from "./context";

// Rapor isteklerinin kota yöneticisi altında yürütülmesi
// (docs/google-analytics-plan.md §3.3 "Kota yöneticisi"): her toplu çağrıdan
// önce saatlik/günlük pay ve sunucu hatası sayacı sınanır; yanıttaki
// propertyQuota aynı mülkün bütün bağlarına yazılır (tek kova). Geçersiz
// rapor (400) bütün toplu çağrıyı düşürdüğü için istekler tek tek yeniden
// denenir ve yalnız bozuk olan "geçersiz" döner.

// Kota payı yetmedi: iş `retryAt`'e kadar bekler (hata sayılmaz).
export class GaQuotaDeferred extends Error {
  constructor(
    readonly retryAt: Date,
    readonly reason: string,
  ) {
    super(`Google Analytics quota: waiting until ${retryAt.toISOString()}`);
    this.name = "GaQuotaDeferred";
  }
}

export type GaRequestOutcome =
  { ok: true; report: GaParsedReport } | { ok: false; error: GoogleApiError };

// Süreç içi eşzamanlılık: mülk başına en çok GA_MAX_CONCURRENT istek.
const inFlight = new Map<string, number>();

async function withSlot<T>(propertyId: string, run: () => Promise<T>) {
  const busy = inFlight.get(propertyId) ?? 0;
  if (busy >= GA_MAX_CONCURRENT) {
    throw new GaQuotaDeferred(new Date(Date.now() + 60_000), "CONCURRENCY");
  }
  inFlight.set(propertyId, busy + 1);
  try {
    return await run();
  } finally {
    const left = (inFlight.get(propertyId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(propertyId);
    else inFlight.set(propertyId, left);
  }
}

function assertBudget(ctx: GaSyncContext, lane: GaLane): void {
  const decision = gaQuotaDecision({
    lane,
    now: ctx.now,
    stored: ctx.quota,
    rateLimitedUntil: ctx.rateLimitedUntil,
  });
  if (!decision.ok)
    throw new GaQuotaDeferred(decision.retryAt, decision.reason);
  if (serverErrorBudgetSpent(ctx.serverErrors, lane, ctx.now)) {
    throw new GaQuotaDeferred(nextHour(ctx.now), "SERVER_ERRORS");
  }
}

async function recordQuota(
  ctx: GaSyncContext,
  quota: GaPropertyQuota | null,
): Promise<void> {
  if (!quota) return;
  ctx.quota = { at: ctx.now.toISOString(), quota };
  await prisma.gaPropertyLink.updateMany({
    where: { propertyId: ctx.link.propertyId },
    data: { lastQuota: ctx.quota as unknown as Prisma.InputJsonValue },
  });
}

// Google'ın kendi arızası ve kota hataları mülk kovasına işlenir.
async function recordFailure(
  ctx: GaSyncContext,
  error: GoogleApiError,
): Promise<void> {
  if (error.errorClass === "SERVER_ERROR") {
    ctx.serverErrors = countServerError(ctx.serverErrors, ctx.now);
    await prisma.gaPropertyLink.updateMany({
      where: { propertyId: ctx.link.propertyId },
      data: {
        serverErrorsHour: ctx.serverErrors as unknown as Prisma.InputJsonValue,
      },
    });
    return;
  }
  if (error.errorClass === "RATE_LIMIT" || error.errorClass === "QUOTA_DAILY") {
    const now = ctx.now;
    ctx.rateLimitedUntil =
      error.errorClass === "QUOTA_DAILY"
        ? nextQuotaDay(now)
        : new Date(now.getTime() + (error.retryAfterMs ?? 15 * 60_000));
    await prisma.gaPropertyLink.updateMany({
      where: { propertyId: ctx.link.propertyId },
      data: { rateLimitedUntil: ctx.rateLimitedUntil },
    });
  }
}

function isInvalid(error: unknown): error is GoogleApiError {
  return error instanceof GoogleApiError && error.errorClass === "VALIDATION";
}

async function runSingle(
  ctx: GaSyncContext,
  request: GaRunReportRequest,
): Promise<GaRequestOutcome> {
  try {
    const report = await withSlot(ctx.link.propertyId, () =>
      runGaReport(ctx.accessToken, ctx.link.propertyId, request),
    );
    await recordQuota(ctx, report.propertyQuota);
    return { ok: true, report };
  } catch (error) {
    if (isInvalid(error)) return { ok: false, error };
    if (error instanceof GoogleApiError) await recordFailure(ctx, error);
    throw error;
  }
}

// İstekler sırasıyla, 5'erli toplu çağrılarla. Kota yetmezse GaQuotaDeferred,
// diğer Google hataları olduğu gibi yükselir.
export async function runGaRequests(
  ctx: GaSyncContext,
  requests: GaRunReportRequest[],
  lane: GaLane = ctx.lane,
): Promise<GaRequestOutcome[]> {
  const outcomes: GaRequestOutcome[] = [];
  for (let at = 0; at < requests.length; at += GA_BATCH_SIZE) {
    const batch = requests.slice(at, at + GA_BATCH_SIZE);
    assertBudget(ctx, lane);
    if (batch.length === 1) {
      outcomes.push(await runSingle(ctx, batch[0]!));
      continue;
    }
    try {
      const reports = await withSlot(ctx.link.propertyId, () =>
        runGaReportBatch(ctx.accessToken, ctx.link.propertyId, batch),
      );
      await recordQuota(ctx, reports.at(-1)?.propertyQuota ?? null);
      outcomes.push(
        ...reports.map((report) => ({ ok: true as const, report })),
      );
    } catch (error) {
      if (!isInvalid(error)) {
        if (error instanceof GoogleApiError) await recordFailure(ctx, error);
        throw error;
      }
      for (const request of batch) {
        assertBudget(ctx, lane);
        outcomes.push(await runSingle(ctx, request));
      }
    }
  }
  return outcomes;
}
