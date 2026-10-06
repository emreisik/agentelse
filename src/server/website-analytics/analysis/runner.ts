import "server-only";

import { randomUUID } from "node:crypto";

import type { GaAnalysisRun, GaPropertyLink, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  gaInsightsDevProjectScope,
  gaInsightsMode,
  gaInsightsModeFor,
} from "@/lib/website-analytics/analysis/flags";
import {
  gaFindingFingerprint,
  GaSubjects,
  subjectKeyOf,
} from "@/lib/website-analytics/analysis/keys";
import {
  runDailyRules,
  runWeeklyRules,
} from "@/lib/website-analytics/analysis/run-rules";
import {
  GA_ANALYZE_LEASE_MS,
  dailyTargets,
  monthRunFor,
  weeklyDue,
  weeklyTargetWeek,
} from "@/lib/website-analytics/analysis/schedule";
import type { GaFindingMode } from "@/lib/website-analytics/analysis/types";
import { addDays, safeTimezone } from "@/lib/website-analytics/days";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { completeThroughOf } from "@/lib/website-analytics/health/schedule";
import { Heartbeat } from "@/server/observability/heartbeat";

import { explainTopFindings } from "./explain";
import {
  loadDailyAnalysisInput,
  loadExcludedDays,
  loadWeeklyAnalysisInput,
} from "./inputs";
import { persistCandidates, type GaPersistResult } from "./persist";
import { ingestFindingSignals } from "./signals";
import { sweepFindings } from "./sweep";

// GA-F4 analiz motoru (docs/website-insights.md "İşler"): `ga-analyze` tick
// adımı. Günlük kısım tamamlanan son günde AN1 + AN15 (son 3 gün yeniden),
// haftalık kısım Pazartesi 06:30'dan sonra (mülk saati) pazar verisi gelince
// AN1 (hafta) + AN2-AN12; ay turu AN2 MoM + AN10. Aday seçimi veritabanında
// süzülür ve GaAnalysisRun.lastCheckedAt'e göre sıralanır (hiç bakılmamış
// önce); zamanı gelmese de her bakılan bağ lastCheckedAt alır, hiçbir bağ
// aç kalmaz. Bağ başına 3 dakikalık CAS kilidi. Gölge modda yalnız bulgu
// yazılır; canlı modda sinyal ve haftalık LLM açıklaması da çalışır.
// Geliştirme süreci paylaşılan nabzı yazmaz ve yalnız GA_SYNC_DEV_PROJECTS'i
// sorgular. Kapalıyken hiçbir sorgu yok.

const HEARTBEAT_KEY = "ga.analyze";
const CANDIDATE_FACTOR = 4;
const SUSPECT_LOOKBACK_DAYS = 70;
const STOPPED_HEALTH = [
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
];

export type GaAnalysisResult = {
  daily: string[];
  week: string | null;
  month: string | null;
  created: number;
  refreshed: number;
  superseded: number;
  suppressed: number;
  expired: number;
  resolved: number;
  explained: number;
  signals: number;
};

type CandidateLink = GaPropertyLink & { analysisRun: GaAnalysisRun | null };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function plan(link: GaPropertyLink, run: GaAnalysisRun | null, now: Date) {
  const timeZone = safeTimezone(link.timeZone);
  const completeThrough = completeThroughOf(link.lastDailyDate);
  const targets = dailyTargets({
    completeThrough,
    lastDailyDay: run?.lastDailyDay ?? null,
  });
  const week = weeklyTargetWeek({ now, timeZone, completeThrough });
  const weekly = weeklyDue({ week, lastWeek: run?.lastWeek ?? null });
  return {
    timeZone,
    completeThrough,
    targets,
    week: weekly ? week : null,
  };
}

async function ensureRun(link: GaPropertyLink): Promise<void> {
  try {
    await prisma.gaAnalysisRun.upsert({
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
    const existing = await prisma.gaAnalysisRun.findUnique({
      where: { linkId: link.id },
      select: { id: true },
    });
    if (!existing) throw error;
  }
}

function addCounts(
  total: GaAnalysisResult,
  stats: Record<string, unknown>,
  part: "daily" | "weekly",
  persisted: GaPersistResult,
): void {
  total.created += persisted.created.length;
  total.refreshed += persisted.refreshed;
  total.superseded += persisted.superseded;
  total.suppressed += persisted.suppressed + persisted.stale;
  stats[part] = persisted.byRule;
}

async function analyze(
  link: GaPropertyLink,
  run: GaAnalysisRun,
  now: Date,
): Promise<GaAnalysisResult> {
  const mode: GaFindingMode =
    gaInsightsModeFor(link.projectId) === "on" ? "live" : "shadow";
  const { timeZone, targets, week, completeThrough } = plan(link, run, now);
  const today = dayKeyInTimezone(now, timeZone);
  const result: GaAnalysisResult = {
    daily: [],
    week: null,
    month: null,
    created: 0,
    refreshed: 0,
    superseded: 0,
    suppressed: 0,
    expired: 0,
    resolved: 0,
    explained: 0,
    signals: 0,
  };
  const stats: Record<string, unknown> = {};
  const created: string[] = [];
  let daily: Parameters<typeof sweepFindings>[0]["daily"] = null;

  if (targets.length > 0) {
    const input = await loadDailyAnalysisInput(link, targets, now);
    const rules = runDailyRules(input);
    const persisted = await persistCandidates({
      link,
      candidates: rules.candidates,
      mode,
      now,
    });
    addCounts(result, stats, "daily", persisted);
    created.push(...persisted.created);
    const fingerprintOf = (goalId: string, month: string) =>
      gaFindingFingerprint({
        linkId: link.id,
        ruleKey: "AN15",
        subjectKey: subjectKeyOf(GaSubjects.goal(goalId)),
        periodKey: month,
      });
    daily = {
      an1Days: rules.an1Days,
      an15Evaluated: new Set(
        rules.an15Evaluated.map((goal) =>
          fingerprintOf(goal.goalId, goal.month),
        ),
      ),
      an15Active: new Set(
        rules.candidates
          .filter((candidate) => candidate.ruleKey === "AN15")
          .map((candidate) =>
            gaFindingFingerprint({
              linkId: link.id,
              ruleKey: "AN15",
              subjectKey: subjectKeyOf(candidate.subject),
              periodKey: candidate.period.key,
            }),
          ),
      ),
    };
    result.daily = targets;
  }

  if (week) {
    const month = monthRunFor({
      completeThrough,
      lastMonth: run.lastMonth,
    });
    const input = await loadWeeklyAnalysisInput(link, week, month, now);
    const candidates = runWeeklyRules(input);
    const persisted = await persistCandidates({ link, candidates, mode, now });
    addCounts(result, stats, "weekly", persisted);
    created.push(...persisted.created);
    result.week = week.monday;
    result.month = month;
  }

  const { suspect } = await loadExcludedDays(link.id, null, {
    from: addDays(today, -SUSPECT_LOOKBACK_DAYS),
    to: today,
  });
  const swept = await sweepFindings({
    linkId: link.id,
    today,
    now,
    suspect,
    daily,
  });
  result.expired = swept.expired;
  result.resolved = swept.resolved;

  let lastExplainedWeek = run.lastExplainedWeek;
  if (mode === "live") {
    result.signals = await ingestFindingSignals({ findingIds: created, now });
    // Açıklanacak hafta: bu turun haftası ya da son analiz edilen hafta.
    // Bütçe ya da geçici LLM hatasında hafta ilerlemez; açıklama haftalık
    // olmayan (günlük) turlarda yeniden denenir.
    const explainWeek = week?.monday ?? run.lastWeek;
    if (explainWeek && run.lastExplainedWeek !== explainWeek) {
      const brand = await prisma.brand.findFirst({
        where: { projectId: link.projectId, isDefault: true },
        select: { id: true },
      });
      if (brand) {
        try {
          const explained = await explainTopFindings({
            linkId: link.id,
            projectId: link.projectId,
            workspaceId: link.workspaceId,
            brandId: brand.id,
            currency: link.currencyCode,
            now,
          });
          result.explained = explained.explained;
          if (explained.skipped !== "budget" && explained.skipped !== "error") {
            lastExplainedWeek = explainWeek;
          }
        } catch (error) {
          // Açıklama analizi düşürmez; gelecek turda yeniden denenir.
          console.warn(`[ga-analyze] explanation failed: ${errorName(error)}`);
        }
      }
    }
  }

  const data: Prisma.GaAnalysisRunUpdateInput = {
    stats: stats as Prisma.InputJsonValue,
    lastError: null,
    lastExplainedWeek,
  };
  if (result.daily.length > 0) {
    data.lastDailyDay = result.daily[result.daily.length - 1];
    data.lastDailyAt = now;
  }
  if (result.week) {
    data.lastWeek = result.week;
    data.lastWeeklyAt = now;
    if (result.month) data.lastMonth = result.month;
  }
  await prisma.gaAnalysisRun.update({ where: { linkId: link.id }, data });
  return result;
}

async function analyzeLink(
  linkId: string,
  options: { now: Date },
): Promise<GaAnalysisResult | "busy" | "skipped"> {
  const { now } = options;
  const link = await prisma.gaPropertyLink.findUnique({
    where: { id: linkId },
  });
  if (!link || !link.isPrimary) return "skipped";
  if (gaInsightsModeFor(link.projectId) === "off") return "skipped";
  await ensureRun(link);

  const owner = `ga-analyze:${process.pid}:${randomUUID()}`;
  const claimed = await prisma.gaAnalysisRun.updateMany({
    where: {
      linkId: link.id,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseUntil: new Date(now.getTime() + GA_ANALYZE_LEASE_MS),
      leaseOwner: owner,
    },
  });
  if (claimed.count !== 1) return "busy";

  try {
    const run = await prisma.gaAnalysisRun.findUniqueOrThrow({
      where: { linkId: link.id },
    });
    return await analyze(link, run, now);
  } catch (error) {
    const name = errorName(error);
    console.error(`[ga-analyze] link ${link.id} failed: ${name}`);
    await prisma.gaAnalysisRun
      .updateMany({ where: { linkId: link.id }, data: { lastError: name } })
      .catch(() => undefined);
    return "skipped";
  } finally {
    await prisma.gaAnalysisRun
      .updateMany({
        where: { linkId: link.id, leaseOwner: owner },
        data: { leaseUntil: null, leaseOwner: null },
      })
      .catch((error: unknown) => {
        console.error(
          `[ga-analyze] lease could not be released: ${errorName(error)}`,
        );
      });
  }
}

export const GaInsights = {
  // Tick adımı.
  async runDue(limit = 5, now: Date = new Date()): Promise<number> {
    if (gaInsightsMode() === "off") return 0;
    const global = gaGlobalWorkAllowedHere();
    const scope = gaInsightsDevProjectScope();
    if (scope && scope.length === 0) return 0;
    if (global) await Heartbeat.beat(HEARTBEAT_KEY, now);

    // Duraklatılmış/kapalı projeler önden tek sorguyla (ilişkisiz süzgeç).
    const stopped = (
      await prisma.project.findMany({
        where: {
          status: { in: ["PAUSED", "CLOSED"] },
          ...(scope ? { id: { in: scope } } : {}),
        },
        select: { id: true },
      })
    ).map((project) => project.id);
    const projectFilter: Prisma.StringFilter = {
      ...(scope ? { in: scope } : {}),
      ...(stopped.length > 0 ? { notIn: stopped } : {}),
    };
    const candidates: CandidateLink[] = await prisma.gaPropertyLink.findMany({
      where: {
        isPrimary: true,
        lastDailyDate: { not: null },
        health: { notIn: STOPPED_HEALTH },
        ...(scope || stopped.length > 0 ? { projectId: projectFilter } : {}),
      },
      include: { analysisRun: true },
      orderBy: {
        analysisRun: { lastCheckedAt: { sort: "asc", nulls: "first" } },
      },
      take: limit * CANDIDATE_FACTOR,
    });

    let processed = 0;
    for (const link of candidates) {
      if (processed >= limit) break;
      if (gaInsightsModeFor(link.projectId) === "off") continue;
      const due = plan(link, link.analysisRun, now);
      try {
        await prisma.gaAnalysisRun.upsert({
          where: { linkId: link.id },
          create: {
            linkId: link.id,
            workspaceId: link.workspaceId,
            projectId: link.projectId,
            lastCheckedAt: now,
          },
          update: { lastCheckedAt: now },
        });
      } catch (error) {
        console.error(
          `[ga-analyze] link ${link.id} could not be checked: ${errorName(error)}`,
        );
        continue;
      }
      if (due.targets.length === 0 && !due.week) continue;
      const result = await analyzeLink(link.id, { now });
      if (typeof result === "object") processed += 1;
    }
    if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  analyzeLink,
};
