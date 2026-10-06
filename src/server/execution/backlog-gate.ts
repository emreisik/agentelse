import "server-only";

import type { CapabilityKey } from "@prisma/client";

import {
  isMetaSpendWrite,
  STALE_AFTER_OUTAGE_CODE,
  STALE_AFTER_OUTAGE_REASON,
  staleWriteReason,
} from "@/lib/execution-backlog";
import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { TaskRepository } from "@/server/repositories/task.repository";

// Birikim kapısı (docs/meta-ads-plan.md F0a): işçi uzun süre durduktan sonra
// yeniden açılınca kuyrukta bekleyen Meta yazmaları, onaylandıkları andaki
// bağlamla değil bugünkü bağlamla çalışırdı (bütçe, hesap seçimi, kampanya
// durumu değişmiş olabilir). Kapı dispatch'te değil işçinin claim noktasındadır
// (ExecutionService.startExecution), çünkü kesintide biriken işler zaten
// dispatch edilmiş durumdadır (ExecutionJob QUEUED, outbox PENDING).

export {
  isMetaSpendWrite,
  STALE_AFTER_OUTAGE_CODE,
  STALE_AFTER_OUTAGE_REASON,
  STALE_APPROVAL_MS,
  STALE_TASK_MS,
  staleWriteReason,
} from "@/lib/execution-backlog";

type GateJob = {
  id: string;
  taskId: string;
  workspaceId: string;
  projectId: string;
  capability: CapabilityKey;
};

export const BacklogGate = {
  // true: iş bayattı ve iptal edildi; çağıran sağlayıcıyı çağırmamalı.
  async cancelIfStale(job: GateJob, now: Date = new Date()): Promise<boolean> {
    if (!isMetaSpendWrite(job.capability)) return false;

    const [task, approval] = await Promise.all([
      prisma.task.findUnique({
        where: { id: job.taskId },
        select: { createdAt: true, status: true },
      }),
      prisma.approval.findFirst({
        where: { taskId: job.taskId, status: "APPROVED" },
        orderBy: { reviewedAt: "desc" },
        select: { reviewedAt: true },
      }),
    ]);
    if (!task) return false;

    const reason = staleWriteReason({
      capability: job.capability,
      taskCreatedAt: task.createdAt,
      approvedAt: approval?.reviewedAt ?? null,
      now,
    });
    if (!reason) return false;

    // CAS: yalnız hâlâ QUEUED olan iş iptal edilir; başka bir işçi onu
    // çoktan aldıysa dokunulmaz.
    const cancelled = await prisma.executionJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: {
        status: "CANCELLED",
        errorCode: STALE_AFTER_OUTAGE_CODE,
        errorMessage: `${STALE_AFTER_OUTAGE_REASON} (${reason})`,
        retryable: false,
        completedAt: now,
      },
    });
    if (cancelled.count !== 1) return false;

    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) {
      await TaskRepository.transition(job.taskId, job.projectId, "CANCELLED", {
        failureReason: STALE_AFTER_OUTAGE_REASON,
      }).catch((error) => {
        console.error(
          `[backlog-gate] task ${job.taskId} could not be cancelled:`,
          error instanceof Error ? error.message : error,
        );
      });
    }

    await AuditLogRepository.record({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      actorType: "SYSTEM",
      action: "execution.stale_write_cancelled",
      entityType: "ExecutionJob",
      entityId: job.id,
      metadata: { capability: job.capability, reason },
    }).catch(() => undefined);

    return true;
  },
};
