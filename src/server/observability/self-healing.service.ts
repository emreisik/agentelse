import "server-only";

import { prisma } from "@/lib/prisma";
import {
  OUTBOX_EVENT_TYPES,
  OutboxRepository,
} from "@/server/repositories/outbox.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import {
  classifyError,
  isAutoRecoverable,
} from "@/server/observability/error-classifier";
import { isMetaSpendWrite } from "@/server/execution/backlog-gate";

// Automatic recovery. Its scope is deliberately narrow: it repairs the
// system's OWN operational state (a stuck job, a job that landed in the
// dead letter queue with a retryable error). It never writes code, never
// changes the schema, and never approves anything on its own that requires
// a human decision.
//
// Every recovery is written to AuditLog: what was auto-healed and why must
// be visible in retrospect.

// A provider call that's been RUNNING longer than this is stuck: even the
// slowest real path (an OpenClaw browser session) takes minutes, not hours.
const STUCK_JOB_AFTER_MS = 30 * 60_000;
// Once this many dead-letter records have piled up for the same job,
// auto-recovery has entered a loop — leave it to a human.
const MAX_AUTO_REQUEUES_PER_JOB = 3;

function hasVariantCount(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { variantCount?: unknown }).variantCount === "number"
  );
}

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

  // pollRunningJobs can swallow a provider error and leave the job RUNNING;
  // the result is a job that gets polled forever and never finishes.
  // Explicitly flip these to FAILED so the normal retry/dead-letter path
  // kicks in.
  async resetStuckJobs(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - STUCK_JOB_AFTER_MS);
    const stuck = await prisma.executionJob.findMany({
      where: {
        status: { in: ["RUNNING", "WAITING_PROVIDER"] },
        updatedAt: { lt: cutoff },
      },
      select: {
        id: true,
        taskId: true,
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
      // Conditional update: if it genuinely progressed in the meantime,
      // don't touch it.
      const result = await prisma.executionJob.updateMany({
        where: {
          id: job.id,
          status: { in: ["RUNNING", "WAITING_PROVIDER"] },
          updatedAt: { lt: cutoff },
        },
        data: {
          status: "FAILED",
          errorCode: "STUCK_TIMEOUT",
          errorMessage: `Job has not progressed for ${Math.round(
            (now.getTime() - job.updatedAt.getTime()) / 60_000,
          )} minutes — automatically timed out`,
          retryable: true,
          completedAt: now,
        },
      });
      if (result.count !== 1) continue;

      reset += 1;

      // This is a direct DB update, not a provider-poll outcome — it
      // bypasses execution-service.ts's pollOnce() entirely, which is the
      // ONLY other place that keeps the parent Task's status in lockstep
      // with a FAILED job (see pollOnce's taskTargetStatus). Without this,
      // the ExecutionJob correctly failed but the Task stayed stuck at
      // RUNNING forever — the exact "still shows Running in the UI"
      // symptom this function exists to prevent.
      const task = await prisma.task.findUnique({
        where: { id: job.taskId },
        select: { status: true, projectId: true },
      });
      if (task && task.status !== "FAILED") {
        await TaskRepository.transition(job.taskId, task.projectId, "FAILED", {
          failureReason: "Stuck job automatically timed out",
        }).catch((error) => {
          console.error(
            `[self-healing] failed to transition task ${job.taskId} to FAILED after stuck-job reset:`,
            error instanceof Error ? error.message : error,
          );
        });
      }

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

  // The dead letter queue has been one-directional until now: written to,
  // never read from. This requeues records in the retryable class (timeout,
  // network, transient schema error); it doesn't touch balance/key/
  // configuration errors — retrying those just produces the same error.
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
          capability: true,
          requestPayload: true,
          taskId: true,
        },
      });
      // Requeuing a job that's already completed/cancelled would be wrong —
      // treat the record as resolved and skip it.
      if (!job || job.status === "COMPLETED" || job.status === "CANCELLED") {
        await prisma.deadLetterJob.update({
          where: { id: entry.id },
          data: { resolvedAt: new Date() },
        });
        skipped += 1;
        continue;
      }

      // A creative-variants job (the key is written only by the variants
      // route) has usually billed its pictures before it failed; requeuing it
      // would bill them again, up to 4x for one tap, and could append the
      // same alternatives twice. Leave the dead letter unresolved for a human.
      if (hasVariantCount(job.requestPayload)) {
        skipped += 1;
        continue;
      }

      // Bir Meta yazması Meta'da nesneyi kurmuş ama yanıtı kaybetmiş
      // olabilir; kör tekrar çift kampanya / ad set kurar. Niyet günlüğüyle
      // uzlaştırma gelene kadar (docs/meta-ads-plan.md F1) bunlar insana
      // kalır.
      if (isMetaSpendWrite(job.capability)) {
        skipped += 1;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        // Puts the already-legal FAILED -> QUEUED transition
        // (state-machine/transitions.ts) to its first actual use: without
        // this, the outbox event enqueued below gets picked up by
        // execution-service.ts's startExecution(), which no-ops on
        // `job.status !== "QUEUED"` because this job's status is still
        // FAILED — silently burning the requeue attempt without ever
        // calling the provider again (the job then reads as "auto-healed"
        // in AuditLog even though nothing was retried). CAS-guarded on the
        // OLD status, matching execution-job.repository.ts's
        // claimQueuedForProvider — a job that concurrently left FAILED
        // (e.g. a human already requeued it) is left alone.
        await tx.executionJob.updateMany({
          where: { id: job.id, status: "FAILED" },
          data: { status: "QUEUED" },
        });
        // Ölü mektuba düşen dispatch görevi de FAILED yapmıştı
        // (failDeadLetteredDispatch); FAILED -> RUNNING yasak olduğu için
        // startExecution onu yeniden çalıştıramazdı. FAILED -> QUEUED yasal.
        await tx.task.updateMany({
          where: { id: job.taskId, status: "FAILED" },
          data: { status: "QUEUED", completedAt: null },
        });

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
