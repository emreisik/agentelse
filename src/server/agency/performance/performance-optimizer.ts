import "server-only";

import { taskFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import type { PerformanceFinding } from "./meta-performance-rules";

export type PerformanceScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type ProposeResult =
  | { proposed: true }
  | { proposed: false; reason: "no-action" | "cooldown" | "daily-cap" };

// Track 2 — a deterministic (non-LLM, non-Council) path straight to
// TaskPlanner.planForCapability. This is deliberately NOT routed through
// Idea/Council/Director: a rule-based budget correction doesn't need
// creative-quality judgment, and META_CAMPAIGN_UPDATE's real safety comes
// from its fixed LEVEL_4_CRITICAL floor in approval-policy.ts (never
// lowerable) — every proposal still lands as a WAITING_APPROVAL Task a
// human must decide on.
export const PerformanceOptimizer = {
  async proposeCampaignAction(input: {
    scope: PerformanceScope;
    campaignId: string;
    campaignName: string;
    currentDailyBudgetCents: number;
    finding: PerformanceFinding;
  }): Promise<ProposeResult> {
    const action = input.finding.suggestedAction;
    if (!action) return { proposed: false, reason: "no-action" };

    // Same fingerprint+cooldown gate AgencyDirector uses (agency-director.ts)
    // — keyed by campaignId, not finding text, so re-scanning the same
    // campaign every 7h doesn't spawn a new proposal while one is still
    // open. findRecentByFingerprint already excludes CANCELLED/FAILED, so
    // an open WAITING_APPROVAL task blocks a duplicate on its own — no
    // separate "is there an open approval" query needed.
    const fingerprint = taskFingerprint({
      capability: "META_CAMPAIGN_UPDATE",
      department: "PERFORMANCE_MARKETING",
      subject: input.campaignId,
    });
    const policy = await AutonomyPolicyRepository.getOrCreate(input.scope);
    const since = new Date(Date.now() - policy.taskCooldownHours * 3600_000);
    const duplicate = await TaskRepository.findRecentByFingerprint(
      input.scope.projectId,
      fingerprint,
      since,
    );
    if (duplicate) return { proposed: false, reason: "cooldown" };

    try {
      await AutonomyPolicyRepository.checkAndIncrement(
        input.scope,
        "tasksCreated",
      );
    } catch {
      return { proposed: false, reason: "daily-cap" };
    }

    await TaskPlanner.planForCapability({
      ...input.scope,
      capability: "META_CAMPAIGN_UPDATE",
      request: input.finding.title,
      createdByType: "SYSTEM",
      departmentKey: "PERFORMANCE_MARKETING",
      fingerprint,
      payloadExtra: {
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
    return { proposed: true };
  },
};
