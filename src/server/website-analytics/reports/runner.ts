import "server-only";

import { randomUUID } from "node:crypto";

import type { GaReportRun, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import {
  gaReportsDevProjectScope,
  gaReportsEnabled,
  gaReportsEnabledFor,
} from "@/lib/website-analytics/reports/flags";
import {
  GA_ALERT_LOOKBACK_MS,
  GA_REPORT_LEASE_MS,
  GA_REPORT_MAX_ATTEMPTS,
  GA_REPORTS_MAX_LLM_PER_TICK,
  GA_REPORTS_RUN_EVERY_MS,
  attemptKey,
  attemptsOf,
  bumpAttempt,
  clearAttempt,
  goalsDue,
  monthlyReportDue,
  narrativeModeFor,
  planDue,
  pulseDue,
  readAttempts,
  weeklyReportDue,
  type MonthlyDue,
  type ReportAttempts,
} from "@/lib/website-analytics/reports/schedule";
import type {
  NarrativeStatus,
  ReportStepResult,
} from "@/lib/website-analytics/reports/types";
import { Heartbeat } from "@/server/observability/heartbeat";
import { claimPeriodic } from "@/server/observability/periodic";

import { GaGoals } from "./goals";
import {
  historyDaysOf,
  insightsProgressOf,
  loadGaReportContext,
  type GaReportContext,
} from "./inputs";
import { GaMonthlyReport } from "./monthly";
import { GaPulse } from "./pulse";
import { GaReportRetention } from "./retention";
import { GaWeeklyReport } from "./weekly";

// GA-F5 rapor motoru (docs/website-reports.md "İşler"): `ga-reports` tick
// adımı. Birincil GA bağı başına 3 dakikalık CAS kilidi altında sırayla:
// günlük hedef tazeleme, kritik uyarı kartları, nabız, haftalık rapor, aylık
// rapor, "Next month plan". Her aşama kendi try/catch'inde: biri düşerse
// sonrakiler yine koşar. Dönem başına "yapıldı" işaretleri GaReportRun'dadır;
// kartlar sabit kimlikli olduğundan işaret yazılamasa bile kart ikinci kez
// yazılmaz. Aday seçimi veritabanında yapılır ve adildir: önce hiç
// bakılmamış bağlar, sonra lastCheckedAt'e göre en eskiler. Turda en çok
// GA_REPORTS_MAX_LLM_PER_TICK LLM çağrısı. Google'a hiç gidilmez. Loga ve
// lastError'a yalnız hata adı ya da Prisma kodu girer, mesaj asla (hatalar
// Google metni taşıyabilir).

const HEARTBEAT_KEY = "ga.reports";
const TICK_KEY = "ga.reports.tick";
const DEFAULT_LINK_LIMIT = 5;
const ALERT_SCAN_OVERLAP_MS = 10 * 60_000;
const PULSE_FIRST_LOOKBACK_MS = 48 * 3_600_000;
const MAX_ERROR_CODE_LENGTH = 60;
// ReasoningService.run'ın gerçekten çağrıldığı anlatı durumları.
const LLM_STATUSES: ReadonlySet<NarrativeStatus> = new Set([
  "ok",
  "dropped",
  "budget",
  "error",
]);

export type GaReportRunResult = {
  goals: number;
  alerts: number;
  pulse: ReportStepResult | null;
  weekly: ReportStepResult | null;
  monthly: ReportStepResult | null;
  plan: ReportStepResult | null;
  // Anlatı durumu ok | dropped | budget | error olan çağrılar
  llmCalls: number;
};

// Geliştirme sürecinde (paylaşılan veritabanı) tick'in süreç içi kısması.
let lastLocalRunAt = 0;

// Yalnız hata adı ya da Prisma kodu (P2028 gibi); mesaj asla.
function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^P\d{4}$/.test(code)) return code;
  }
  const name = error instanceof Error ? error.name : "UnknownError";
  return name.slice(0, MAX_ERROR_CODE_LENGTH);
}

type StatCounters = Record<string, Record<string, number>>;

function readCounters(value: unknown): StatCounters {
  const out: StatCounters = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [group, entries] of Object.entries(value)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      continue;
    }
    const counters: Record<string, number> = {};
    for (const [key, count] of Object.entries(entries)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        counters[key] = count;
      }
    }
    out[group] = counters;
  }
  return out;
}

function bump(
  counters: StatCounters,
  group: string,
  key: string,
  amount = 1,
): void {
  if (amount <= 0) return;
  const entries = counters[group] ?? {};
  entries[key] = (entries[key] ?? 0) + amount;
  counters[group] = entries;
}

// Bir turun durumu: aşamalar buraya yazar, sonda tek güncellemeyle saklanır.
type RunState = {
  ctx: GaReportContext;
  run: GaReportRun;
  now: Date;
  llmBudget: number;
  attempts: ReportAttempts;
  counters: StatCounters;
  update: Prisma.GaReportRunUpdateInput;
  result: GaReportRunResult;
  errors: string[];
  insights: { lastWeek: string | null; lastDailyDay: string | null } | null;
  // Aylık raporun bu turda "yapıldı" sayılıp sayılmadığı (plan buna bakar)
  monthlyMarked: boolean;
  monthlyDue: MonthlyDue | null;
};

function fail(state: RunState, link: string, stage: string, error: unknown) {
  const code = errorCode(error);
  state.errors.push(code);
  console.error(`[ga-reports] link ${link} ${stage} failed: ${code}`);
}

async function stageGoals(state: RunState): Promise<void> {
  const { ctx, run } = state;
  const through = ctx.completeThrough;
  if (
    through === null ||
    !goalsDue({ completeThrough: through, lastGoalsDay: run.lastGoalsDay })
  ) {
    return;
  }
  const refreshed = await GaGoals.refreshLink({
    link: ctx.link,
    through,
    country: ctx.country,
    now: state.now,
  });
  if (refreshed === "gone") return;
  state.result.goals = refreshed;
  state.update.lastGoalsDay = through;
}

async function stageAlerts(state: RunState): Promise<void> {
  const { ctx, run, now } = state;
  if (!ctx.settings.alertChat) return;
  const since = run.lastAlertScanAt
    ? new Date(run.lastAlertScanAt.getTime() - ALERT_SCAN_OVERLAP_MS)
    : new Date(now.getTime() - GA_ALERT_LOOKBACK_MS);
  state.result.alerts = await GaPulse.postAlertCards(ctx, since);
  bump(state.counters, "posted", "alert", state.result.alerts);
  state.update.lastAlertScanAt = now;
}

async function stagePulse(state: RunState): Promise<void> {
  const { ctx, run, now } = state;
  const due = pulseDue({
    propertyToday: ctx.propertyToday,
    completeThrough: ctx.completeThrough,
    lastPulseDay: run.lastPulseDay,
    mode: ctx.settings.pulse,
    insightsOn: ctx.insights === "on",
    insightsDay: state.insights?.lastDailyDay ?? null,
    pendingDay: run.pulsePendingDay,
    pendingSince: run.pulsePendingSince,
    now,
  });
  if (!due.day) return;
  if (due.state === "wait_insights") {
    if (run.pulsePendingDay !== due.day) {
      state.update.pulsePendingDay = due.day;
      state.update.pulsePendingSince = now;
    }
    return;
  }
  if (due.state !== "due") return;

  const result = await GaPulse.write(
    ctx,
    due.day,
    run.lastPulseAt ?? new Date(now.getTime() - PULSE_FIRST_LOOKBACK_MS),
  );
  state.result.pulse = result;
  bump(state.counters, result === "posted" ? "posted" : "skipped", "pulse");
  state.update.lastPulseDay = due.day;
  state.update.lastPulseAt = now;
  state.update.pulsePendingDay = null;
  state.update.pulsePendingSince = null;
}

// Haftalık ve aylık için ortak yazma sonucu işleme: LLM bütçesi, deneme
// sayacı ve "yapıldı" kararı.
async function writePeriod(
  state: RunState,
  input: {
    variant: "weekly" | "monthly";
    periodKey: string;
    write: (
      mode: ReturnType<typeof narrativeModeFor>,
    ) => Promise<{
      result: ReportStepResult;
      narrative: NarrativeStatus | null;
    }>;
    mark: () => void;
  },
): Promise<ReportStepResult | null> {
  const key = attemptKey(input.variant, input.periodKey);
  const mode = narrativeModeFor({
    attempts: attemptsOf(state.attempts, key),
    llmBudget: state.llmBudget,
  });
  try {
    const written = await input.write(mode);
    if (written.narrative && LLM_STATUSES.has(written.narrative)) {
      state.llmBudget -= 1;
      state.result.llmCalls += 1;
    }
    if (written.narrative) bump(state.counters, "narrative", written.narrative);
    if (written.result === "deferred") {
      bump(state.counters, "skipped", `${input.variant}_deferred`);
      return written.result;
    }
    bump(
      state.counters,
      written.result === "posted" ? "posted" : "skipped",
      input.variant,
    );
    input.mark();
    state.attempts = clearAttempt(state.attempts, key);
    return written.result;
  } catch (error) {
    fail(state, state.ctx.link.id, input.variant, error);
    state.attempts = bumpAttempt(state.attempts, key);
    if (attemptsOf(state.attempts, key) >= GA_REPORT_MAX_ATTEMPTS) {
      // Yazılamayan dönem sonsuza dek denenmesin.
      bump(state.counters, "skipped", `${input.variant}_failed`);
      input.mark();
      state.attempts = clearAttempt(state.attempts, key);
    }
    return null;
  }
}

async function stageWeekly(state: RunState): Promise<void> {
  const { ctx, run } = state;
  if (!ctx.settings.weeklyEnabled) return;
  const due = weeklyReportDue({
    localNow: ctx.localNow,
    weekday: ctx.settings.weeklyWeekday,
    completeThrough: ctx.completeThrough,
    lastWeek: run.lastWeek,
    insightsOn: ctx.insights === "on",
    insightsWeek: state.insights?.lastWeek ?? null,
  });
  const week = due.week;
  if (!week) return;
  if (due.state === "stale") {
    state.update.lastWeek = week.monday;
    bump(state.counters, "skipped", "weekly_stale");
    return;
  }
  if (due.state !== "due") return;
  const result = await writePeriod(state, {
    variant: "weekly",
    periodKey: week.monday,
    write: (mode) =>
      GaWeeklyReport.write(ctx, week, due.insights, { narrative: mode }),
    mark: () => {
      state.update.lastWeek = week.monday;
    },
  });
  if (result) state.result.weekly = result;
}

async function stageMonthly(state: RunState): Promise<void> {
  const { ctx, run } = state;
  if (!ctx.settings.monthlyEnabled) return;
  const due = monthlyReportDue({
    localNow: ctx.localNow,
    day: ctx.settings.monthlyDay,
    completeThrough: ctx.completeThrough,
    lastMonth: run.lastMonth,
  });
  state.monthlyDue = due;
  const month = due.month;
  if (due.state === "done") {
    state.monthlyMarked = true;
    return;
  }
  if (!month) return;
  if (due.state === "stale") {
    state.update.lastMonth = month;
    state.monthlyMarked = true;
    bump(state.counters, "skipped", "monthly_stale");
    return;
  }
  if (due.state !== "due") return;
  const result = await writePeriod(state, {
    variant: "monthly",
    periodKey: month,
    write: (mode) =>
      GaMonthlyReport.write(ctx, month, ctx.insights === "on" ? "on" : "off", {
        narrative: mode,
      }),
    mark: () => {
      state.update.lastMonth = month;
      state.monthlyMarked = true;
    },
  });
  if (result) state.result.monthly = result;
}

async function stagePlan(state: RunState): Promise<void> {
  const { ctx, run } = state;
  const enabled = ctx.settings.monthlyEnabled;
  const monthlyState = !enabled
    ? "off"
    : state.monthlyMarked
      ? "done"
      : (state.monthlyDue?.state ?? "wait_data");
  const input = {
    localNow: ctx.localNow,
    day: ctx.settings.monthlyDay,
    enabled,
    lastPlanMonth: run.lastPlanMonth,
    monthlyState,
  } as const;
  // Ucuz ön karar: geçmiş uzunluğu sorgusu yalnız plan vadesi geldiyse.
  let due = planDue({ ...input, historyDays: Number.POSITIVE_INFINITY });
  if (due.state === "due") {
    const historyDays = await historyDaysOf(
      ctx.link.id,
      ctx.completeThrough ?? ctx.propertyToday,
    );
    due = planDue({ ...input, historyDays });
  }
  const month = due.month;
  if (due.state !== "due" || !month) return;

  const key = attemptKey("plan", month);
  try {
    const result = await GaMonthlyReport.writePlan(ctx, month);
    state.result.plan = result;
    if (result === "deferred") return;
    bump(state.counters, result === "posted" ? "posted" : "skipped", "plan");
    state.update.lastPlanMonth = month;
    state.attempts = clearAttempt(state.attempts, key);
  } catch (error) {
    fail(state, ctx.link.id, "plan", error);
    state.attempts = bumpAttempt(state.attempts, key);
    if (attemptsOf(state.attempts, key) >= GA_REPORT_MAX_ATTEMPTS) {
      bump(state.counters, "skipped", "plan_failed");
      state.update.lastPlanMonth = month;
      state.attempts = clearAttempt(state.attempts, key);
    }
  }
}

async function ensureRun(link: {
  id: string;
  workspaceId: string;
  projectId: string;
}): Promise<void> {
  try {
    await prisma.gaReportRun.upsert({
      where: { linkId: link.id },
      create: {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
      },
      update: {},
    });
  } catch (error) {
    // İki süreç aynı anda oluşturdu: satır var.
    const existing = await prisma.gaReportRun.findUnique({
      where: { linkId: link.id },
      select: { id: true },
    });
    if (!existing) throw error;
  }
}

async function runLink(
  linkId: string,
  options: { now: Date; llmBudget?: number },
): Promise<GaReportRunResult | "busy" | "skipped"> {
  const { now } = options;
  const link = await prisma.gaPropertyLink.findUnique({
    where: { id: linkId },
  });
  if (!link || !link.isPrimary) return "skipped";
  if (!gaReportsEnabledFor(link.projectId)) return "skipped";
  await ensureRun(link);

  const owner = `ga-reports:${process.pid}:${randomUUID()}`;
  const claimed = await prisma.gaReportRun.updateMany({
    where: {
      linkId: link.id,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseUntil: new Date(now.getTime() + GA_REPORT_LEASE_MS),
      leaseOwner: owner,
      lastCheckedAt: now,
    },
  });
  if (claimed.count !== 1) return "busy";

  try {
    const ctx = await loadGaReportContext(link, now);
    if (!ctx) return "skipped";
    // Kilit alındıktan sonra okunur: başka tur az önce bitirmiş olabilir.
    const run = await prisma.gaReportRun.findUniqueOrThrow({
      where: { linkId: link.id },
    });
    const state: RunState = {
      ctx,
      run,
      now,
      llmBudget: options.llmBudget ?? 1,
      attempts: readAttempts(run.attempts),
      counters: readCounters(run.stats),
      update: {},
      result: {
        goals: 0,
        alerts: 0,
        pulse: null,
        weekly: null,
        monthly: null,
        plan: null,
        llmCalls: 0,
      },
      errors: [],
      insights: null,
      monthlyMarked: false,
      monthlyDue: null,
    };

    if (ctx.insights === "on") {
      try {
        state.insights = await insightsProgressOf(link.id);
      } catch (error) {
        fail(state, link.id, "insights", error);
      }
    }
    const stages: [string, (state: RunState) => Promise<void>][] = [
      ["goals", stageGoals],
      ["alerts", stageAlerts],
      ["pulse", stagePulse],
      ["weekly", stageWeekly],
      ["monthly", stageMonthly],
      ["plan", stagePlan],
    ];
    for (const [name, stage] of stages) {
      try {
        await stage(state);
      } catch (error) {
        fail(state, link.id, name, error);
      }
    }

    try {
      await prisma.gaReportRun.update({
        where: { linkId: link.id },
        data: {
          ...state.update,
          attempts: state.attempts as Prisma.InputJsonValue,
          stats: state.counters as Prisma.InputJsonValue,
          lastError:
            state.errors.length > 0 ? (state.errors.at(-1) ?? null) : null,
        },
      });
    } catch (error) {
      // Bağ aradan çekilmiş olabilir (cascade): sonraki tur zaten bakmaz.
      console.error(`[ga-reports] state not saved: ${errorCode(error)}`);
    }
    return state.result;
  } finally {
    await prisma.gaReportRun
      .updateMany({
        where: { linkId: link.id, leaseOwner: owner },
        data: { leaseUntil: null, leaseOwner: null },
      })
      .catch((error: unknown) => {
        console.error(
          `[ga-reports] lease could not be released: ${errorCode(error)}`,
        );
      });
  }
}

// Aday bağlar: önce hiç GaReportRun'ı olmayanlar (id sırası), sonra
// lastCheckedAt'e göre en eskiler. Bellek içi tavan yok, aç kalan proje yok.
async function candidateLinkIds(
  limit: number,
  scope: string[] | null,
): Promise<string[]> {
  const projectFilter = scope ? { projectId: { in: scope } } : {};
  const fresh = await prisma.gaPropertyLink.findMany({
    where: {
      isPrimary: true,
      lastDailyDate: { not: null },
      reportRun: null,
      ...projectFilter,
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: limit,
  });
  const ids = fresh.map((row) => row.id);
  if (ids.length >= limit) return ids;
  const seen = await prisma.gaReportRun.findMany({
    where: {
      link: {
        isPrimary: true,
        lastDailyDate: { not: null },
        ...projectFilter,
      },
    },
    orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    take: limit - ids.length,
    select: { linkId: true },
  });
  for (const row of seen) {
    if (!ids.includes(row.linkId)) ids.push(row.linkId);
  }
  return ids;
}

export const GaReports = {
  // Tick adımı. Kapalıyken hiçbir sorgu yapmaz.
  async runDue(
    limit = DEFAULT_LINK_LIMIT,
    now: Date = new Date(),
  ): Promise<number> {
    if (!gaReportsEnabled()) return 0;
    const scope = gaReportsDevProjectScope();
    if (scope && scope.length === 0) return 0;
    const global = gaGlobalWorkAllowedHere();
    if (global) {
      if (!(await claimPeriodic(TICK_KEY, GA_REPORTS_RUN_EVERY_MS, now))) {
        return 0;
      }
    } else {
      if (now.getTime() - lastLocalRunAt < GA_REPORTS_RUN_EVERY_MS) return 0;
      lastLocalRunAt = now.getTime();
    }
    // Saklama temizliği bütün projeleri ilgilendirir: yalnız genel süreçte.
    if (global) await GaReportRetention.runDue(now).catch(() => 0);

    const ids = await candidateLinkIds(limit, scope);
    let budget = GA_REPORTS_MAX_LLM_PER_TICK;
    let processed = 0;
    for (const id of ids) {
      try {
        const result = await runLink(id, { now, llmBudget: budget });
        if (typeof result === "object") {
          processed += 1;
          budget -= result.llmCalls;
        }
      } catch (error) {
        console.error(`[ga-reports] link ${id} failed: ${errorCode(error)}`);
      }
    }
    if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  runLink,
};
