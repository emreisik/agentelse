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
import { TaskRepository } from "@/server/repositories/task.repository";
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

    const now = new Date();
    // Süresi dolmuş onay karar anında da reddedilir: expireOverdue'nun
    // tick'ini beklemeden (docs/meta-ads-plan.md F0b).
    if (approval.expiresAt && approval.expiresAt <= now) {
      throw new AgentelseError(
        "INVALID_STATE_TRANSITION",
        "This approval expired. Ask again.",
      );
    }

    // L4 (harcama) onayı yalnız workspace OWNER/ADMIN'den gelir. Web,
    // Telegram, Works, plan ve post yolları applyApprovalDecision üzerinden,
    // sohbetin command-service yolu ise doğrudan buraya gelir; kapı bu yüzden
    // burada (docs/meta-ads-plan.md §3.9 Roller).
    if (approval.level === "LEVEL_4_CRITICAL" && to === "APPROVED") {
      await assertCanApproveSpend(
        approval.workspaceId,
        reviewedByUserId,
        approval.projectId,
      );
    }

    // GA-F7 ve SC-F8: yalnız OWNER/ADMIN karar verir (onay, ret, revizyon; sohbet yolu
    // dahil); 'telegram:<id>' sözde kullanıcısının rolü yoktur. İptal (CANCELLED)
    // sistem yoludur. CRITICAL_CHANGE_APPROVAL daha önce kullanılmıyordu; diğer
    // tiplerde sorgu çalışmaz.
    if (approval.type === "CRITICAL_CHANGE_APPROVAL" && to !== "CANCELLED") {
      await assertCanApproveCriticalChange(
        approval.workspaceId,
        reviewedByUserId,
      );
    }

    // Claim (compare-and-swap): if the same decision is delivered twice
    // (e.g. Telegram resending the same callback_query, or a near-simultaneous
    // double click from web + Telegram), don't let `from === to` silently
    // return success as a no-op — only update if STATUS is STILL the value
    // we read, otherwise throw "already decided". This keeps the caller
    // (applyApprovalDecision) from running the downstream dispatch (task
    // start / creative approval) twice — the same pattern as
    // resolvePendingVerifications in execution-worker.ts.
    const claim = await prisma.approval.updateMany({
      where: {
        id,
        projectId,
        status: approval.status,
        // Okuma ile yazma arasında süresi dolmuşsa da karar verilmez.
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        status: to,
        reviewedByUserId,
        reviewNote,
        reviewedAt: now,
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

  // Süresi dolan onayın görevi de kapanır (CANCELLED, "Approval expired"):
  // yalnız Approval satırı güncellendiğinde kart sonsuza dek "Still working"
  // diyordu (docs/meta-ads-plan.md F0b).
  async expireOverdue(now: Date = new Date()): Promise<{ count: number }> {
    const overdue = await prisma.approval.findMany({
      where: { status: "PENDING", expiresAt: { lt: now } },
      select: { id: true, projectId: true, taskId: true },
      take: 50,
    });
    let count = 0;
    for (const row of overdue) {
      const expired = await prisma.approval.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      if (expired.count !== 1) continue;
      count += 1;
      if (!row.taskId) continue;
      const task = await prisma.task.findUnique({
        where: { id: row.taskId },
        select: { status: true },
      });
      if (!task || ["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) {
        continue;
      }
      await TaskRepository.transition(row.taskId, row.projectId, "CANCELLED", {
        failureReason: "Approval expired",
      }).catch((error) => {
        console.error(
          `[approval] task ${row.taskId} of expired approval ${row.id} could not be cancelled:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
    return { count };
  },
};

const SPEND_APPROVER_ROLES = new Set(["OWNER", "ADMIN"]);

// F8 müşteri onaylayıcısı: OWNER/ADMIN olmayan üye yalnız kendisine atanmış
// projenin (AutonomyPolicy.adsSpendApproverIds) L4 onayını verebilir.
export async function canApproveSpend(
  workspaceId: string,
  userId: string,
  projectId: string | null,
): Promise<boolean> {
  // Telegram onaylayıcısı "telegram:<id>" sözde kullanıcısıdır; workspace
  // rolü yoktur, L4 veremez (Telegram'a L4 için yalnız bağlantı gider).
  if (userId.includes(":")) return false;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!member) return false;
  if (SPEND_APPROVER_ROLES.has(member.role)) return true;
  if (!projectId) return false;
  const policy = await prisma.autonomyPolicy.findUnique({
    where: { projectId },
    select: { workspaceId: true, adsSpendApproverIds: true },
  });
  return Boolean(
    policy &&
      policy.workspaceId === workspaceId &&
      policy.adsSpendApproverIds.includes(userId),
  );
}

// GA-F7 ve SC-F8: tenant-context import'u next-auth'u worker'a çekeceği için arama
// burada satır içi; autonomy-policy yedeği yok.
async function assertCanApproveCriticalChange(
  workspaceId: string,
  userId: string,
): Promise<void> {
  const denied = new AgentelseError(
    "PERMISSION_DENIED",
    "Only a workspace owner or admin can approve this change.",
  );
  if (userId.includes(":")) throw denied;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!member || !SPEND_APPROVER_ROLES.has(member.role)) throw denied;
}

async function assertCanApproveSpend(
  workspaceId: string,
  reviewedByUserId: string,
  projectId: string | null,
): Promise<void> {
  if (!(await canApproveSpend(workspaceId, reviewedByUserId, projectId))) {
    throw new AgentelseError(
      "PERMISSION_DENIED",
      "Only a workspace owner or admin, or this project's spend approver, can approve spending.",
    );
  }
}
