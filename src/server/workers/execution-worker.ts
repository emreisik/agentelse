import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isAgentelseError } from "@/server/security/errors";
import {
  classifyError,
  isAutoRecoverable,
} from "@/server/observability/error-classifier";
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
import { Heartbeat } from "@/server/observability/heartbeat";
import { HEARTBEAT_KEYS } from "@/lib/heartbeat";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { META_WORKER_CAPABILITIES } from "@/lib/execution-backlog";
// Side-effect import: registers late setup-stage runners + intelligence
// pipeline steps into the engine/orchestrator extension points.
import "@/server/agency/continuous/agency-wiring";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2_000;
// AgentelseError codes that are genuinely permanent — retrying produces the
// identical error every time, so paying for MAX_ATTEMPTS retries with
// backoff before dead-lettering is pure waste. Deliberately narrow (auth/
// config/budget only): anything not in this list — including a merely
// UNKNOWN-classified error — keeps going through the normal
// retry-then-dead-letter path below rather than risk short-circuiting a
// transient failure that would have recovered on retry.
const PERMANENT_ERROR_CODES = new Set([
  "PERMISSION_DENIED",
  "BUDGET_EXCEEDED",
  "PROVIDER_UNAVAILABLE",
]);
// Mirrors AutonomyPolicy.maxConcurrentResearchTasks' default (5,
// prisma/schema.prisma). Not an exact per-project enforcement — a claimed
// batch can span multiple projects and that policy is project-scoped — but
// a simple process-wide cap that's easy to reason about and matches the
// codebase's existing bounded-batch pattern (see baseline-audit.service.ts
// BATCH=5).
const DISPATCH_CONCURRENCY = 5;
// How long a dispatch waits when the plan-allowance ledger was unreadable.
const LEDGER_UNAVAILABLE_RETRY_MS = 60_000;
// Generous last-resort backstop, not a normal-path budget: a legitimate
// tick can itself take a couple of minutes (e.g. an OpenClaw dispatch's own
// 135s timeout, or advanceOneProject's 45s per-project setup budget) — this
// exists only to guarantee the worker recovers from a hang nothing else
// catches (a fetch with no timeout, a stalled DB connection), not to police
// normal duration. Without it, a single stuck tick wedges its lane
// forever: every later interval firing just re-awaits the same promise, so
// the whole worker goes silent with no error ever logged.
const TICK_WATCHDOG_MS = 5 * 60_000;
// Single-flight state per lane (see ExecutionWorker.tick*): the full tick and
// each of its two lanes coalesce overlapping callers on their own.
type Lane = { active: Promise<void> | undefined };
const fullLane: Lane = { active: undefined };
const fastLane: Lane = { active: undefined };
const slowLane: Lane = { active: undefined };

// Provider health is computed over a 30-minute window of job results;
// recomputing (and re-writing) it on every 10 s tick bought nothing. Every
// third tick or so is plenty.
const PROVIDER_HEALTH_EVERY_MS = 30_000;
let lastProviderHealthAt = 0;

// See resolvePendingVerifications: the repair sweep, about once a minute.
const VERIFICATION_REPAIR_EVERY_MS = 60_000;
let lastVerificationRepairAt = 0;

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

// Runs one lane single-flight, raced against the watchdog: whichever settles
// first decides the outcome. A normal run error propagates; a watchdog timeout
// propagates the same way instead of hanging forever (and frees the lane even
// though the stuck run itself may never return).
async function runLane(lane: Lane, run: () => Promise<void>): Promise<void> {
  if (lane.active) return lane.active;
  const running = run();
  lane.active = running;
  const dog = watchdog(TICK_WATCHDOG_MS);
  try {
    await Promise.race([running, dog.promise]);
  } finally {
    dog.cancel();
    if (lane.active === running) lane.active = undefined;
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

// A dead-lettered dispatch (no provider, missing config, max attempts) used
// to leave its ExecutionJob and Task parked in QUEUED forever: nothing ever
// retried them, and because QUEUED isn't terminal, WorkPlanProgressor never
// cascade-cancelled their dependents, so one unexecutable node (e.g.
// WEBSITE_UPDATE, GOOGLE_ADS_CAMPAIGN_CREATE) stranded the whole plan.
// Failing both here fires the normal TASK_FAILED trigger instead.
// Best-effort: a failure here must not break the dispatch loop.
async function failDeadLetteredDispatch(
  executionJobId: string,
  reason: string,
): Promise<void> {
  try {
    const job = await prisma.executionJob.findUnique({
      where: { id: executionJobId },
      select: { status: true, projectId: true, taskId: true },
    });
    if (!job || !["QUEUED", "RUNNING"].includes(job.status)) return;
    await ExecutionJobRepository.transition(
      executionJobId,
      job.projectId,
      "FAILED",
      { errorCode: "DISPATCH_DEAD_LETTERED", errorMessage: reason },
    );
    const task = await prisma.task.findUnique({
      where: { id: job.taskId },
      select: { status: true },
    });
    if (task && ["QUEUED", "RUNNING"].includes(task.status)) {
      await TaskRepository.transition(job.taskId, job.projectId, "FAILED", {
        failureReason: reason,
      });
    }
  } catch (error) {
    console.error(
      `[execution-worker] could not fail dead-lettered job ${executionJobId}:`,
      error,
    );
  }
}

// This is the entire "queue" — no Redis/Docker, just PostgreSQL rows polled
// on an interval (spec section 50). Swapping to a different queue later
// only touches this file, never ExecutionService or domain callers.
export const ExecutionWorker = {
  async processDispatchQueue(limit = 10): Promise<number> {
    // Canlı DB'yi paylaşan yerel geliştirme işçisi Meta işlerini hiç almaz;
    // onları canlı işçi yürütür (docs/meta-ads-plan.md F0b, K19).
    const batch = await OutboxRepository.claimBatch(
      limit,
      OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
      metaWorkExcludedHere(process.env)
        ? { excludeCapabilities: [...META_WORKER_CAPABILITIES] }
        : undefined,
    );

    // Each event above was already exclusively claimed via a per-row
    // compare-and-swap (OutboxRepository.claimBatch) — no two workers can
    // hold the same event, so processing the claimed batch concurrently is
    // race-free. Bounded to DISPATCH_CONCURRENCY rather than a bare
    // Promise.all over the whole batch: some providers (e.g. OpenClaw) spawn
    // real CLI/browser processes, so unbounded fan-out risks colliding
    // sessions and provider rate limits, not just DB races.
    // A rolling pool rather than fixed chunks: a lane takes the next event as
    // soon as its own is done, so one slow dispatch (an image that takes two
    // minutes) no longer holds the other slots of its chunk idle.
    let processed = 0;
    let next = 0;
    const lane = async () => {
      while (next < batch.length) {
        const event = batch[next++]!;
        processed += await this.processDispatchEvent(event);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(DISPATCH_CONCURRENCY, batch.length) },
        lane,
      ),
    );

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
      // Set by the resume step (src/server/billing/park.ts): the token under
      // which it already reserved the allowance this run will spend.
      attemptToken?: string;
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
        {
          recoverStalledDispatch: true,
          // Names this attempt's plan-allowance reservation. Stable when the
          // same attempt is delivered again (a lease-expiry reclaim finds and
          // adopts its own reservation instead of reserving twice), new for
          // every retry (scheduleRetry raises attemptCount).
          attemptToken:
            payload.attemptToken ?? `${event.id}.${event.attemptCount + 1}`,
        },
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
      // The usage ledger could not be read (enforce fails closed). That is not
      // this job's fault and says nothing about the next attempt: put the event
      // back WITHOUT spending an attempt. Counting it would let a one-minute
      // database blip run every queued job through MAX_ATTEMPTS and
      // dead-letter the lot (the plan then cascade-cancels its dependents).
      if (isAgentelseError(error) && error.code === "BILLING_UNAVAILABLE") {
        await OutboxRepository.scheduleRetry(
          event.id,
          event.attemptCount,
          LEDGER_UNAVAILABLE_RETRY_MS,
          event.nextAttemptAt,
        );
        return 0;
      }
      const attempt = event.attemptCount + 1;
      // A permanent-class failure (auth/config/budget) will produce the
      // exact same error on every retry — classifyError/isAutoRecoverable
      // (the same taxonomy self-healing.service.ts already uses for
      // dead-letter requeue decisions) lets this skip straight to
      // dead-letter on attempt 1 instead of burning MAX_ATTEMPTS retries
      // with backoff to reach the identical outcome. Both the error's own
      // code (against the narrow PERMANENT_ERROR_CODES allowlist) and the
      // text classifier must agree, and the thrower's own `retryable` flag
      // is respected — anything ambiguous still goes through the existing
      // retry-then-dead-letter path unchanged.
      const isPermanentFailure =
        isAgentelseError(error) &&
        !error.retryable &&
        PERMANENT_ERROR_CODES.has(error.code) &&
        !isAutoRecoverable(classifyError(error.message));
      if (attempt >= MAX_ATTEMPTS || isPermanentFailure) {
        const result = await OutboxRepository.markFailed(
          event.id,
          attempt,
          event.nextAttemptAt,
        );
        if (result.count === 1) {
          await DeadLetterRepository.create({
            executionJobId: payload.executionJobId,
            reason: isPermanentFailure
              ? "execution.dispatch failed with a non-recoverable error"
              : "execution.dispatch failed after max attempts",
            payload: event.payload,
            attempts: attempt,
            lastError: error instanceof Error ? error.message : String(error),
          });
          await failDeadLetteredDispatch(
            payload.executionJobId,
            error instanceof Error ? error.message : String(error),
          );
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
  // `repair: false` reads only the PENDING claims: the repair half (verified,
  // but the job or its task never finished — an interrupted transition)
  // checks nearly every verified row against its job and task, so the tick
  // runs it about once a minute rather than on every pass.
  async resolvePendingVerifications(
    limit = 20,
    options: { repair?: boolean } = {},
  ): Promise<number> {
    const repair = options.repair ?? true;
    const pending = await prisma.executionVerification.findMany({
      where: repair
        ? {
            OR: [
              { status: "PENDING" },
              {
                status: "VERIFIED",
                executionJob: {
                  OR: [
                    { status: "VERIFYING" },
                    {
                      status: "COMPLETED",
                      // İptal edilmiş ya da düşmüş görev tamamlanamaz; her
                      // dakika yeniden seçilip "take" sınırını doldurmasın.
                      task: {
                        status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] },
                      },
                    },
                  ],
                },
              },
            ],
          }
        : { status: "PENDING" },
      take: limit,
      include: { executionJob: true },
    });

    let resolved = 0;
    for (const verification of pending) {
      // Tek bozuk satır (ör. geçersiz bir görev geçişi) döngünün geri kalanını
      // ve tick'in sonraki aşamalarını düşürmez.
      try {
        if (await this.resolveOneVerification(verification)) resolved += 1;
      } catch (error) {
        console.error(
          `[execution-worker] verification ${verification.id} could not be resolved:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return resolved;
  },

  async resolveOneVerification(
    verification: Prisma.ExecutionVerificationGetPayload<{
      include: { executionJob: true };
    }>,
  ): Promise<boolean> {
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
    if (!claimed) return false;

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
      if (current?.status !== "COMPLETED") return false;
    }

    return TaskRepository.completeAfterVerification(job.taskId, job.projectId);
  },

  async sweepExpired(): Promise<void> {
    await Promise.all([
      HumanInterventionRepository.expireOverdue(),
      ApprovalRepository.expireOverdue(),
      TemporarySecretRepository.deleteExpired(),
    ]);
  },

  // The worker's work comes in two lanes that run side by side, so that a user's
  // queued job is never held up by the slow agency steps (LLM calls, setup
  // advancement with a 45 s budget per project, Telegram HTTP): they used to
  // share one serial tick, and a long agency step delayed the next dispatch by
  // minutes.
  //   fast: dispatch, poll running jobs, verify (what a queued job waits for)
  //   slow: scheduler, self-healing, provider health, agency loop, sweep
  // Each lane is single-flight on its own; tick() runs both (the cron route,
  // tests), the in-process timer runs each on its own interval.
  async tickFast(): Promise<void> {
    return runLane(fastLane, async () => {
      await isolate("dispatch", () => this.processDispatchQueue());
      await isolate("poll", () => this.pollRunningJobs());
      const repairDue =
        Date.now() - lastVerificationRepairAt >= VERIFICATION_REPAIR_EVERY_MS;
      if (repairDue) lastVerificationRepairAt = Date.now();
      await isolate("verify", () =>
        this.resolvePendingVerifications(20, { repair: repairDue }),
      );
    });
  },

  async tickSlow(): Promise<void> {
    return runLane(slowLane, async () => {
      // Nabız: tick başında lastBeatAt, sonunda lastOkAt (en fazla dakikada
      // bir). Harici monitör ve uygulama içi şerit buna bakar
      // (docs/meta-ads-plan.md F0b).
      // Beklenmez: nabız yazımı hiç fırlatmaz ve tick'in aşamalarını
      // geciktirmemeli.
      void Heartbeat.beat(HEARTBEAT_KEYS.WORKER_TICK);
      // Every stage is isolated: a single broken cron expression or health
      // scan error must not bring down the whole lane.
      await isolate("scheduler", () => SchedulerService.runDueSchedules());
      await isolate("self-healing", () => SelfHealingService.run());
      if (Date.now() - lastProviderHealthAt >= PROVIDER_HEALTH_EVERY_MS) {
        lastProviderHealthAt = Date.now();
        await isolate("provider-health", () => ProviderHealthService.refresh());
      }
      // Agency OS loop — internally fault-isolated per step; a failing agency
      // stage never breaks execution processing (guarded here anyway).
      try {
        await ContinuousAgencyEngine.tick();
      } catch {
        // ContinuousAgencyEngine.tick already audit-logs its own failures.
      }
      await isolate("sweep-expired", () => this.sweepExpired());
      await Heartbeat.ok(HEARTBEAT_KEYS.WORKER_TICK);
    });
  },

  async tick(): Promise<void> {
    // Coalesce overlapping interval/HTTP invocations in this process. The
    // shared promise also makes callers wait for the active tick instead of
    // reporting success while work is still running.
    return runLane(fullLane, async () => {
      const results = await Promise.allSettled([
        this.tickFast(),
        this.tickSlow(),
      ]);
      // A failed lane propagates exactly as a failed tick did (callers:
      // instrumentation.ts's console.error, the cron route's dead-letter + 500).
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;
    });
  },
};
