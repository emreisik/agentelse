import "server-only";

import { prisma } from "@/lib/prisma";
import {
  OUTBOX_EVENT_TYPES,
  OutboxRepository,
} from "@/server/repositories/outbox.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  classifyError,
  isAutoRecoverable,
} from "@/server/observability/error-classifier";

// Otomatik kurtarma. Kapsamı bilinçli olarak dar: sistemin KENDİ çalışma
// durumunu onarır (takılmış iş, yeniden denenebilir hatayla ölü kuyruğa
// düşmüş iş). Kod yazmaz, şema değiştirmez, insan kararı gerektiren hiçbir
// şeyi kendi başına onaylamaz.
//
// Her kurtarma AuditLog'a yazılır: neyin niçin otomatik onarıldığı geriye
// dönük olarak görülebilir olmalı.

// Bir sağlayıcı çağrısı bu süreden uzun RUNNING kalmışsa takılmıştır:
// en yavaş gerçek yol (OpenClaw tarayıcı turu) dakikalar sürer, saat değil.
const STUCK_JOB_AFTER_MS = 30 * 60_000;
// Aynı iş için bu kadar ölü-kuyruk kaydı birikmişse otomatik kurtarma
// döngüye girmiş demektir — insana bırak.
const MAX_AUTO_REQUEUES_PER_JOB = 3;

export type HealingReport = {
  stuckJobsReset: number;
  deadLettersRequeued: number;
  deadLettersSkipped: number;
};

export const SelfHealingService = {
  async run(now = new Date()): Promise<HealingReport> {
    const stuckJobsReset = await this.resetStuckJobs(now);
    const { requeued, skipped } = await this.requeueRecoverableDeadLetters();
    return {
      stuckJobsReset,
      deadLettersRequeued: requeued,
      deadLettersSkipped: skipped,
    };
  },

  // pollRunningJobs sağlayıcı hatasını yutup işi RUNNING bırakabiliyor;
  // sonuç, sonsuza kadar yoklanan ve hiçbir zaman bitmeyen bir iş. Bunları
  // açıkça FAILED'a çevirir ki normal retry/dead-letter yolu devreye girsin.
  async resetStuckJobs(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - STUCK_JOB_AFTER_MS);
    const stuck = await prisma.executionJob.findMany({
      where: {
        status: { in: ["RUNNING", "WAITING_PROVIDER"] },
        updatedAt: { lt: cutoff },
      },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        capability: true,
        providerId: true,
        updatedAt: true,
      },
      take: 25,
    });

    let reset = 0;
    for (const job of stuck) {
      // Koşullu güncelleme: bu arada gerçekten ilerlediyse dokunma.
      const result = await prisma.executionJob.updateMany({
        where: {
          id: job.id,
          status: { in: ["RUNNING", "WAITING_PROVIDER"] },
          updatedAt: { lt: cutoff },
        },
        data: {
          status: "FAILED",
          errorCode: "STUCK_TIMEOUT",
          errorMessage: `İş ${Math.round(
            (now.getTime() - job.updatedAt.getTime()) / 60_000,
          )} dakikadır ilerlemiyor — otomatik olarak zaman aşımına uğratıldı`,
          retryable: true,
          completedAt: now,
        },
      });
      if (result.count !== 1) continue;

      reset += 1;
      await AuditLogRepository.record({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        actorType: "SYSTEM",
        action: "self-healing.stuck_job_reset",
        entityType: "ExecutionJob",
        entityId: job.id,
        metadata: {
          capability: job.capability,
          providerId: job.providerId,
          stuckSinceMinutes: Math.round(
            (now.getTime() - job.updatedAt.getTime()) / 60_000,
          ),
        },
      }).catch(() => undefined);
    }

    return reset;
  },

  // Ölü kuyruk şimdiye kadar tek yönlüydü: yazılıyor, hiç okunmuyordu.
  // Yeniden denenebilir sınıftaki (zaman aşımı, ağ, geçici şema hatası)
  // kayıtları yeniden kuyruğa alır; bakiye/anahtar/yapılandırma
  // hatalarına dokunmaz — onları yeniden denemek aynı hatayı üretir.
  async requeueRecoverableDeadLetters(
    limit = 10,
  ): Promise<{ requeued: number; skipped: number }> {
    const candidates = await prisma.deadLetterJob.findMany({
      where: { resolvedAt: null, executionJobId: { not: null } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    let requeued = 0;
    let skipped = 0;

    for (const entry of candidates) {
      const classification = classifyError(entry.lastError);
      if (!isAutoRecoverable(classification)) {
        skipped += 1;
        continue;
      }

      const priorAttempts = await prisma.deadLetterJob.count({
        where: { executionJobId: entry.executionJobId },
      });
      if (priorAttempts > MAX_AUTO_REQUEUES_PER_JOB) {
        skipped += 1;
        continue;
      }

      const job = await prisma.executionJob.findUnique({
        where: { id: entry.executionJobId as string },
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          status: true,
        },
      });
      // Zaten tamamlanmış/iptal edilmiş bir işi yeniden kuyruğa almak
      // yanlış olur — kaydı çözülmüş say ve geç.
      if (!job || job.status === "COMPLETED" || job.status === "CANCELLED") {
        await prisma.deadLetterJob.update({
          where: { id: entry.id },
          data: { resolvedAt: new Date() },
        });
        skipped += 1;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        await OutboxRepository.enqueue(tx, {
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          aggregateType: "ExecutionJob",
          aggregateId: job.id,
          eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
          payload: entry.payload,
          executionJobId: job.id,
        });
        await tx.deadLetterJob.update({
          where: { id: entry.id },
          data: { resolvedAt: new Date() },
        });
      });

      requeued += 1;
      await AuditLogRepository.record({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        actorType: "SYSTEM",
        action: "self-healing.dead_letter_requeued",
        entityType: "ExecutionJob",
        entityId: job.id,
        metadata: {
          deadLetterId: entry.id,
          category: classification.category,
          attempt: priorAttempts,
          lastError: entry.lastError,
        },
      }).catch(() => undefined);
    }

    return { requeued, skipped };
  },
};
