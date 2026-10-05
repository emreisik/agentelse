import "server-only";

import type {
  ActorType,
  ApprovalLevel,
  ApprovalStatus,
  ApprovalType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";
import {
  sendApprovalRequestToTelegram,
  notifyApprovalDecision,
} from "@/server/notifications/telegram-approval-notifier";

export const ApprovalRepository = {
  listForProject(projectId: string, status?: ApprovalStatus) {
    return prisma.approval.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
    });
  },

  findByIdInProject(id: string, projectId: string) {
    return prisma.approval.findFirst({ where: { id, projectId } });
  },

  async create(input: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    taskId?: string;
    entityType: string;
    entityId: string;
    type: ApprovalType;
    // Agency OS approval level; null/omitted = legacy (treated as LEVEL_3).
    level?: ApprovalLevel;
    requestedByType: ActorType;
    requestedById?: string;
    expiresAt?: Date;
    // false for an approval behind a SYSTEM-created task (an unattended
    // weekly-plan-produce.ts run): the owner's "no background notifications"
    // decision (docs/brand-brain-loop.md) covers this just like it covers
    // the post's own result — the chat is where it's seen. Every other
    // caller omits this and keeps today's Telegram ping exactly as it is.
    notify?: boolean;
  }) {
    const approval = await prisma.approval.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        taskId: input.taskId,
        entityType: input.entityType,
        entityId: input.entityId,
        type: input.type,
        level: input.level,
        requestedByType: input.requestedByType,
        requestedById: input.requestedById,
        expiresAt: input.expiresAt,
        status: "PENDING",
      },
    });

    if (input.notify ?? true) await sendApprovalRequestToTelegram(approval);

    return approval;
  },

  async decide(
    id: string,
    projectId: string,
    to: Extract<
      ApprovalStatus,
      "APPROVED" | "REJECTED" | "REVISION_REQUESTED" | "CANCELLED"
    >,
    reviewedByUserId: string,
    reviewNote?: string,
  ) {
    const approval = await prisma.approval.findFirst({
      where: { id, projectId },
    });
    if (!approval)
      throw new AgentelseError(
        "NOT_FOUND",
        `Approval ${id} not found in project ${projectId}`,
      );

    StateMachine.assertApprovalTransition(approval.status, to);

    // Claim (compare-and-swap): if the same decision is delivered twice
    // (e.g. Telegram resending the same callback_query, or a near-simultaneous
    // double click from web + Telegram), don't let `from === to` silently
    // return success as a no-op — only update if STATUS is STILL the value
    // we read, otherwise throw "already decided". This keeps the caller
    // (applyApprovalDecision) from running the downstream dispatch (task
    // start / creative approval) twice — the same pattern as
    // resolvePendingVerifications in execution-worker.ts.
    const claim = await prisma.approval.updateMany({
      where: { id, projectId, status: approval.status },
      data: {
        status: to,
        reviewedByUserId,
        reviewNote,
        reviewedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new AgentelseError(
        "INVALID_STATE_TRANSITION",
        `Approval ${id} was already decided`,
      );
    }

    const updated = await prisma.approval.findFirstOrThrow({
      where: { id },
    });

    await notifyApprovalDecision(updated, to, reviewedByUserId);

    return updated;
  },

  expireOverdue() {
    return prisma.approval.updateMany({
      where: { status: "PENDING", expiresAt: { lt: new Date() } },
      data: { status: "EXPIRED" },
    });
  },
};
