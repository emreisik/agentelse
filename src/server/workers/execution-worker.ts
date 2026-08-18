import "server-only";

import { prisma } from "@/lib/prisma";
import { isAgentelseError } from "@/server/security/errors";
import { ExecutionService } from "@/server/execution/execution-service";
import {
  OutboxRepository,
  OUTBOX_EVENT_TYPES,
} from "@/server/repositories/outbox.repository";
import { DeadLetterRepository } from "@/server/repositories/dead-letter.repository";
import { ProviderHealthService } from "@/server/observability/provider-health.service";
import { SelfHealingService } from "@/server/observability/self-healing.service";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { HumanInterventionRepository } from "@/server/repositories/human-intervention.repository";
import { TemporarySecretRepository } from "@/server/repositories/temporary-secret.repository";
import { ExecutionJobRepository } from "@/server/repositories/execution-job.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { SchedulerService } from "@/server/scheduler/scheduler-service";
import { ContinuousAgencyEngine } from "@/server/agency/continuous/continuous-agency-engine";
// Side-effect import: registers late setup-stage runners + intelligence
// pipeline steps into the engine/orchestrator extension points.
import "@/server/agency/continuous/agency-wiring";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2_000;
let activeTick: Promise<void> | undefined;

// Isolates tick stages from each other: errors are not swallowed, they're
// written to AuditLog, but they never block the next stage.
async function isolate(stage: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    // A worker-level error has no workspace, so it's written to the
    // dead-letter queue rather than AuditLog: that's already the right
    // place for a "failed and nobody noticed" record, and the System
    // Health screen reads from there.
    try {
      await DeadLetterRepository.create({
        reason: `worker.tick.stage_failed.${stage}`,
        payload: { stage },
        attempts: 1,
        lastError: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Failing to write the error record doesn't stop us from swallowing
      // the error and continuing the tick.
    }
  }
}

// Exponential backoff + jitter. Without jitter, N jobs that fail at the
// same time get retried at the same time (thundering herd), knocking over
// an already-struggling provider again; +-25% scatter breaks this up.
function backoffMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, 5 * 60_000);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(BASE_BACKOFF_MS, Math.round(base + jitter));
}

// This is the entire "queue" — no Redis/Docker, just PostgreSQL rows polled
// on an interval (spec section 50). Swapping to a different queue later
// only touches this file, never ExecutionService or domain callers.
export const ExecutionWorker = {
  async processDispatchQueue(limit = 10): Promise<number> {
    const batch = await OutboxRepository.claimBatch(
      limit,
      OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
    );
    let processed = 0;

    for (const event of batch) {
      if (event.eventType !== OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH) continue;

      const payload = event.payload as {
        executionJobId: string;
        riskLevel: string;
      };

      try {
        const job = await ExecutionService.startExecution(
          payload.executionJobId,
          payload.riskLevel as never,
          { recoverStalledDispatch: event.reclaimed },
        );
        if (job.status === "RUNNING" && !job.providerExecutionReference) {
          throw new Error(
            `ExecutionJob ${job.id} is still waiting for a provider reference`,
          );
        }

        const result = await OutboxRepository.markProcessed(
          event.id,
          event.nextAttemptAt,
        );
        processed += result.count;
      } catch (error) {
        const attempt = event.attemptCount + 1;
        if (attempt >= MAX_ATTEMPTS) {
          const result = await OutboxRepository.markFailed(
            event.id,
            attempt,
            event.nextAttemptAt,
          );
          if (result.count === 1) {
            await DeadLetterRepository.create({
              executionJobId: payload.executionJobId,
              reason: "execution.dispatch failed after max attempts",
              payload: event.payload,
              attempts: attempt,
              lastError: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          await OutboxRepository.scheduleRetry(
            event.id,
            attempt,
            backoffMs(attempt),
            event.nextAttemptAt,
          );
        }
      }
    }

    return processed;
  },

  async pollRunningJobs(limit = 20): Promise<number> {
    const jobs = await prisma.executionJob.findMany({
      where: { status: "RUNNING" },
      take: limit,
      orderBy: { updatedAt: "asc" },
    });

    let polled = 0;
    for (const job of jobs) {
      try {
        await ExecutionService.pollOnce(job.id);
        polled += 1;
      } catch (error) {
        if (!isAgentelseError(error)) throw error;
        // Provider hiccup — leave the job RUNNING, the next tick retries.
      }
    }
    return polled;
  },

  // Independent verification pass (spec section 45/46) — a provider saying
  // "completed" only gets a job to VERIFYING. This is what actually
  // confirms it and lets the Task finish. For mock providers the "evidence"
  // is the mock result payload itself, clearly labelled isMock.
  async resolvePendingVerifications(limit = 20): Promise<number> {
    const pending = await prisma.executionVerification.findMany({
      where: {
        OR: [
          { status: "PENDING" },
          {
            status: "VERIFIED",
            executionJob: {
              OR: [
                { status: "VERIFYING" },
                {
                  status: "COMPLETED",
                  task: { status: { not: "COMPLETED" } },
                },
              ],
            },
          },
        ],
      },
      take: limit,
      include: { executionJob: true },
    });

    let resolved = 0;
    for (const verification of pending) {
      const job = verification.executionJob;
      const rawResult = (job.rawResult ?? {}) as Record<string, unknown>;

      // The PENDING predicate is the cross-process claim. Keeping the claim,
      // evidence, and final verification update in one transaction means a
      // loser creates no duplicate evidence and a failed winner rolls back
      // to PENDING for the next tick.
      const claimed =
        verification.status === "VERIFIED"
          ? true
          : await prisma.$transaction(async (tx) => {
              const result = await tx.executionVerification.updateMany({
                where: { id: verification.id, status: "PENDING" },
                data: { status: "VERIFIED", verifiedAt: new Date() },
              });
              if (result.count !== 1) return false;

              const evidence = await tx.evidence.create({
                data: {
                  workspaceId: verification.workspaceId,
                  projectId: verification.projectId,
                  brandId: verification.brandId,
                  executionJobId: job.id,
                  sourceType: "SYSTEM_VERIFICATION",
                  statement: `Verification evidence for ${job.capability}`,
                  extractedText: JSON.stringify(rawResult),
                  confidenceScore: rawResult.isMock === true ? 0.5 : 1,
                  accessedAt: new Date(),
                },
              });

              await tx.executionVerification.update({
                where: { id: verification.id },
                data: { evidenceIds: [evidence.id] },
              });
              return true;
            });
      if (!claimed) continue;

      const jobCompleted =
        job.status === "COMPLETED" ||
        (await ExecutionJobRepository.completeAfterVerification(
          job.id,
          job.projectId,
        ));
      if (!jobCompleted) {
        const current = await prisma.executionJob.findUnique({
          where: { id: job.id },
        });
        if (current?.status !== "COMPLETED") continue;
      }

      const taskCompleted = await TaskRepository.completeAfterVerification(
        job.taskId,
        job.projectId,
      );
      if (taskCompleted) resolved += 1;
    }

    return resolved;
  },

  async sweepExpired(): Promise<void> {
    await Promise.all([
      HumanInterventionRepository.expireOverdue(),
      ApprovalRepository.expireOverdue(),
      TemporarySecretRepository.deleteExpired(),
    ]);
  },

  async tick(): Promise<void> {
    // Coalesce overlapping interval/HTTP invocations in this process. The
    // shared promise also makes callers wait for the active tick instead of
    // reporting success while work is still running.
    if (activeTick) return activeTick;

    const run = (async () => {
      // Every stage is isolated: a single broken cron expression or health
      // scan error must not bring down the whole tick (including dispatch +
      // poll + verify).
      await isolate("scheduler", () => SchedulerService.runDueSchedules());
      await isolate("self-healing", () => SelfHealingService.run());
      await isolate("provider-health", () => ProviderHealthService.refresh());
      await this.processDispatchQueue();
      await this.pollRunningJobs();
      await this.resolvePendingVerifications();
      // Agency OS loop — internally fault-isolated per step; a failing agency
      // stage never breaks execution processing (guarded here anyway).
      try {
        await ContinuousAgencyEngine.tick();
      } catch {
        // ContinuousAgencyEngine.tick already audit-logs its own failures.
      }
      await this.sweepExpired();
    })();

    activeTick = run;
    try {
      await run;
    } finally {
      if (activeTick === run) activeTick = undefined;
    }
  },
};
