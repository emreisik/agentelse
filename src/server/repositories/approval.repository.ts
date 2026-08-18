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

    await sendApprovalRequestToTelegram(approval);

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

    // Claim (compare-and-swap): aynı karar iki kez teslim edilirse (ör.
    // Telegram'ın aynı callback_query'i tekrar göndermesi, ya da web+
    // Telegram'dan neredeyse eşzamanlı çift tıklama) `from === to` no-op
    // olarak sessizce başarı dönmesin — sadece STATUS HÂLÂ okuduğumuz
    // değerdeyse güncelle, aksi halde "zaten karara bağlanmış" fırlat. Bu,
    // çağıranın (applyApprovalDecision) downstream dispatch'i (görev
    // başlatma/creative onaylama) iki kez çalıştırmasını engeller —
    // execution-worker.ts'teki resolvePendingVerifications ile aynı desen.
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
