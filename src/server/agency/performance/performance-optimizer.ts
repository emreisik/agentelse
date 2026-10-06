import "server-only";

import type { CapabilityKey, DepartmentKey } from "@prisma/client";

import { taskFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import type { PerformanceFinding } from "./meta-performance-rules";

export type PerformanceScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

// Onay anındaki reklam hesabı ve para birimi: onay kartı tutarı doğru birimle
// gösterir, sağlayıcı başka hesaba yazmaz (docs/meta-ads-plan.md F0b).
export type AccountContext = { adAccountId?: string; currency?: string };

function accountPayload(account?: AccountContext): Record<string, string> {
  return {
    ...(account?.adAccountId ? { adAccountId: account.adAccountId } : {}),
    ...(account?.currency ? { currency: account.currency } : {}),
  };
}

export type ProposeResult =
  | { proposed: true }
  | { proposed: false; reason: "no-action" | "cooldown" | "daily-cap" };

// Shared by proposeCampaignAction/proposeAdSetAction below — fingerprint +
// cooldown gate (same one AgencyDirector uses, agency-director.ts) + daily
// task cap, then TaskPlanner.planForCapability. Deliberately NOT routed
// through Idea/Council/Director: a rule-based budget correction doesn't
// need creative-quality judgment, and both capabilities' real safety comes
// from their fixed LEVEL_4_CRITICAL floor in approval-policy.ts (never
// lowerable) — every proposal still lands as a WAITING_APPROVAL Task a
// human must decide on. `subject` (campaignId/adSetId) keys the fingerprint
// so re-scanning the same entity every ~7h doesn't spawn a new proposal
// while one is still open — findRecentByFingerprint already excludes
// CANCELLED/FAILED, so an open WAITING_APPROVAL task blocks a duplicate on
// its own, no separate "is there an open approval" query needed.
async function proposeAction(input: {
  scope: PerformanceScope;
  capability: CapabilityKey;
  departmentKey?: DepartmentKey;
  subject: string;
  title: string;
  payloadExtra: Record<string, unknown>;
  // PAUSE / REDUCE: riski azaltan, deterministik (LLM yok) öneri. Günlük görev
  // kotası dolu diye kaçak harcamada bile öneri düşmesin
  // (docs/meta-ads-plan.md F0b).
  riskReducing?: boolean;
}): Promise<ProposeResult> {
  const departmentKey = input.departmentKey ?? "PERFORMANCE_MARKETING";
  const fingerprint = taskFingerprint({
    capability: input.capability,
    department: departmentKey,
    subject: input.subject,
  });
  const policy = await AutonomyPolicyRepository.getOrCreate(input.scope);
  const since = new Date(Date.now() - policy.taskCooldownHours * 3600_000);
  const duplicate = await TaskRepository.findRecentByFingerprint(
    input.scope.projectId,
    fingerprint,
    since,
  );
  if (duplicate) return { proposed: false, reason: "cooldown" };

  if (!input.riskReducing) {
    try {
      await AutonomyPolicyRepository.checkAndIncrement(
        input.scope,
        "tasksCreated",
      );
    } catch {
      // Düşen öneri iz bırakır: AuditLog'da ve /health'te görünür.
      await AuditLogRepository.record({
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        actorType: "SYSTEM",
        action: "ads.proposal_dropped",
        entityType: "MetaAdsProposal",
        entityId: input.subject,
        metadata: { capability: input.capability, reason: "daily-cap" },
      }).catch(() => undefined);
      return { proposed: false, reason: "daily-cap" };
    }
  }

  await TaskPlanner.planForCapability({
    ...input.scope,
    capability: input.capability,
    request: input.title,
    createdByType: "SYSTEM",
    departmentKey,
    fingerprint,
    payloadExtra: input.payloadExtra,
  });
  return { proposed: true };
}

export const PerformanceOptimizer = {
  async proposeCampaignAction(input: {
    scope: PerformanceScope;
    campaignId: string;
    campaignName: string;
    currentDailyBudgetCents: number;
    finding: PerformanceFinding;
    account?: AccountContext;
  }): Promise<ProposeResult> {
    const action = input.finding.suggestedAction;
    // Bütçe artırma önerisi F2'deki ayna ve doğru sonuç metriği gelene kadar
    // kapalı: yanlış sonuçla ölçeklemek para yakar (docs/meta-ads-plan.md F0b).
    if (!action || action.type === "SCALE_BUDGET") {
      return { proposed: false, reason: "no-action" };
    }

    return proposeAction({
      scope: input.scope,
      capability: "META_CAMPAIGN_UPDATE",
      subject: input.campaignId,
      title: input.finding.title,
      riskReducing: true,
      payloadExtra: {
        ...accountPayload(input.account),
        campaignId: input.campaignId,
        campaignName: input.campaignName,
        currentDailyBudgetCents: input.currentDailyBudgetCents,
        proposedDailyBudgetCents:
          action.type === "REDUCE_BUDGET"
            ? action.proposedDailyBudgetCents
            : undefined,
        proposedStatus: action.type === "PAUSE" ? "PAUSED" : undefined,
        reason: input.finding.summary,
        metricsSnapshot: input.finding.metricsSnapshot,
      },
    });
  },

  async proposeAdSetAction(input: {
    scope: PerformanceScope;
    campaignId: string;
    adSetId: string;
    adSetName: string;
    currentDailyBudgetCents: number;
    finding: PerformanceFinding;
    account?: AccountContext;
  }): Promise<ProposeResult> {
    const action = input.finding.suggestedAction;
    if (!action || action.type === "SCALE_BUDGET") {
      return { proposed: false, reason: "no-action" };
    }

    return proposeAction({
      scope: input.scope,
      capability: "META_ADSET_UPDATE",
      subject: input.adSetId,
      title: input.finding.title,
      riskReducing: true,
      payloadExtra: {
        ...accountPayload(input.account),
        adSetId: input.adSetId,
        adSetName: input.adSetName,
        campaignId: input.campaignId,
        currentDailyBudgetCents: input.currentDailyBudgetCents,
        proposedDailyBudgetCents:
          action.type === "REDUCE_BUDGET"
            ? action.proposedDailyBudgetCents
            : undefined,
        proposedStatus: action.type === "PAUSE" ? "PAUSED" : undefined,
        reason: input.finding.summary,
        metricsSnapshot: input.finding.metricsSnapshot,
      },
    });
  },
};
