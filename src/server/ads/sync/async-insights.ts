import "server-only";

import { Prisma } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import {
  dailyRowFrom,
  type DailyRow,
  type RawDailyInsight,
} from "@/lib/ads/insight-rows";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import {
  readAsyncReportRows,
  readAsyncReportStatus,
  startAsyncInsights,
} from "@/server/integrations/meta/sync-reads";

import type { SyncContext } from "./context";
import { syncContextFor } from "./context-for";
import { upsertDailyRows } from "./insights";

// Async insights (docs/meta-ads-plan.md §3.1, F8, META_ADS_AGENCY): reklam
// düzeyi liste okuması "çok fazla veri" hatası verince rapor Meta'da arka
// planda hazırlanır. report_run_id hesabın durumunda saklanır (30 gün
// geçerli); her tick hesap başına tek durum kontrolü yapılır, "Job Completed"
// olunca satırlar sayfa sayfa okunur, "Job Skipped" yeniden gönderilir. İşler
// hesap başına günlük sayaçla sınırlıdır: min(10, açık reklam sayısı); dolunca
// iş ertesi güne kalır ve bilgi uyarısı açılır.

const RUN_TTL_MS = 30 * 24 * 60 * 60_000;
const RUNS_PER_DAY = 10;

export type AsyncRun = {
  id: string;
  level: "ad";
  since: string;
  until: string;
  createdAt: string;
};

export type AsyncState = { day: string; started: number; runs: AsyncRun[] };

export function asyncStateOf(value: unknown): AsyncState {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<AsyncState>)
      : {};
  return {
    day: typeof record.day === "string" ? record.day : "",
    started: typeof record.started === "number" ? record.started : 0,
    runs: Array.isArray(record.runs)
      ? record.runs.filter(
          (run): run is AsyncRun =>
            Boolean(run) &&
            typeof run.id === "string" &&
            typeof run.since === "string",
        )
      : [],
  };
}

export function dailyRunCap(activeAds: number): number {
  return Math.min(RUNS_PER_DAY, Math.max(1, activeAds));
}

async function writeState(accountId: string, state: AsyncState): Promise<void> {
  await prisma.adsAccount.update({
    where: { id: accountId },
    data: {
      asyncInsights:
        state.runs.length === 0 && state.started === 0
          ? Prisma.DbNull
          : (state as unknown as Prisma.InputJsonValue),
    },
  });
}

async function rowsFor(ctx: SyncContext, raws: RawDailyInsight[]) {
  const mirror = await prisma.adsObject.findMany({
    where: { adsAccountId: ctx.account.id, level: { in: ["AD", "ADSET"] } },
    select: { externalId: true, resultActionType: true, projectId: true },
  });
  const byId = new Map(mirror.map((row) => [row.externalId, row]));
  const rows: (DailyRow & { projectId: string | null })[] = [];
  for (const raw of raws) {
    const object = raw.ad_id ? byId.get(raw.ad_id) : undefined;
    const parent = raw.adset_id ? byId.get(raw.adset_id) : undefined;
    const projectId =
      object?.projectId ?? parent?.projectId ?? ctx.primaryProjectId;
    const row = dailyRowFrom(raw, "AD", {
      currency: ctx.currency,
      resultActionType:
        object?.resultActionType ?? parent?.resultActionType ?? null,
    });
    if (row) rows.push({ ...row, projectId });
  }
  return rows;
}

export const AsyncInsights = {
  // Senkron okuma "çok fazla veri" verdi: aralık async rapor olarak kuyruğa.
  async enqueue(
    ctx: SyncContext,
    range: { since: string; until: string },
  ): Promise<boolean> {
    if (!AdsFlags.agency()) return false;
    const fresh = await prisma.adsAccount.findUnique({
      where: { id: ctx.account.id },
      select: { asyncInsights: true },
    });
    let state = asyncStateOf(fresh?.asyncInsights);
    if (state.day !== ctx.today)
      state = { day: ctx.today, started: 0, runs: state.runs };
    if (
      state.runs.some(
        (run) => run.since === range.since && run.until === range.until,
      )
    ) {
      return true;
    }
    const activeAds = await prisma.adsObject.count({
      where: {
        adsAccountId: ctx.account.id,
        level: "AD",
        effectiveStatus: "ACTIVE",
        goneAt: null,
      },
    });
    if (state.started >= dailyRunCap(activeAds)) {
      for (const project of ctx.projects) {
        await AdsAlerts.raise(
          {
            workspaceId: project.workspaceId,
            projectId: project.projectId,
            adsAccountId: ctx.account.id,
            externalId: ctx.externalId,
            kind: "ASYNC_INSIGHTS_DEFERRED",
            severity: "INFO",
            dedupeKey: `ASYNC_INSIGHTS_DEFERRED:${ctx.externalId}:${ctx.today}`,
            title: "Some ad-level numbers arrive tomorrow",
            detail:
              "This account is large, so Meta prepares its ad-level report in the background. Today's limit is used up; account and campaign totals are already current.",
          },
          ctx.now,
        );
      }
      return false;
    }
    const id = await startAsyncInsights({
      adAccountId: ctx.externalId,
      accessToken: ctx.accessToken,
      level: "ad",
      since: range.since,
      until: range.until,
    });
    state.started += 1;
    state.runs.push({
      id,
      level: "ad",
      since: range.since,
      until: range.until,
      createdAt: ctx.now.toISOString(),
    });
    await writeState(ctx.account.id, state);
    return true;
  },

  // Tick adımı: hesap başına en eski işin tek durum kontrolü.
  async runDue(now: Date = new Date(), limit = 5): Promise<number> {
    if (!AdsFlags.agency() || !AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    const accounts = await prisma.adsAccount.findMany({
      where: { platform: "META", asyncInsights: { not: Prisma.DbNull } },
      include: {
        projects: {
          where: { selected: true },
          select: { projectId: true, brandId: true },
        },
      },
      take: 50,
    });
    let handled = 0;
    for (const account of accounts) {
      if (handled >= limit) break;
      const state = asyncStateOf(account.asyncInsights);
      const run = state.runs[0];
      if (!run) continue;
      const ctx = await syncContextFor(account, now);
      if (!ctx) continue;
      handled += 1;
      if (now.getTime() - Date.parse(run.createdAt) > RUN_TTL_MS) {
        state.runs.shift();
        await writeState(account.id, state);
        continue;
      }
      try {
        await withMetaCallContext(
          {
            account: account.externalId,
            lane: "P2_BACKGROUND",
            callSite: "ads.async-insights",
          },
          async () => {
            const status = await readAsyncReportStatus(run.id, ctx.accessToken);
            if (status.status === "Job Completed") {
              const raws = await readAsyncReportRows(run.id, ctx.accessToken);
              await upsertDailyRows(
                ctx,
                await rowsFor(ctx, raws as RawDailyInsight[]),
              );
              state.runs.shift();
            } else if (status.status === "Job Skipped") {
              const id = await startAsyncInsights({
                adAccountId: account.externalId,
                accessToken: ctx.accessToken,
                level: "ad",
                since: run.since,
                until: run.until,
              });
              state.runs[0] = { ...run, id };
            } else if (status.status === "Job Failed") {
              console.error(
                `[ads-async-insights] ${account.externalId} report ${run.id} failed`,
              );
              state.runs.shift();
            }
          },
        );
        await writeState(account.id, state);
      } catch (error) {
        console.error(
          `[ads-async-insights] ${account.externalId} check failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return handled;
  },
};
