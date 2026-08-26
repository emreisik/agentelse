import "server-only";

import type { ActorType, Approval } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { sendPublishPromptToTelegram } from "@/server/notifications/telegram-approval-notifier";

// Finds which idea's chat an approval decision (Task or Creative) belongs
// to and the title to show on the card — directly for a Task
// (resolveIdeaIdForTask), and for a Creative via the task that produced it
// (Creative.createdByTaskId), then the same lookup from there. If neither
// resolves (e.g. a manually created task/creative with no idea), returns
// null and is silently skipped.
async function resolveApprovalChatTarget(
  approval: Approval,
): Promise<{ ideaId: string | null; title: string } | null> {
  if (approval.entityType === "Task" && approval.taskId) {
    // ideaId may be null (a system-generated task with no idea lineage —
    // e.g. PerformanceOptimizer's proposals) — the decision card still
    // posts, into the project's general chat stream. Only `task` missing
    // (the task itself doesn't exist) is a real "nothing to show" case.
    const [ideaId, task] = await Promise.all([
      IdeaChatRepository.resolveIdeaIdForTask(approval.taskId),
      prisma.task.findUnique({
        where: { id: approval.taskId },
        select: { title: true },
      }),
    ]);
    if (!task) return null;
    return { ideaId, title: task.title };
  }

  if (approval.entityType === "Creative") {
    const creative = await prisma.creative.findUnique({
      where: { id: approval.entityId },
      select: { createdByTaskId: true },
    });
    if (!creative?.createdByTaskId) return null;
    const [ideaId, task] = await Promise.all([
      IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId),
      prisma.task.findUnique({
        where: { id: creative.createdByTaskId },
        select: { title: true },
      }),
    ]);
    if (!ideaId) return null;
    return { ideaId, title: task?.title ?? "Creative" };
  }

  return null;
}

// Both approveApprovalAction/rejectApprovalAction (web, src/server/actions/
// approval-actions.ts) AND the Telegram approval poller
// (src/server/integrations/telegram-approval-poller.ts) share this function.
// Session/tenant checks and revalidatePath are deliberately left OUT — the
// poller has neither a session nor a request context whose Next.js page
// cache needs revalidating.
export async function applyApprovalDecision(input: {
  approval: Approval;
  to: "APPROVED" | "REJECTED";
  reviewedByUserId: string;
  actorType: ActorType;
}): Promise<void> {
  const { approval, to, reviewedByUserId, actorType } = input;

  await ApprovalRepository.decide(
    approval.id,
    approval.projectId,
    to,
    reviewedByUserId,
  );

  if (approval.entityType === "Task" && approval.taskId) {
    if (to === "APPROVED") {
      await TaskPlanner.dispatchApprovedTask(
        approval.taskId,
        approval.projectId,
      );
    } else {
      await TaskRepository.transition(
        approval.taskId,
        approval.projectId,
        "CANCELLED",
      );
    }
  }
  if (approval.entityType === "Creative") {
    await CreativeRepository.transition(
      approval.entityId,
      approval.projectId,
      to === "APPROVED" ? "APPROVED" : "REJECTED",
    );
  }

  // Approval decisions are also subject to the "golden rule": who
  // approved/rejected what should show up here, in the idea's own chat,
  // without going to a separate panel. Best-effort — if it can't be linked
  // to an idea (a task/creative with no idea), it's silently skipped.
  try {
    const target = await resolveApprovalChatTarget(approval);
    if (target) {
      if (approval.entityType === "Creative") {
        // Non-null: resolveApprovalChatTarget's Creative branch already
        // returns null (not a target with a null ideaId) when no idea can
        // be resolved — unlike the Task branch, creatives are always
        // idea-scoped (see the function above).
        const creativeIdeaId = target.ideaId!;
        // Unlike Task, we do NOT convert the card into a generic
        // "approval-decision" card — the creative-ready card already
        // carries the image/title, so only the status field is updated to
        // avoid losing it (see resolveCreativeApprovalDecision).
        await IdeaChatRepository.resolveCreativeApprovalDecision({
          ideaId: creativeIdeaId,
          creativeId: approval.entityId,
          status: to,
        });

        // If approved, drop a SEPARATE question turn into the chat instead
        // of updating the same row — the "Share on Social Accounts" section
        // already exists on the creative-ready card but stayed quiet and
        // users didn't notice it. This resurfaces the same options
        // (PublishSection) in a separate, hard-to-miss card.
        if (to === "APPROVED") {
          await IdeaChatRepository.postSystemMessage({
            workspaceId: approval.workspaceId,
            projectId: approval.projectId,
            ideaId: target.ideaId,
            text: `📤 ${target.title} approved — want to share it on social media?`,
            card: {
              kind: "publish-prompt",
              creativeId: approval.entityId,
              title: target.title,
            },
          });
          // Send the same question to Telegram too — so the user can pick
          // "Post"/"Story"/"No" directly from Telegram without opening the
          // web app (see telegram-approval-poller.ts pubfeed/pubstory/pubskip).
          await sendPublishPromptToTelegram({
            projectId: approval.projectId,
            creativeId: approval.entityId,
            title: target.title,
          });
        }
      } else {
        // If the chat already has an OPEN "approval-request" card for the
        // task (see TaskPlanner.planForCapability -> postApprovalRequestCard)
        // that SAME row is updated with the result — the Approve/Reject
        // buttons disappear along with the decision, no second card appears.
        await IdeaChatRepository.resolveApprovalDecisionCard({
          workspaceId: approval.workspaceId,
          projectId: approval.projectId,
          ideaId: target.ideaId,
          approvalId: approval.id,
          text:
            to === "APPROVED"
              ? `✅ Approved: ${target.title}`
              : `❌ Rejected: ${target.title}`,
          card: {
            kind: "approval-decision",
            title: target.title,
            entityType: approval.entityType as "Task" | "Creative",
            decision: to,
          },
        });
      }
    }
  } catch (error) {
    console.error(
      "[approval-decisions] failed to write approval-decision card:",
      error,
    );
  }

  await AuditLogRepository.record({
    workspaceId: approval.workspaceId,
    projectId: approval.projectId,
    brandId: approval.brandId,
    actorType,
    actorId: reviewedByUserId,
    action: to === "APPROVED" ? "approval.approved" : "approval.rejected",
    entityType: "Approval",
    entityId: approval.id,
  });
}
