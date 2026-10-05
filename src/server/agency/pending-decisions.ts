import "server-only";

import { prisma } from "@/lib/prisma";
import { stripCapabilityPrefix } from "@/lib/labels/core";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { countEnabledPublishSchedules } from "@/server/chat/publish-schedule";
import {
  approvalCategory,
  buildApprovalDetails,
} from "@/server/execution/approval-details";
import type { IdeaEventCardData } from "@/types/idea-event-card";

export type PendingDecision = {
  approvalId: string;
  createdAt: string; // ISO
  card: IdeaEventCardData;
};

// Every PENDING approval of a project, rebuilt straight from the records
// as the same chat cards the pipeline posts (approval-request /
// creative-ready) — the Agency Desk's decisions tray renders these, so a
// decision never needs a separate Approval Center. Built from the rows
// rather than looked up from chat history on purpose: the Agency Desk
// only shows WEB turns, and a pipeline card may live in an idea thread or
// not exist at all (taskless week-planner creatives, legacy rows).
// Only Task and Creative approvals are ever created (task-planner.ts,
// execution-service.ts, instagram-week-planner.ts, creative-actions.ts);
// any other entityType is skipped rather than shown as an unactionable row.
function isPlannedAhead(scheduledFor: Date | null): boolean {
  return scheduledFor !== null && scheduledFor.getTime() > Date.now();
}

export async function getPendingDecisions(
  projectId: string,
): Promise<PendingDecision[]> {
  const approvals = await prisma.approval.findMany({
    where: { projectId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const first = approvals[0];
  if (!first) return [];

  const taskIds = approvals
    .filter((a) => a.entityType === "Task")
    .map((a) => a.entityId);
  const creativeIds = approvals
    .filter((a) => a.entityType === "Creative")
    .map((a) => a.entityId);

  const [tasks, creatives, publishScheduleCount, brand, publishTargets] =
    await Promise.all([
      taskIds.length
        ? prisma.task.findMany({
            where: { id: { in: taskIds }, projectId },
            select: {
              id: true,
              title: true,
              capability: true,
              riskLevel: true,
              departmentKey: true,
              payload: true,
            },
          })
        : Promise.resolve([]),
      creativeIds.length
        ? prisma.creative.findMany({
            where: { id: { in: creativeIds }, projectId },
            select: {
              id: true,
              title: true,
              status: true,
              platform: true,
              scheduledFor: true,
              createdByTaskId: true,
              currentVersionId: true,
              versions: {
                orderBy: { version: "desc" },
                take: 1,
                select: {
                  id: true,
                  version: true,
                  caption: true,
                  copy: true,
                  contentFormat: true,
                  asset: {
                    select: {
                      id: true,
                      mimeType: true,
                      width: true,
                      height: true,
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      // Same check autoPublishCreative makes — decides whether approving a
      // creative takes a calendar slot or publishes right away.
      countEnabledPublishSchedules(projectId),
      prisma.brand.findFirst({
        where: { id: first.brandId },
        select: { name: true },
      }),
      getPublishTargets(projectId),
    ]);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const creativeById = new Map(creatives.map((c) => [c.id, c]));
  // Mirrors autoPublishCreative's own gates: no Instagram connection → it
  // skips and asks instead, so no calendar/publish promise on the button.
  // Instagram specifically: a TikTok, LinkedIn, X or Facebook Page target
  // can't take the Instagram post the button promises.
  const approveIntent = !publishTargets.some((t) => t.platform === "instagram")
    ? undefined
    : publishScheduleCount > 0
      ? "calendar"
      : "publish";

  const decisions: PendingDecision[] = [];
  for (const approval of approvals) {
    const createdAt = approval.createdAt.toISOString();

    if (approval.entityType === "Task") {
      const task = taskById.get(approval.entityId);
      if (!task) continue;
      decisions.push({
        approvalId: approval.id,
        createdAt,
        card: {
          kind: "approval-request",
          approvalId: approval.id,
          taskId: task.id,
          title: stripCapabilityPrefix(task.title),
          department: task.departmentKey ?? undefined,
          riskLevel: task.riskLevel,
          details: buildApprovalDetails(task.capability, task.payload),
          category: approvalCategory(approval.type, approval.level),
        },
      });
      continue;
    }

    if (approval.entityType === "Creative") {
      const creative = creativeById.get(approval.entityId);
      if (!creative) continue;
      const version = creative.versions[0];
      decisions.push({
        approvalId: approval.id,
        createdAt,
        card: {
          kind: "creative-ready",
          taskId: creative.createdByTaskId ?? undefined,
          title: creative.title ?? "Creative",
          creativeId: creative.id,
          assetId: version?.asset?.id,
          mimeType: version?.asset?.mimeType,
          caption: version?.caption ?? undefined,
          copy: version?.copy ?? undefined,
          status: creative.status,
          assetWidth: version?.asset?.width ?? undefined,
          assetHeight: version?.asset?.height ?? undefined,
          platform: creative.platform,
          contentFormat: version?.contentFormat,
          approvalId: approval.id,
          versionNumber: version?.version,
          brandName: brand?.name,
          // Only Instagram is reachable by autoPublishCreative — anything
          // else falls back to the "want to share it?" prompt, so a plain
          // "Approve" is the honest label there.
          approveIntent:
            creative.platform !== "INSTAGRAM"
              ? undefined
              : // A piece with a planned time still ahead is kept for that
                // time, never posted on approval (see autoPublishCreative).
                approveIntent && isPlannedAhead(creative.scheduledFor)
                ? "planned"
                : approveIntent,
        },
      });
    }
  }

  return decisions;
}
