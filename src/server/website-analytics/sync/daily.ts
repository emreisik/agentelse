import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { TOTALS_KEY } from "@/lib/website-analytics/backfill";
import {
  GA_OPTIONAL_DAILY_REPORTS,
  GA_REPORTS,
  GA_TOTALS_SCHEDULE,
  ROLLING_USERS_KEY,
  gaReportSpec,
  rollingUsersRequest,
  sliceRequest,
  totalsRequest,
  type GaRunReportRequest,
} from "@/lib/website-analytics/catalog";
import {
  gaOptionalReportEnabled,
  withDisabledReport,
} from "@/lib/website-analytics/catalog-state";
import { addDays } from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import { finalThrough } from "@/lib/website-analytics/schedule";
import type { GoogleApiError } from "@/server/integrations/google/errors";

import type { GaSyncContext } from "./context";
import { runGaRequests } from "./requests";
import { dayList, writeRollingUsers, writeSlices, writeTotals } from "./write";

// Günlük çekim + revizyon (docs/google-analytics-plan.md §3.3): dünkü gün ve
// geriye doğru revizyon penceresi (D-1…D-7; atıf D-1…D-13) aynı istekle
// yeniden çekilir. ~12 istek, 3 toplu çağrı. Pencereden çıkan gün kesinleşir.

type Planned = { key: string; start: string; request: GaRunReportRequest };

// Geçersiz rapor (Google 400: alan kaldırılmış, mülkte yok) katalogdan düşer;
// diğerleri çalışmaya devam eder.
export async function disableReport(
  ctx: GaSyncContext,
  key: string,
  error: GoogleApiError,
): Promise<void> {
  ctx.disabled.add(key);
  // Saklanan biçim korunur (v1 düz harita ya da katalog denetiminin v2'si).
  const catalog = withDisabledReport(
    ctx.link.catalog,
    key,
    error.message.slice(0, 300),
    ctx.now.toISOString(),
  );
  ctx.link = await prisma.gaPropertyLink.update({
    where: { id: ctx.link.id },
    data: { catalog: catalog as Prisma.InputJsonValue },
  });
  console.warn(
    `[ga-sync] report ${key} dropped for property ${ctx.link.propertyId}: ${error.message}`,
  );
}

// Katalog denetiminin açtığı isteğe bağlı günlük raporlar (google_ads).
function optionalDailyReports(ctx: GaSyncContext) {
  if (!GaFlags.catalogChecks()) return [];
  return GA_OPTIONAL_DAILY_REPORTS.filter(
    (spec) =>
      spec.key === "google_ads" &&
      gaOptionalReportEnabled(ctx.link.catalog, "google_ads") &&
      !ctx.disabled.has(spec.key),
  );
}

export async function syncDaily(
  ctx: GaSyncContext,
): Promise<{ yesterdayIn: boolean }> {
  const end = addDays(ctx.today, -1);
  const plans: Planned[] = [];
  const totalsStart = addDays(ctx.today, -GA_TOTALS_SCHEDULE.revisionDays);
  plans.push({
    key: TOTALS_KEY,
    start: totalsStart,
    request: totalsRequest(totalsStart, end),
  });
  for (const spec of [...GA_REPORTS, ...optionalDailyReports(ctx)]) {
    if (ctx.disabled.has(spec.key)) continue;
    const start = addDays(ctx.today, -spec.revisionDays);
    plans.push({
      key: spec.key,
      start,
      request: sliceRequest(spec, start, end),
    });
  }
  plans.push({
    key: ROLLING_USERS_KEY,
    start: end,
    request: rollingUsersRequest(end),
  });

  const outcomes = await runGaRequests(
    ctx,
    plans.map((plan) => plan.request),
  );

  // Önce toplamlar: dünün verisi geldi mi, diğer raporlar buna göre yazılır.
  const totalsOutcome = outcomes[0];
  if (!totalsOutcome?.ok) {
    throw totalsOutcome?.error ?? new Error("GA totals report missing");
  }
  const yesterdayIn = await writeTotals(ctx, totalsOutcome.report, {
    start: totalsStart,
    end,
    finalThrough: finalThrough(ctx.today, GA_TOTALS_SCHEDULE.revisionDays),
    pendingEnd: true,
  });
  const lastDay = yesterdayIn ? end : addDays(end, -1);

  for (let index = 1; index < plans.length; index += 1) {
    const plan = plans[index]!;
    const outcome = outcomes[index];
    if (!outcome) continue;
    if (!outcome.ok) {
      if (plan.key !== ROLLING_USERS_KEY) {
        await disableReport(ctx, plan.key, outcome.error);
      }
      continue;
    }
    if (plan.key === ROLLING_USERS_KEY) {
      if (yesterdayIn) await writeRollingUsers(ctx, outcome.report, end);
      continue;
    }
    const spec = gaReportSpec(plan.key);
    if (!spec) continue;
    await writeSlices(
      ctx,
      spec,
      outcome.report,
      dayList(plan.start, lastDay),
      finalThrough(ctx.today, spec.revisionDays),
    );
  }
  return { yesterdayIn };
}

// Revizyon penceresinden çıkan günler kesinleşir.
export async function finalizeDays(ctx: GaSyncContext): Promise<void> {
  const totalsFinal = finalThrough(ctx.today, GA_TOTALS_SCHEDULE.revisionDays);
  await prisma.gaDailyTotal.updateMany({
    where: {
      linkId: ctx.link.id,
      isFinal: false,
      date: { lte: new Date(`${totalsFinal}T00:00:00.000Z`) },
    },
    data: { isFinal: true },
  });
  const byWindow = new Map<number, string[]>();
  for (const spec of [...GA_REPORTS, ...optionalDailyReports(ctx)]) {
    byWindow.set(spec.revisionDays, [
      ...(byWindow.get(spec.revisionDays) ?? []),
      spec.key,
    ]);
  }
  for (const [revisionDays, keys] of byWindow) {
    await prisma.gaReportSlice.updateMany({
      where: {
        linkId: ctx.link.id,
        isFinal: false,
        reportKey: { in: keys },
        periodStart: {
          lte: new Date(
            `${finalThrough(ctx.today, revisionDays)}T00:00:00.000Z`,
          ),
        },
      },
      data: { isFinal: true },
    });
  }
}
