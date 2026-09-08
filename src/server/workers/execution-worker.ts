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
// Mirrors AutonomyPolicy.maxConcurrentResearchTasks' default (5,
// prisma/schema.prisma). Not an exact per-project enforcement — a claimed
// batch can span multiple projects and that policy is project-scoped — but
// a simple process-wide cap that's easy to reason about and matches the
// codebase's existing bounded-batch pattern (see baseline-audit.service.ts
// BATCH=5).
const DISPATCH_CONCURRENCY = 5;
// Generous last-resort backstop, not a normal-path budget: a legitimate
// tick can itself take a couple of minutes (e.g. an OpenClaw dispatch's own
// 135s timeout, or advanceOneProject's 45s per-project setup budget) — this
// exists only to guarantee the worker recovers from a hang nothing else
// catches (a fetch with no timeout, a stalled DB connection), not to police
// normal duration. Without it, a single stuck tick wedges activeTick
// forever: every later interval firing just re-awaits the same promise, so
// the whole worker goes silent with no error ever logged.
const TICK_WATCHDOG_MS = 5 * 60_000;
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

// Races `run` against this timer. Returns a cancel() so the caller can
// clear the timer once `run` settles on its own — otherwise, at one 3s tick
// creating a fresh 5-minute timer, the process would accumulate ~100
// pending timers at any moment even though almost all of them become moot
// the instant their tick's `run` finishes.
function watchdog(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`worker tick exceeded ${ms}ms`)),
      ms,
    );
  });
  return { promise, cancel: () => clearTimeout(timer) };
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

    // Each event above was already exclusively claimed via a per-row
    // compare-and-swap (OutboxRepository.claimBatch) — no two workers can
    // hold the same event, so processing the claimed batch concurrently is
    // race-free. Bounded to DISPATCH_CONCURRENCY rather than a bare
    // Promise.all over the whole batch: some providers (e.g. OpenClaw) spawn
    // real CLI/browser processes, so unbounded fan-out risks colliding
    // sessions and provider rate limits, not just DB races.
    let processed = 0;
    for (let i = 0; i < batch.length; i += DISPATCH_CONCURRENCY) {
      const chunk = batch.slice(i, i + DISPATCH_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((event) => this.processDispatchEvent(event)),
      );
      processed += results.reduce((sum, count) => sum + count, 0);
    }

    return processed;
  },

  // Single-event dispatch handling, split out of processDispatchQueue so it
  // can run concurrently across a claimed batch. Behavior is unchanged from
  // the previous sequential loop.
  async processDispatchEvent(
    event: Awaited<ReturnType<typeof OutboxRepository.claimBatch>>[number],
  ): Promise<number> {
    if (event.eventType !== OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH) return 0;

    const payload = event.payload as {
      executionJobId: string;
      riskLevel: string;
    };

    try {
      // Always true, not just on event.reclaimed (a lease-expiry reclaim —
      // rare). A far more common path lands here just as stuck: attempt #1
      // claims the job (QUEUED -> RUNNING) then provider.execute() throws
      // before the providerExecutionReference update runs. scheduleRetry
      // puts the outbox event back at PENDING (reclaimed stays false), so
      // without this every later attempt hit startExecution's `job.status
      // !== "QUEUED"` guard and returned the same broken RUNNING/null job
      // untouched — burning the remaining attempts on the synthetic "still
      // waiting for a provider reference" error instead of ever retrying
      // the real provider call, then dead-lettering with that message
      // instead of the actual failure. Safe unconditionally: on a fresh
      // QUEUED job the recovery branch's RUNNING check just doesn't fire.
      const job = await ExecutionService.startExecution(
        payload.executionJobId,
        payload.riskLevel as never,
        { recoverStalledDispatch: true },
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
      return result.count;
    } catch (error) {
      console.error(
        `[execution-worker] dispatch failed for job ${payload.executionJobId}:`,
        error,
      );
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
      return 0;
    }
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
        // Logged (previously silent): a job that fails on EVERY poll for
        // 30 min gets stuck-job-reset by self-healing with only a generic
        // "not progressed" message — this is the only place the actual
        // provider error ever surfaces, without it a persistently broken
        // provider integration was undiagnosable from application logs.
        console.error(
          `[execution-worker] pollOnce failed for job ${job.id} (${job.providerId ?? "?"}/${job.capability}):`,
          error.message,
        );
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
    const dog = watchdog(TICK_WATCHDOG_MS);
    try {
      // Races the tick against the watchdog rather than just `await run` —
      // whichever settles first decides the outcome. A normal run() error
      // still propagates exactly as before (callers: instrumentation.ts's
      // console.error, the cron route's dead-letter + 500); a watchdog
      // timeout now propagates the same way instead of hanging forever.
      await Promise.race([run, dog.promise]);
    } finally {
      dog.cancel();
      if (activeTick === run) activeTick = undefined;
    }
  },
};
