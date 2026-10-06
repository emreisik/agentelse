import "server-only";

import {
  Prisma,
  type AdsDecision,
  type AdsDecisionStatus,
} from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import { formatMoney } from "@/lib/ads/money";
import { windowOf, type DayRow } from "@/lib/ads/rules/features";
import { outcomeOf } from "@/lib/ads/rules/stats";
import { addDays, safeTimezone } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { AdsAccounts } from "@/server/ads/accounts";
import { AutopilotNotify } from "@/server/ads/autopilot-notify";
import { TaskPlanner } from "@/server/commands/task-planner";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { readBack } from "@/server/integrations/meta/launch-writes";

// Optimizasyon karar kaydı (docs/meta-ads-plan.md §3.5): öneri → onay →
// uygulama → geri okuma → (veri olgunlaşınca) değerlendirme → geri alma.
// Para ya da durum değiştiren karar bir META_*_UPDATE görevine dönüşür
// (sistem önerisi: L4 onay); onay, ret ve süre dolumu görev kancalarından
// karara yansır.

export type DecisionChange = {
  field: "dailyBudgetMinor" | "status";
  from: number | string;
  to: number | string;
};

const SILENCE_AFTER_REJECT_MS = 14 * 24 * 60 * 60_000;
const VERIFY_AFTER_MS = 3 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// Veri olgunluğu: site dışı dönüşüm 7 gün, platform içi olay 2 gün.
const MATURITY_DAYS = { offsite: 7, onPlatform: 2 } as const;

export function changeOf(
  decision: Pick<AdsDecision, "change">,
): DecisionChange | null {
  const value = decision.change;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const change = value as Partial<DecisionChange>;
  return change.field && change.from !== undefined && change.to !== undefined
    ? (change as DecisionChange)
    : null;
}

function isUnique(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export const AdsDecisions = {
  async create(
    data: Prisma.AdsDecisionUncheckedCreateInput,
  ): Promise<AdsDecision | null> {
    try {
      return await prisma.adsDecision.create({ data });
    } catch (error) {
      if (isUnique(error)) return null;
      throw error;
    }
  },

  // Reddedilen karar aynı kural ve nesne için 14 gün susar (parmak iziyle
  // değil sorguyla, §3.5).
  async rejectedRecently(
    adsAccountId: string,
    externalId: string,
    ruleKey: string,
    now: Date,
  ): Promise<boolean> {
    const found = await prisma.adsDecision.findFirst({
      where: {
        adsAccountId,
        externalId,
        ruleKey,
        status: "REJECTED",
        createdAt: { gt: new Date(now.getTime() - SILENCE_AFTER_REJECT_MS) },
      },
      select: { id: true },
    });
    return Boolean(found);
  },

  // Para / durum kararını görev olarak önerir (sistem önerisi → L4 onay).
  async propose(
    decision: AdsDecision,
    input: {
      brandId: string;
      currency: string | null;
      adAccountId: string;
      campaignId?: string | null;
      campaignName?: string | null;
      dailyBudgetMinor?: number | null;
      // Kullanıcının kendi tıklaması (Undo): görev onun adına açılır.
      actor?: { type: "USER"; userId: string };
    },
  ): Promise<AdsDecision> {
    const change = changeOf(decision);
    if (!change) return decision;
    const capability =
      decision.level === "AD"
        ? "META_AD_UPDATE"
        : decision.level === "CAMPAIGN"
          ? "META_CAMPAIGN_UPDATE"
          : "META_ADSET_UPDATE";
    const idKey =
      decision.level === "AD"
        ? "adId"
        : decision.level === "CAMPAIGN"
          ? "campaignId"
          : "adSetId";
    const payload: Record<string, unknown> = {
      [idKey]: decision.externalId,
      decisionId: decision.id,
      adAccountId: input.adAccountId,
      ...(input.currency ? { currency: input.currency } : {}),
      reason: decision.explanation,
      ...(input.campaignId && decision.level !== "CAMPAIGN"
        ? { campaignId: input.campaignId }
        : {}),
      ...(input.campaignName ? { campaignName: input.campaignName } : {}),
    };
    if (change.field === "status") {
      if (decision.level === "AD") payload.status = change.to;
      else payload.proposedStatus = change.to;
      payload.expectedStatus = change.from;
    } else {
      payload.currentDailyBudgetCents = Number(change.from);
      payload.proposedDailyBudgetCents = Number(change.to);
      // Uygulamada CAS: bütçe o arada değiştiyse karar SUPERSEDED olur.
      payload.expectedDailyBudgetCents = Number(change.from);
    }
    const planned = await TaskPlanner.planForCapability({
      workspaceId: decision.workspaceId,
      projectId: decision.projectId,
      brandId: input.brandId,
      capability,
      request: decision.explanation.slice(0, 300),
      title: decision.explanation.slice(0, 80),
      createdByType: input.actor?.type ?? "SYSTEM",
      ...(input.actor ? { createdByUserId: input.actor.userId } : {}),
      departmentKey: "PERFORMANCE_MARKETING",
      fingerprint: decision.fingerprint,
      payloadExtra: payload,
    });
    const approval = await prisma.approval.findFirst({
      where: { taskId: planned.task.id, status: "PENDING" },
      select: { id: true, expiresAt: true },
    });
    return prisma.adsDecision.update({
      where: { id: decision.id },
      data: {
        taskId: planned.task.id,
        approvalId: approval?.id ?? null,
        expiresAt:
          approval?.expiresAt ?? new Date(Date.now() + 72 * 60 * 60_000),
      },
    });
  },

  // Görev tamamlandı: karar uygulandı; değerlendirme zamanı verinin
  // olgunlaşmasına göre konur.
  async onTaskCompleted(taskId: string, now: Date = new Date()): Promise<void> {
    const decision = await prisma.adsDecision.findFirst({ where: { taskId } });
    if (!decision) return;
    const offsite = /offsite/i.test(JSON.stringify(decision.evidence ?? {}));
    const lag = offsite ? MATURITY_DAYS.offsite : MATURITY_DAYS.onPlatform;
    const applied = await prisma.adsDecision.updateMany({
      where: {
        id: decision.id,
        status: { in: ["PROPOSED", "APPROVED", "APPLYING", "SHADOW"] },
      },
      data: {
        status: "APPLIED",
        appliedAt: now,
        evaluateAfter: new Date(now.getTime() + (7 + lag) * DAY_MS),
      },
    });
    if (decision.rollbackOfId) {
      await prisma.adsDecision.updateMany({
        where: { id: decision.rollbackOfId },
        data: { status: "ROLLED_BACK" },
      });
      await AutopilotNotify.undone(decision.rollbackOfId, decision.projectId, now).catch(
        () => undefined,
      );
    }
    // Otomatik pilot eylemi sonradan bildirilir (F7).
    if (
      applied.count === 1 &&
      (decision.autonomy === "GUARDED" || decision.autonomy === "FULL")
    ) {
      await AutopilotNotify.applied(decision, now).catch(() => undefined);
    }
  },

  async onTaskTerminal(
    taskId: string,
    status: "FAILED" | "CANCELLED",
  ): Promise<void> {
    const decision = await prisma.adsDecision.findFirst({ where: { taskId } });
    if (!decision) return;
    const approval = decision.approvalId
      ? await prisma.approval.findUnique({
          where: { id: decision.approvalId },
          select: { status: true },
        })
      : null;
    const job = await prisma.executionJob.findFirst({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      select: { errorCode: true },
    });
    const next: AdsDecisionStatus =
      approval?.status === "REJECTED"
        ? "REJECTED"
        : approval?.status === "EXPIRED"
          ? "EXPIRED"
          : job?.errorCode === "META:STATE:superseded"
            ? "SUPERSEDED"
            : status === "CANCELLED"
              ? "EXPIRED"
              : "FAILED";
    const moved = await prisma.adsDecision.updateMany({
      where: {
        id: decision.id,
        status: { in: ["PROPOSED", "APPROVED", "APPLYING"] },
      },
      data: { status: next },
    });
    // Başarısız otomatik eylem CRITICAL'dır (insan devralmalı).
    if (
      moved.count === 1 &&
      next === "FAILED" &&
      (decision.autonomy === "GUARDED" || decision.autonomy === "FULL")
    ) {
      await AutopilotNotify.failed(decision).catch(() => undefined);
    }
  },

  // Uygulanan değer Meta'da gerçekten öyle mi (2-5 dk sonra geri okuma)?
  async verifyDue(limit = 10, now: Date = new Date()): Promise<number> {
    const due = await prisma.adsDecision.findMany({
      where: {
        status: "APPLIED",
        appliedAt: { lt: new Date(now.getTime() - VERIFY_AFTER_MS) },
        change: { not: Prisma.DbNull },
      },
      take: limit,
      orderBy: { appliedAt: "asc" },
    });
    let verified = 0;
    for (const decision of due) {
      const change = changeOf(decision);
      if (!change) continue;
      const account = await AdsAccounts.resolveWithToken(
        decision.projectId,
      ).catch(() => null);
      if (!account || !("accessToken" in account)) continue;
      try {
        const read = await withMetaCallContext(
          {
            account: account.adAccountId,
            lane: "P2_BACKGROUND",
            callSite: "ads.decision-verify",
          },
          () =>
            readBack<{
              daily_budget?: string;
              status?: string;
              configured_status?: string;
            }>(
              decision.externalId,
              account.accessToken,
              change.field === "status"
                ? "status,configured_status"
                : "daily_budget",
            ),
        );
        const now_ =
          change.field === "status"
            ? (read.configured_status ?? read.status)
            : Number(read.daily_budget);
        const ok = String(now_) === String(change.to);
        await prisma.adsDecision.update({
          where: { id: decision.id },
          data: ok
            ? { status: "VERIFIED", verifiedAt: now }
            : {
                status: "FAILED",
                outcomeData: {
                  verify: { expected: change.to, found: now_ ?? null },
                },
              },
        });
        if (ok) verified += 1;
      } catch {
        // Bir sonraki turda yeniden denenir.
      }
    }
    return verified;
  },

  // Olgun veriyle değerlendirme: aynı uzunlukta önce / sonra pencereleri.
  async evaluateDue(limit = 20, now: Date = new Date()): Promise<number> {
    const due = await prisma.adsDecision.findMany({
      where: {
        status: { in: ["VERIFIED", "APPLIED"] },
        evaluateAfter: { lt: now },
        evaluatedAt: null,
      },
      take: limit,
    });
    let evaluated = 0;
    for (const decision of due) {
      if (!decision.appliedAt) continue;
      const account = await prisma.adsAccount.findUnique({
        where: { id: decision.adsAccountId },
        select: { timezoneName: true, currency: true },
      });
      const tz = safeTimezone(account?.timezoneName);
      const appliedDay = dayKeyInTimezone(decision.appliedAt, tz);
      const rows = await prisma.adsInsightDaily.findMany({
        where: {
          adsAccountId: decision.adsAccountId,
          externalId: decision.externalId,
          level: decision.level,
          date: {
            gte: new Date(`${addDays(appliedDay, -7)}T00:00:00Z`),
            lte: new Date(`${addDays(appliedDay, 7)}T00:00:00Z`),
          },
        },
      });
      const days: DayRow[] = rows.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        spendMinor: Number(row.spendMinor),
        impressions: row.impressions,
        clicks: row.clicks,
        linkClicks: row.linkClicks,
        results: row.results,
        video3s: row.video3s,
        thruplays: row.thruplays,
      }));
      const before = windowOf(
        days,
        addDays(appliedDay, -7),
        addDays(appliedDay, -1),
      );
      const after = windowOf(
        days,
        addDays(appliedDay, 1),
        addDays(appliedDay, 7),
      );
      const result = outcomeOf(
        decision.kind,
        { spendMinor: before.spendMinor, results: before.results ?? 0 },
        { spendMinor: after.spendMinor, results: after.results ?? 0 },
      );
      await prisma.adsDecision.update({
        where: { id: decision.id },
        data: {
          evaluatedAt: now,
          outcome: result.outcome,
          outcomeData: {
            before: { spendMinor: before.spendMinor, results: before.results },
            after: { spendMinor: after.spendMinor, results: after.results },
            ratio: result.ratio,
            dataDate: now.toISOString().slice(0, 10),
          },
        },
      });
      evaluated += 1;
      // İşe yaramayan bütçe artışı için geri alma önerilir.
      if (
        result.outcome === "DIDNT" &&
        decision.kind === "BUDGET_UP" &&
        AdsFlags.optimizer() === "on"
      ) {
        await this.rollback(decision.id, {
          actor: "SYSTEM",
          currency: account?.currency ?? null,
        }).catch(() => null);
      }
    }
    return evaluated;
  },

  // Süresi dolan öneri (görevsiz bilgi kararı).
  async expireDue(now: Date = new Date()): Promise<number> {
    const result = await prisma.adsDecision.updateMany({
      where: { status: "PROPOSED", taskId: null, expiresAt: { lt: now } },
      data: { status: "EXPIRED" },
    });
    return result.count;
  },

  // Geri alma: previous değerine dönen ters karar. Kullanıcı tıkladıysa
  // görev onu (OWNER/ADMIN) onaylatır; sistem önerisi onay bekler.
  async rollback(
    decisionId: string,
    input: {
      actor: "USER" | "SYSTEM";
      userId?: string;
      currency: string | null;
    },
    now: Date = new Date(),
  ): Promise<{ decision: AdsDecision; taskId: string } | null> {
    const original = await prisma.adsDecision.findUnique({
      where: { id: decisionId },
    });
    const change = original ? changeOf(original) : null;
    if (!original || !change) return null;
    if (original.status !== "APPLIED" && original.status !== "VERIFIED")
      return null;
    const reverse: DecisionChange = {
      field: change.field,
      from: change.to,
      to: change.from,
    };
    const project = await prisma.project.findUnique({
      where: { id: original.projectId },
      select: { workspaceId: true },
    });
    const brand = await prisma.brand.findFirst({
      where: { projectId: original.projectId, isDefault: true },
      select: { id: true },
    });
    if (!project || !brand) return null;
    const account = await AdsAccounts.resolve(original.projectId);
    const text =
      change.field === "dailyBudgetMinor"
        ? `Change the daily budget back from ${formatMoney(Number(change.to), input.currency)} to ${formatMoney(Number(change.from), input.currency)}.`
        : `Change the status back to ${String(change.from).toLowerCase()}.`;
    const created = await this.create({
      workspaceId: original.workspaceId,
      projectId: original.projectId,
      adsAccountId: original.adsAccountId,
      level: original.level,
      externalId: original.externalId,
      ruleKey: "UNDO",
      ruleVersion: 1,
      kind: "ROLLBACK",
      severity: "INFO",
      status: "PROPOSED",
      evidence: { rollbackOf: original.id, actor: input.actor },
      explanation: text,
      change: reverse as unknown as Prisma.InputJsonValue,
      fingerprint: `UNDO:${original.id}:${now.getTime()}`,
      rollbackOfId: original.id,
    });
    if (!created) return null;
    const proposed = await this.propose(created, {
      brandId: brand.id,
      currency: input.currency,
      adAccountId: account.adAccountId ?? "",
      ...(input.actor === "USER" && input.userId
        ? { actor: { type: "USER" as const, userId: input.userId } }
        : {}),
    });
    return proposed.taskId
      ? { decision: proposed, taskId: proposed.taskId }
      : null;
  },

  // Ads kartının "Undo"su: son 7 günde uygulanan, geri alınmamış en yeni
  // para / durum kararı.
  async undoable(projectId: string, now: Date = new Date()) {
    return prisma.adsDecision.findFirst({
      where: {
        projectId,
        status: { in: ["APPLIED", "VERIFIED"] },
        kind: { in: ["BUDGET_UP", "BUDGET_DOWN", "PAUSE"] },
        appliedAt: { gt: new Date(now.getTime() - 7 * DAY_MS) },
        change: { not: Prisma.DbNull },
      },
      orderBy: { appliedAt: "desc" },
    });
  },
};
