import "server-only";

import { randomUUID } from "node:crypto";

import type { GscSiteLink, Prisma, SeoReportState } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { addMonths, gscToday } from "@/lib/seo/dates";
import {
  gscGlobalWorkAllowedHere,
  gscRestrictedProjects,
  gscSyncAllowedFor,
} from "@/lib/seo/flags";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import { seoReportCard } from "@/lib/seo/reports/card";
import { SeoReportFlags, seoReportsActiveFor } from "@/lib/seo/reports/flags";
import { seoReportCommandId } from "@/lib/seo/reports/ids";
import {
  goalsDue,
  monthlyCandidate,
  monthlyDue,
  monthlyWaitUntil,
  pulseCandidate,
  reportBackoffMs,
  waitingFor,
  weeklyCandidate,
  weeklyDue,
  weeklyWaitUntil,
} from "@/lib/seo/reports/schedule";
import {
  monthLabel,
  periodLabel,
  seoReportReply,
  seoWorkSummary,
} from "@/lib/seo/reports/text";
import type {
  SeoReportKind,
  SeoReportSnapshot,
} from "@/lib/seo/reports/types";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { claimPeriodic } from "@/server/observability/periodic";
import { readEngineState } from "@/server/seo/opportunities/state";

import { commandExists, postSeoReportCard } from "./chat";
import { refreshSeoGoals } from "./goals";
import { reportContextForLink, type ReportLinkContext } from "./inputs";
import { buildMonthlyReport } from "./monthly";
import { writeSeoNarrative } from "./narrative";
import {
  buildPulseReport,
  type BuiltReport,
  type ReportSkip,
} from "./pulse";
import { buildRoadmapReport } from "./roadmap";
import {
  claimReportLease,
  ensureReportState,
  findSeoReport,
  insertSeoReport,
  releaseReportState,
} from "./store";
import { buildWeeklyReport } from "./weekly";

// SEO rapor çalıştırıcısı (docs/search-reports.md "Zamanlama"): `seo-reports`
// tick adımı. Birincil, verisi kesinleşmiş her bağ için 10 dakikalık kilit
// altında sırayla: hedef tazeleme, nabız, haftalık rapor, aylık rapor ve
// hemen ardından yol haritası. Rapor bir kez yazılır (SeoReport değişmez);
// komut kimliği bağ kimliğine bağlıdır, bu yüzden aynı dönem iki kez
// gönderilmez. Dönem kesinleşmediyse durum ilerlemez (sonraki turda yeniden
// denenir). Loga ve lastError'a yalnız hata adı girer, mesaj asla (hata
// mesajları Google metni taşıyabilir).

export const REPORTS_EVERY_MS = 600_000;
export const MAX_LINK_RUNS = 25;
export const RUN_DEADLINE_MS = 60_000;

const LINK_SCAN_LIMIT = 500;
const DEFAULT_LIMIT = 5;

export type SeoReportRunResult = {
  posted: SeoReportKind[];
  goals: number;
  skipped: { kind: SeoReportKind; reason: string }[];
  status: "ran" | "busy" | "not_allowed" | "no_data" | "failed";
};

function isBuilt(built: BuiltReport | ReportSkip): built is BuiltReport {
  return "snapshot" in built;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

// Bir rapor çalışmasının ortak bağlamı.
type RunEnv = {
  link: GscSiteLink;
  ctx: ReportLinkContext;
  now: Date;
  result: SeoReportRunResult;
};

function labelOf(snapshot: SeoReportSnapshot): string {
  return snapshot.kind === "MONTHLY" || snapshot.kind === "ROADMAP"
    ? monthLabel(snapshot.period.from)
    : periodLabel(snapshot.period.from, snapshot.period.to);
}

// Tek raporu teslim eder: (1) aynı dönem zaten yazılmış ve sohbete düşmüşse
// hiçbir şey yapmaz (LLM de yok), (2) yoksa anlatıyı yazıp raporu EKLER
// (değişmez satır), (3) sohbete işaret kartını yazar. Sahte bağ, geliştirme
// sürecinde canlı veritabanını paylaşırken yalnız saklanır; canlı projenin
// sohbetine kart yazılmaz.
async function deliver(
  env: RunEnv,
  kind: SeoReportKind,
  snapshot: SeoReportSnapshot,
): Promise<void> {
  const { link, ctx, now, result } = env;
  const periodKey = snapshot.periodKey;
  const existing = await findSeoReport(link.id, kind, periodKey);
  const commandId =
    existing?.commandId ?? seoReportCommandId(kind, link.id, periodKey);
  if (existing && (await commandExists(commandId))) {
    result.skipped.push({ kind, reason: "exists" });
    return;
  }

  let report: { id: string; commandId: string; periodLabel: string } | null =
    existing;
  if (!report) {
    const { narrative, note } = await writeSeoNarrative(
      {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        brandId: ctx.brandId,
      },
      snapshot,
      { mockLink: link.isMock },
    );
    const inserted = await insertSeoReport({
      link,
      snapshot,
      narrative,
      narrativeNote: note,
      language: ctx.language,
      commandId,
    });
    if (inserted) {
      report = { id: inserted.id, commandId, periodLabel: labelOf(snapshot) };
    } else {
      // Yarış ya da bağ aradan çekildi: yazan başkaysa onun satırı kullanılır.
      report = await findSeoReport(link.id, kind, periodKey);
      if (!report) {
        result.skipped.push({ kind, reason: "insert_failed" });
        return;
      }
    }
  }

  if (link.isMock && !gscGlobalWorkAllowedHere()) {
    result.skipped.push({ kind, reason: "mock_no_chat" });
    return;
  }
  const posted = await postSeoReportCard({
    workspaceId: link.workspaceId,
    projectId: link.projectId,
    brandId: ctx.brandId,
    commandId: report.commandId,
    card: seoReportCard({
      reportId: report.id,
      kind,
      periodLabel: report.periodLabel,
    }),
    reply: seoReportReply(kind, report.periodLabel),
    summary: seoWorkSummary(kind),
    // Nabız sohbeti Recents'te öne çıkarmaz.
    bump: kind !== "PULSE",
    now,
  });
  if (posted) result.posted.push(kind);
  else result.skipped.push({ kind, reason: "exists" });
}

type StateUpdate = Prisma.SeoReportStateUpdateManyMutationInput;

type StageEnv = RunEnv & {
  state: SeoReportState;
  update: StateUpdate;
  ignoreTime: boolean;
  goalsRefreshed: boolean;
  failure: unknown;
};

async function stageGoals(env: StageEnv): Promise<void> {
  const { ctx, state } = env;
  const due = goalsDue({
    finalThrough: ctx.finalThrough,
    doneGoalsDay: state.goalsDay,
  });
  if (!due) return;
  env.result.goals = await refreshSeoGoals(env.link.projectId, env.now);
  env.goalsRefreshed = true;
  env.update.goalsDay = ctx.finalThrough;
}

async function stagePulse(env: StageEnv): Promise<void> {
  const { ctx, state, now } = env;
  const day = pulseCandidate({
    finalThrough: ctx.finalThrough,
    donePulse: state.pulseDay,
    today: gscToday(now),
  });
  if (!day) return;
  const built = await buildPulseReport(ctx, day, {
    since: state.pulseCheckedAt,
    now,
  });
  if (isBuilt(built)) await deliver(env, "PULSE", built.snapshot);
  else env.result.skipped.push({ kind: "PULSE", reason: built.skipped });
  // Sakin bir gün de ilerler: aynı gün yeniden taranmaz.
  env.update.pulseDay = day;
  env.update.pulseCheckedAt = now;
}

async function stageWeekly(env: StageEnv): Promise<void> {
  const { ctx, state, now, link } = env;
  const week = weeklyCandidate({
    finalThrough: ctx.finalThrough,
    lastWeeklyWeek: link.lastWeeklyWeek,
    doneWeek: state.weeklyWeek,
  });
  if (!week) return;
  if (
    !env.ignoreTime &&
    waitingFor(week, state.weeklyWaitWeek, state.weeklyWaitUntil, now)
  ) {
    return;
  }

  const local = utcToZonedDateTimeLocal(now, ctx.timezone);
  const engineWaits =
    SeoInsightFlags.userFacing() && seoInsightsAllowedFor(link.projectId);
  const engineWeek = engineWaits
    ? ((await readEngineState(link.id))?.lastWeek ?? null)
    : null;
  const due = env.ignoreTime
    ? "due"
    : weeklyDue({
        week,
        localDay: local.slice(0, 10),
        localTime: local.slice(11, 16),
        engineWaits,
        engineWeek,
      });

  if (due === "wait") {
    env.update.weeklyWaitWeek = week;
    env.update.weeklyWaitUntil = weeklyWaitUntil({
      week,
      timezone: ctx.timezone,
      now,
      engineLagging: engineWaits && (engineWeek ?? "") < week,
    });
    return;
  }
  if (due === "stale") {
    env.update.weeklyWeek = week;
    env.result.skipped.push({ kind: "WEEKLY", reason: "stale" });
    return;
  }

  const built = await buildWeeklyReport(ctx, week, now);
  if (isBuilt(built)) {
    await deliver(env, "WEEKLY", built.snapshot);
    env.update.weeklyWeek = week;
  } else if (built.skipped === "no_data") {
    env.update.weeklyWeek = week;
    env.result.skipped.push({ kind: "WEEKLY", reason: built.skipped });
  } else {
    // not_final / missing_summaries: durum ilerlemez, sonraki turda yeniden.
    env.result.skipped.push({ kind: "WEEKLY", reason: built.skipped });
  }
}

async function stageMonthly(env: StageEnv): Promise<void> {
  const { ctx, state, now, link } = env;
  const month = monthlyCandidate({
    finalThrough: ctx.finalThrough,
    lastMonthlyMonth: link.lastMonthlyMonth,
    doneMonth: state.monthlyMonth,
  });
  if (!month) return;
  if (
    !env.ignoreTime &&
    waitingFor(month, state.monthlyWaitMonth, state.monthlyWaitUntil, now)
  ) {
    return;
  }

  const local = utcToZonedDateTimeLocal(now, ctx.timezone);
  const due = env.ignoreTime
    ? "due"
    : monthlyDue({
        month,
        localDay: local.slice(0, 10),
        localTime: local.slice(11, 16),
      });
  if (due === "wait") {
    env.update.monthlyWaitMonth = month;
    env.update.monthlyWaitUntil = monthlyWaitUntil({
      month,
      timezone: ctx.timezone,
    });
    return;
  }
  if (due === "stale") {
    env.update.monthlyMonth = month;
    env.result.skipped.push({ kind: "MONTHLY", reason: "stale" });
    return;
  }

  // Aylık rapor hedeflerin güncel değerini okur: bu turda yenilenmediyse önce
  // yenilenir (hata raporu engellemez).
  if (!env.goalsRefreshed) {
    env.result.goals += await refreshSeoGoals(link.projectId, now).catch(
      () => 0,
    );
    env.goalsRefreshed = true;
  }
  const built = await buildMonthlyReport(ctx, month, now);
  if (!isBuilt(built) && built.skipped !== "no_data") {
    env.result.skipped.push({ kind: "MONTHLY", reason: built.skipped });
    return;
  }
  if (isBuilt(built)) await deliver(env, "MONTHLY", built.snapshot);
  else env.result.skipped.push({ kind: "MONTHLY", reason: built.skipped });

  // Yol haritası, aylık raporun hemen ardından planlanan ay için yazılır.
  const planned = addMonths(month, 1);
  const roadmap = await buildRoadmapReport(ctx, planned, now);
  if (isBuilt(roadmap)) await deliver(env, "ROADMAP", roadmap.snapshot);
  else env.result.skipped.push({ kind: "ROADMAP", reason: roadmap.skipped });
  env.update.monthlyMonth = month;
  env.update.roadmapMonth = planned;
}

async function runLink(
  linkId: string,
  options: { now?: Date; ignoreTime?: boolean } = {},
): Promise<SeoReportRunResult> {
  const now = options.now ?? new Date();
  const result: SeoReportRunResult = {
    posted: [],
    goals: 0,
    skipped: [],
    status: "ran",
  };
  const link = await prisma.gscSiteLink.findUnique({ where: { id: linkId } });
  if (!link) return { ...result, status: "no_data" };
  if (!seoReportsActiveFor(link.projectId)) {
    return { ...result, status: "not_allowed" };
  }
  if (!link.lastFinalDate) return { ...result, status: "no_data" };
  const ctx = await reportContextForLink(link);
  if (!ctx) return { ...result, status: "no_data" };

  const state = await ensureReportState(link);
  const owner = `seo-reports:${process.pid}:${randomUUID()}`;
  if (!(await claimReportLease(state.id, owner, now))) {
    return { ...result, status: "busy" };
  }

  const env: StageEnv = {
    link,
    ctx,
    now,
    result,
    state,
    update: {},
    ignoreTime: options.ignoreTime === true,
    goalsRefreshed: false,
    failure: null,
  };
  // Her aşama kendi hata sınırında: biri düşerse sonrakiler yine koşar.
  const stages: [string, (env: StageEnv) => Promise<void>][] = [
    ["goals", stageGoals],
    ["pulse", stagePulse],
    ["weekly", stageWeekly],
    ["monthly", stageMonthly],
  ];
  try {
    for (const [name, stage] of stages) {
      try {
        await stage(env);
      } catch (error) {
        env.failure = error;
        console.error(`[seo-reports] ${name} failed:`, errorName(error));
      }
    }
  } finally {
    const failed = env.failure !== null;
    const failures = state.consecutiveFailures + 1;
    const data: StateUpdate = failed
      ? {
          ...env.update,
          consecutiveFailures: failures,
          nextRunAt: new Date(now.getTime() + reportBackoffMs(failures)),
          lastError: `${errorName(env.failure)}: report run failed`,
        }
      : {
          ...env.update,
          consecutiveFailures: 0,
          nextRunAt: null,
          lastError: null,
        };
    await releaseReportState(state.id, owner, data).catch((error: unknown) => {
      console.error("[seo-reports] state not saved:", errorName(error));
    });
  }
  return { ...result, status: env.failure !== null ? "failed" : "ran" };
}

export const SeoReports = {
  // Tick adımı: kapalıyken hiçbir sorgu yapmaz; yazılan rapor sayısını döner.
  async runDue(limit = DEFAULT_LIMIT, now: Date = new Date()): Promise<number> {
    if (!SeoReportFlags.on()) return 0;
    const restricted = gscRestrictedProjects();
    if (restricted && restricted.length === 0) return 0;
    // Yerel geliştirme süreci canlı veritabanını paylaşırken kilit almaz.
    if (
      gscGlobalWorkAllowedHere() &&
      !(await claimPeriodic("seo.reports", REPORTS_EVERY_MS, now))
    ) {
      return 0;
    }

    const links = await prisma.gscSiteLink.findMany({
      where: {
        isPrimary: true,
        isMock: gscMockMode(),
        lastFinalDate: { not: null },
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { updatedAt: "asc" },
      take: LINK_SCAN_LIMIT,
    });
    if (links.length === 0) return 0;
    const states = await prisma.seoReportState.findMany({
      where: { linkId: { in: links.map((link) => link.id) } },
    });
    const stateOf = new Map(states.map((state) => [state.linkId, state]));

    const startedAt = Date.now();
    const today = gscToday(now);
    let written = 0;
    let runs = 0;
    for (const link of links) {
      if (
        written >= limit ||
        runs >= MAX_LINK_RUNS ||
        Date.now() - startedAt >= RUN_DEADLINE_MS
      ) {
        break;
      }
      if (!gscSyncAllowedFor(link.projectId)) continue;
      const state = stateOf.get(link.id) ?? null;
      if (state?.nextRunAt && state.nextRunAt > now) continue;
      const finalThrough = link.lastFinalDate;
      if (!finalThrough) continue;

      // Ön kontrol (saat dilimi okumadan): yapılacak bir şey yoksa bağa
      // dokunulmaz; bekleyen dönem bekleme anına kadar atlanır.
      const week = weeklyCandidate({
        finalThrough,
        lastWeeklyWeek: link.lastWeeklyWeek,
        doneWeek: state?.weeklyWeek ?? null,
      });
      const month = monthlyCandidate({
        finalThrough,
        lastMonthlyMonth: link.lastMonthlyMonth,
        doneMonth: state?.monthlyMonth ?? null,
      });
      const something =
        pulseCandidate({
          finalThrough,
          donePulse: state?.pulseDay ?? null,
          today,
        }) !== null ||
        goalsDue({ finalThrough, doneGoalsDay: state?.goalsDay ?? null }) ||
        (week !== null &&
          !waitingFor(
            week,
            state?.weeklyWaitWeek ?? null,
            state?.weeklyWaitUntil ?? null,
            now,
          )) ||
        (month !== null &&
          !waitingFor(
            month,
            state?.monthlyWaitMonth ?? null,
            state?.monthlyWaitUntil ?? null,
            now,
          ));
      if (!something) continue;

      runs += 1;
      try {
        const result = await runLink(link.id, { now });
        written += result.posted.length;
      } catch (error) {
        console.error("[seo-reports] link failed:", errorName(error));
      }
    }
    return written;
  },

  runLink,
};
