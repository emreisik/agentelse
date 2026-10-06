import "server-only";

import type { AdsAccount, AdsDecision, Prisma } from "@prisma/client";

import {
  autopilotVerdict,
  daysLeftInMonth,
  fullPrerequisitesMet,
  type AutoCandidate,
  type AutoGates,
  type AutonomyLevel,
  type AutoVerdict,
  type FullPrerequisites,
} from "@/lib/ads/autopilot";
import { AdsFlags } from "@/lib/ads/flags";
import { hourInTimezone, safeTimezone } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { driveLaunchInline } from "@/server/ads/launch/drive";
import { TaskPlanner } from "@/server/commands/task-planner";
import type { MetaTokenHealth } from "@/server/integrations/meta-client";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import { changeOf } from "./decisions";

// Otomatik pilot (docs/meta-ads-plan.md §1.2, F7): bir karar (optimizasyon
// kuralı ya da bekçi bulgusu) projenin seviyesine ve kapılara göre ya
// kendiliğinden uygulanır ya da her zamanki gibi onaya gider. Kural
// listesi ve sınırlar saf modülde (lib/ads/autopilot.ts); yürütücü aynı
// sınırları ayrıca denetler. Bildirim görev kancasından gelir
// (autopilot-notify.ts).

const MIRROR_FRESH_MS = 2 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const INLINE_DRIVE_MS = 60_000;

export async function adsAutonomyOf(projectId: string): Promise<AutonomyLevel> {
  if (!AdsFlags.autopilot()) return "SUGGEST";
  const policy = await prisma.autonomyPolicy.findUnique({
    where: { projectId },
    select: { adsAutonomy: true },
  });
  return policy?.adsAutonomy ?? "SUGGEST";
}

function tokenHealthOf(metadata: unknown): MetaTokenHealth | undefined {
  return (metadata as { tokenHealth?: MetaTokenHealth } | null)?.tokenHealth;
}

function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

async function monthToDateSpend(
  account: AdsAccount,
  today: string,
): Promise<number> {
  const total = await prisma.adsInsightDaily.aggregate({
    where: {
      adsAccountId: account.id,
      level: "ACCOUNT",
      date: { gte: new Date(`${monthStart(today)}T00:00:00.000Z`) },
    },
    _sum: { spendMinor: true },
  });
  return Number(total._sum.spendMinor ?? 0);
}

export const AdsAutopilot = {
  levelFor: adsAutonomyOf,

  // FULL önkoşulları (Settings → Autonomy satırları ve karar kapısı).
  async fullPrerequisites(
    projectId: string,
    now: Date = new Date(),
  ): Promise<FullPrerequisites & { currency: string | null }> {
    const link = await prisma.adsAccountProject.findFirst({
      where: { projectId, selected: true },
      include: { adsAccount: true },
    });
    const account = link?.adsAccount ?? null;
    const [policy, credential, oldest, trackingAlerts] = await Promise.all([
      prisma.autonomyPolicy.findUnique({
        where: { projectId },
        select: { adsMonthlyCapMinor: true },
      }),
      account?.credentialId
        ? prisma.integrationCredential.findUnique({
            where: { id: account.credentialId },
            select: { status: true, metadata: true },
          })
        : null,
      account
        ? prisma.adsInsightDaily.findFirst({
            where: {
              adsAccountId: account.id,
              level: "ACCOUNT",
              spendMinor: { gt: 0 },
            },
            orderBy: { date: "asc" },
            select: { date: true },
          })
        : null,
      prisma.adsAlert.count({
        where: {
          projectId,
          kind: "TRACKING_STALE",
          status: { in: ["OPEN", "ACKED"] },
        },
      }),
    ]);
    const health = tokenHealthOf(credential?.metadata);
    const today = account
      ? dayKeyInTimezone(now, safeTimezone(account.timezoneName))
      : now.toISOString().slice(0, 10);
    const historyDays = oldest
      ? Math.floor(
          (Date.parse(`${today}T00:00:00.000Z`) - oldest.date.getTime()) /
            DAY_MS,
        )
      : 0;
    return {
      standardAccess: account?.accessTier === "standard_access",
      permanentToken: Boolean(
        credential?.status === "ACTIVE" && health?.isValid && !health.expiresAt,
      ),
      trackingHealthy: account?.healthStatus === "OK" && trackingAlerts === 0,
      historyDays,
      monthlyCapSet: Boolean(
        policy?.adsMonthlyCapMinor && policy.adsMonthlyCapMinor > BigInt(0),
      ),
      currency: account?.currency ?? null,
    };
  },

  async gates(
    decision: Pick<AdsDecision, "projectId" | "externalId">,
    account: AdsAccount,
    level: AutonomyLevel,
    candidate: AutoCandidate,
    now: Date,
  ): Promise<AutoGates> {
    const credential = account.credentialId
      ? await prisma.integrationCredential.findUnique({
          where: { id: account.credentialId },
          select: { status: true, metadata: true },
        })
      : null;
    const health = tokenHealthOf(credential?.metadata);
    const fresh = (at: Date | null) =>
      Boolean(at && now.getTime() - at.getTime() < MIRROR_FRESH_MS);
    const [actions, lastOp, lastDecision, object] = await Promise.all([
      prisma.adsDecision.count({
        where: {
          projectId: decision.projectId,
          autonomy: { in: ["GUARDED", "FULL"] },
          createdAt: { gt: new Date(now.getTime() - DAY_MS) },
        },
      }),
      prisma.adsOperation.findFirst({
        where: {
          targetExternalId: decision.externalId,
          kind: { in: ["UPDATE_CAMPAIGN", "UPDATE_ADSET"] },
          status: { in: ["SENT", "UNKNOWN", "SUCCEEDED", "RECONCILED"] },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.adsDecision.findFirst({
        where: {
          externalId: decision.externalId,
          kind: { in: ["BUDGET_UP", "BUDGET_DOWN", "ROLLBACK"] },
          appliedAt: { not: null },
        },
        orderBy: { appliedAt: "desc" },
        select: { appliedAt: true },
      }),
      prisma.adsObject.findFirst({
        where: { adsAccountId: account.id, externalId: decision.externalId },
        select: { driftAt: true },
      }),
    ]);
    const lastBudgetChangeAt =
      [lastOp?.createdAt, lastDecision?.appliedAt, object?.driftAt]
        .filter((at): at is Date => at instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    let full: AutoGates["full"];
    if (level === "FULL" && candidate.kind === "BUDGET_UP") {
      const timezone = safeTimezone(account.timezoneName);
      const today = dayKeyInTimezone(now, timezone);
      const [prerequisites, policy, mtd] = await Promise.all([
        this.fullPrerequisites(decision.projectId, now),
        prisma.autonomyPolicy.findUnique({
          where: { projectId: decision.projectId },
          select: { adsMonthlyCapMinor: true },
        }),
        monthToDateSpend(account, today),
      ]);
      const raise =
        (candidate.toBudgetMinor ?? 0) - (candidate.fromBudgetMinor ?? 0);
      full = {
        prerequisitesMet: fullPrerequisitesMet(prerequisites),
        monthlyCapMinor:
          policy?.adsMonthlyCapMinor === null ||
          policy?.adsMonthlyCapMinor === undefined
            ? null
            : Number(policy.adsMonthlyCapMinor),
        monthToDateSpendMinor: mtd,
        projectedExtraMinor: Math.max(0, raise) * daysLeftInMonth(today),
        accountLocalHour: hourInTimezone(now, timezone),
      };
    }

    return {
      level,
      flagOn: AdsFlags.autopilot(),
      tokenHealthy:
        credential?.status === "ACTIVE" &&
        health?.isValid !== false &&
        account.healthStatus !== "AUTH",
      mirrorFresh:
        fresh(account.lastStructureAt) && fresh(account.lastInsightsAt),
      writesDisabled: AdsFlags.writesDisabled(),
      actionsLast24h: actions,
      lastBudgetChangeAt,
      now,
      ...(full ? { full } : {}),
    };
  },

  // Karar kendiliğinden uygulanabiliyorsa görevi açar ve true döner; aksi
  // hâlde (Suggest, kapı, günlük sınır) false: çağıran her zamanki gibi
  // onaya önerir. Gerekçe kararın kanıtına yazılır.
  async tryDecision(
    decision: AdsDecision,
    input: {
      brandId: string;
      adAccountId: string;
      currency?: string | null;
      onPlatformResult?: boolean;
      now?: Date;
    },
  ): Promise<boolean> {
    const level = await adsAutonomyOf(decision.projectId);
    if (level === "SUGGEST") return false;
    const change = changeOf(decision);
    const kind =
      decision.kind === "PAUSE" ||
      decision.kind === "BUDGET_DOWN" ||
      decision.kind === "BUDGET_UP"
        ? decision.kind
        : null;
    if (!change || !kind) return false;
    const account = await prisma.adsAccount.findUnique({
      where: { id: decision.adsAccountId },
    });
    if (!account) return false;
    const now = input.now ?? new Date();
    const budget = change.field === "dailyBudgetMinor";
    const candidate: AutoCandidate = {
      ruleKey: decision.ruleKey,
      kind,
      fromBudgetMinor: budget ? Number(change.from) : null,
      toBudgetMinor: budget ? Number(change.to) : null,
      onPlatformResult: input.onPlatformResult,
    };
    const verdict = autopilotVerdict(
      candidate,
      await this.gates(decision, account, level, candidate, now),
    );
    if (!verdict.auto) {
      await this.note(decision, verdict);
      return false;
    }
    return this.execute(decision, {
      level,
      kind,
      from: Number(change.from),
      to: Number(change.to),
      brandId: input.brandId,
      adAccountId: input.adAccountId,
      currency: input.currency ?? account.currency,
      now,
    });
  },

  async note(decision: AdsDecision, verdict: AutoVerdict): Promise<void> {
    if (verdict.auto) return;
    const evidence =
      decision.evidence &&
      typeof decision.evidence === "object" &&
      !Array.isArray(decision.evidence)
        ? (decision.evidence as Record<string, unknown>)
        : {};
    await prisma.adsDecision
      .update({
        where: { id: decision.id },
        data: {
          evidence: {
            ...evidence,
            autopilot: verdict.reason,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  },

  async execute(
    decision: AdsDecision,
    input: {
      level: Exclude<AutonomyLevel, "SUGGEST">;
      kind: "PAUSE" | "BUDGET_DOWN" | "BUDGET_UP";
      from: number;
      to: number;
      brandId: string;
      adAccountId: string;
      currency: string | null;
      now: Date;
    },
  ): Promise<boolean> {
    const target = { level: decision.level, id: decision.externalId };
    const common = {
      workspaceId: decision.workspaceId,
      projectId: decision.projectId,
      brandId: input.brandId,
      request: decision.explanation.slice(0, 300),
      title: decision.explanation.slice(0, 80),
      createdByType: "SYSTEM" as const,
      departmentKey: "PERFORMANCE_MARKETING" as const,
      fingerprint: `auto:${decision.fingerprint}`,
    };
    const planned =
      input.kind === "BUDGET_UP"
        ? await TaskPlanner.planForCapability({
            ...common,
            capability:
              decision.level === "CAMPAIGN"
                ? "META_CAMPAIGN_UPDATE"
                : "META_ADSET_UPDATE",
            adsAutonomy: input.level,
            autoBudgetRaise: true,
            payloadExtra: {
              [decision.level === "CAMPAIGN" ? "campaignId" : "adSetId"]:
                decision.externalId,
              decisionId: decision.id,
              adAccountId: input.adAccountId,
              ...(input.currency ? { currency: input.currency } : {}),
              currentDailyBudgetCents: input.from,
              proposedDailyBudgetCents: input.to,
              expectedDailyBudgetCents: input.from,
              autopilot: input.level,
              reason: decision.explanation,
            },
          })
        : await TaskPlanner.planForCapability({
            ...common,
            capability: "META_SAFETY_ACTION",
            adsAutonomy: input.level,
            riskReducing: true,
            payloadExtra: {
              action: input.kind === "PAUSE" ? "PAUSE" : "BUDGET_DOWN",
              targets: [target],
              adAccountId: input.adAccountId,
              decisionId: decision.id,
              autopilot: input.level,
              reason: decision.explanation,
              ...(input.kind === "BUDGET_DOWN"
                ? {
                    expectedDailyBudgetCents: input.from,
                    toDailyBudgetCents: input.to,
                  }
                : {}),
            },
          });

    if (!planned.dispatched || !("job" in planned) || !planned.job) {
      // Proje override'ı seviyeyi yükseltti: karar onay bekler (öneri gibi).
      const approval = await prisma.approval.findFirst({
        where: { taskId: planned.task.id, status: "PENDING" },
        select: { id: true, expiresAt: true },
      });
      await prisma.adsDecision.update({
        where: { id: decision.id },
        data: {
          status: "PROPOSED",
          taskId: planned.task.id,
          approvalId: approval?.id ?? null,
          expiresAt:
            approval?.expiresAt ??
            new Date(input.now.getTime() + 72 * 60 * 60_000),
        },
      });
      return true;
    }

    await prisma.adsDecision.update({
      where: { id: decision.id },
      data: {
        autonomy: input.level,
        status: "APPLYING",
        taskId: planned.task.id,
        approvalId: null,
      },
    });
    await AuditLogRepository.record({
      workspaceId: decision.workspaceId,
      projectId: decision.projectId,
      actorType: "SYSTEM",
      action: "ads_autopilot.action",
      entityType: "AdsDecision",
      entityId: decision.id,
      metadata: {
        ruleKey: decision.ruleKey,
        kind: input.kind,
        level: input.level,
        externalId: decision.externalId,
        ...(input.kind === "PAUSE" ? {} : { from: input.from, to: input.to }),
      },
    }).catch(() => undefined);
    // Koruma beklemez: iş hemen sürülür, kalanını işçi devralır.
    await driveLaunchInline(planned.job.id, INLINE_DRIVE_MS);
    return true;
  },

  // Bekçi bulgusu (G1 kaçak harcama, G2 zarf / aylık tavan): kararı yalnız
  // otomatik uygulanacaksa yazar; Suggest'te uyarının Pause düğmesi kalır.
  async tryGuardPause(input: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    account: AdsAccount;
    level: "CAMPAIGN" | "ADSET";
    externalId: string;
    ruleKey: "G1_RUNAWAY" | "G2_ENVELOPE" | "G2_MONTHLY_CAP";
    explanation: string;
    evidence: Record<string, unknown>;
    dayKey: string;
    now: Date;
  }): Promise<boolean> {
    const level = await adsAutonomyOf(input.projectId);
    if (level === "SUGGEST") return false;
    const candidate: AutoCandidate = { ruleKey: input.ruleKey, kind: "PAUSE" };
    const verdict = autopilotVerdict(
      candidate,
      await this.gates(
        { projectId: input.projectId, externalId: input.externalId },
        input.account,
        level,
        candidate,
        input.now,
      ),
    );
    if (!verdict.auto) return false;
    let decision: AdsDecision;
    try {
      decision = await prisma.adsDecision.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          adsAccountId: input.account.id,
          level: input.level,
          externalId: input.externalId,
          ruleKey: input.ruleKey,
          ruleVersion: 1,
          kind: "PAUSE",
          severity: "CRITICAL",
          status: "APPROVED",
          evidence: input.evidence as Prisma.InputJsonValue,
          explanation: input.explanation,
          change: { field: "status", from: "ACTIVE", to: "PAUSED" },
          // Gün başına tek otomatik duraklatma denemesi.
          fingerprint: `${input.ruleKey}:${input.externalId}:${input.dayKey}`,
        },
      });
    } catch {
      return false;
    }
    return this.execute(decision, {
      level,
      kind: "PAUSE",
      from: 0,
      to: 0,
      brandId: input.brandId,
      adAccountId: input.account.externalId,
      currency: input.account.currency,
      now: input.now,
    });
  },
};
