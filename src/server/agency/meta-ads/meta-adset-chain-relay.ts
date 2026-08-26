import "server-only";

import { prisma } from "@/lib/prisma";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { TaskRepository } from "@/server/repositories/task.repository";

type PendingAd = {
  name: string;
  message: string;
  link: string;
  callToActionType: string;
  imageAssetId: string;
  status: string;
};

function readPendingAd(payload: unknown): PendingAd | null {
  const record = (payload ?? {}) as Record<string, unknown>;
  const pendingAd = record.pendingAd as Record<string, unknown> | undefined;
  if (
    !pendingAd ||
    typeof pendingAd.name !== "string" ||
    typeof pendingAd.message !== "string" ||
    typeof pendingAd.link !== "string" ||
    typeof pendingAd.imageAssetId !== "string"
  ) {
    return null;
  }
  return {
    name: pendingAd.name,
    message: pendingAd.message,
    link: pendingAd.link,
    callToActionType:
      typeof pendingAd.callToActionType === "string"
        ? pendingAd.callToActionType
        : "LEARN_MORE",
    imageAssetId: pendingAd.imageAssetId,
    status: pendingAd.status === "ACTIVE" ? "ACTIVE" : "PAUSED",
  };
}

// TASK_COMPLETED fan-out for the combined AdSet+Ad wizard (see
// createMetaAdSetWithAdAction in meta-ads-actions.ts): the user fills out
// one form, but a META_AD_CREATE Task can't be planned until Meta has
// actually returned a real adSetId for the newly created ad set — which
// only exists once the AdSet's own Task/Approval has run to completion.
// This handler picks up right there: a completed META_ADSET_CREATE task
// whose payload carries `pendingAd` plans the Ad as a second, independent
// Task/Approval. If the AdSet is rejected or its execution fails, this
// task never reaches COMPLETED and pendingAd is simply never dispatched —
// no cleanup needed, that's the natural safe default.
export const MetaAdSetChainRelay = {
  async onTaskCompleted(taskId: string): Promise<void> {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status !== "COMPLETED") return;
    if (task.capability !== "META_ADSET_CREATE") return;

    const pendingAd = readPendingAd(task.payload);
    if (!pendingAd) return;

    // Ties the spawned Ad task's identity to the AdSet task that produced
    // it, so a duplicate fan-out (e.g. a retried trigger) finds its own
    // prior output and no-ops instead of creating a second Ad.
    const fingerprint = taskFingerprint({
      capability: "META_AD_CREATE",
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
    const adSetId =
      typeof rawResult.adSetId === "string" ? rawResult.adSetId : undefined;
    if (!adSetId) return;

    await TaskPlanner.planForCapability({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
      capability: "META_AD_CREATE",
      request: `Create Meta ad: ${pendingAd.name}`,
      createdByType: "SYSTEM",
      departmentKey: "PERFORMANCE_MARKETING",
      fingerprint,
      payloadExtra: {
        adSetId,
        name: pendingAd.name,
        message: pendingAd.message,
        link: pendingAd.link,
        callToActionType: pendingAd.callToActionType,
        imageAssetId: pendingAd.imageAssetId,
        status: pendingAd.status,
      },
    });
  },
};
