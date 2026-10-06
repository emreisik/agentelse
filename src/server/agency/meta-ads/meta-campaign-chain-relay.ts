import "server-only";

import { prisma } from "@/lib/prisma";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { TaskRepository } from "@/server/repositories/task.repository";

type PendingAdSet = {
  name: string;
  dailyBudgetCents: number;
  billingEvent: string;
  optimizationGoal: string;
  targeting: { countries: string[] };
  // Ad set'in kaç gün çalışacağı: bitiş tarihi ad set kurulurken (zincir üç
  // ayrı onay bekleyebildiği için Launch anında değil) hesaplanır
  // (docs/meta-ads-plan.md F0b). Mutlak bir tarih taşınsaydı plan kısalır ya
  // da geçmişte kalırdı.
  durationDays?: number;
  advantageAudience?: 0 | 1;
  dsa?: { beneficiary: string; payor: string };
  // Onay anındaki reklam hesabı ve para birimi; ad set başka bir hesaba
  // kurulamaz (nesne-hesap doğrulaması).
  adAccountId?: string;
  currency?: string;
  // Everything META_AD_CREATE needs once the AdSet exists — carried
  // through untouched, exactly like meta-adset-chain-relay.ts's own
  // `pendingAd.raw` does for the human-wizard path.
  pendingAd: {
    name: string;
    message: string;
    link: string;
    imageAssetId: string;
  };
};

function readPendingAdSet(payload: unknown): PendingAdSet | null {
  const record = (payload ?? {}) as Record<string, unknown>;
  const pendingAdSet = record.__pendingAdSet as
    Record<string, unknown> | undefined;
  if (
    !pendingAdSet ||
    typeof pendingAdSet.name !== "string" ||
    typeof pendingAdSet.dailyBudgetCents !== "number" ||
    typeof pendingAdSet.billingEvent !== "string" ||
    typeof pendingAdSet.optimizationGoal !== "string" ||
    !pendingAdSet.targeting ||
    !pendingAdSet.pendingAd
  ) {
    return null;
  }
  return pendingAdSet as unknown as PendingAdSet;
}

// TASK_COMPLETED fan-out for the AUTONOMOUS campaign-proposal path (see
// approval-decisions.ts's auto-publish/auto-campaign branch): symmetric to
// meta-adset-chain-relay.ts's MetaAdSetChainRelay, one link earlier in the
// same chain. A completed META_CAMPAIGN_CREATE task whose payload carries
// `__pendingAdSet` plans the AdSet as a second, independent Task/Approval —
// its own payload already carries a `pendingAd` field shaped exactly like
// what MetaAdSetChainRelay.readPendingAd() expects, so THAT relay (already
// wired, unchanged) picks up the Ad automatically once the AdSet completes.
// If the Campaign is rejected or its execution fails, this task never
// reaches COMPLETED and `__pendingAdSet` is simply never dispatched — no
// cleanup needed, the same safe default the sibling relay relies on.
//
// Must never throw: registerTaskCompletedHandler's handlers for one
// trigger run sequentially with NO per-handler isolation
// (continuous-agency-engine.ts) — a throw here would retry (and re-run)
// every OTHER handler registered for the same trigger up to 5 times, and
// could starve handlers registered after this one (MeasurementEngine's).
export const MetaCampaignChainRelay = {
  async onTaskCompleted(taskId: string): Promise<void> {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status !== "COMPLETED") return;
    if (task.capability !== "META_CAMPAIGN_CREATE") return;

    const pendingAdSet = readPendingAdSet(task.payload);
    if (!pendingAdSet) return;

    // Dedup: ties the spawned AdSet task's identity to the Campaign task
    // that produced it, mirroring meta-adset-chain-relay.ts's own dedup for
    // its Ad fan-out — a duplicate fan-out (e.g. a retried trigger) finds
    // its own prior output and no-ops instead of creating a second AdSet.
    const fingerprint = taskFingerprint({
      capability: "META_ADSET_CREATE",
      department: "PERFORMANCE_MARKETING",
      subject: taskId,
    });
    const existing = await TaskRepository.findRecentByFingerprint(
      task.projectId,
      fingerprint,
      new Date(0),
    );
    if (existing) return;

    const job = await prisma.executionJob.findFirst({
      where: { taskId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { rawResult: true },
    });
    const rawResult = (job?.rawResult ?? {}) as Record<string, unknown>;
    const campaignId =
      typeof rawResult.campaignId === "string"
        ? rawResult.campaignId
        : undefined;
    if (!campaignId) return;

    await TaskPlanner.planForCapability({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
      capability: "META_ADSET_CREATE",
      request: `Create Meta ad set: ${pendingAdSet.name}`,
      createdByType: "SYSTEM",
      departmentKey: "PERFORMANCE_MARKETING",
      fingerprint,
      // Alanlar tek tek kopyalanır: yeni bir alan buraya eklenmezse Meta'ya
      // ulaşmaz (bitiş tarihi bu yüzden kayboluyordu).
      payloadExtra: {
        campaignId,
        name: pendingAdSet.name,
        dailyBudgetCents: pendingAdSet.dailyBudgetCents,
        billingEvent: pendingAdSet.billingEvent,
        optimizationGoal: pendingAdSet.optimizationGoal,
        targeting: pendingAdSet.targeting,
        pendingAd: pendingAdSet.pendingAd,
        ...(typeof pendingAdSet.durationDays === "number"
          ? { durationDays: pendingAdSet.durationDays }
          : {}),
        ...(pendingAdSet.advantageAudience === 0 ||
        pendingAdSet.advantageAudience === 1
          ? { advantageAudience: pendingAdSet.advantageAudience }
          : {}),
        ...(pendingAdSet.dsa ? { dsa: pendingAdSet.dsa } : {}),
        ...(pendingAdSet.adAccountId
          ? { adAccountId: pendingAdSet.adAccountId }
          : {}),
        ...(pendingAdSet.currency ? { currency: pendingAdSet.currency } : {}),
      },
    });
  },
};
