import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvalExpiry: vi.fn(),
  agencyTick: vi.fn(),
  claimBatch: vi.fn(),
  deadLetterCreate: vi.fn(),
  selfHealingRun: vi.fn(),
  providerHealthRefresh: vi.fn(),
  evidenceCreate: vi.fn(),
  executionFindMany: vi.fn(),
  executionFindUnique: vi.fn(),
  executionComplete: vi.fn(),
  executionStart: vi.fn(),
  humanExpiry: vi.fn(),
  isAgentelseError: vi.fn(),
  markFailed: vi.fn(),
  markProcessed: vi.fn(),
  pollOnce: vi.fn(),
  scheduleRetry: vi.fn(),
  schedulerRun: vi.fn(),
  secretExpiry: vi.fn(),
  taskComplete: vi.fn(),
  transaction: vi.fn(),
  verificationFindMany: vi.fn(),
  verificationUpdateMany: vi.fn(),
  verificationUpdate: vi.fn(),
  heartbeatBeat: vi.fn(),
  heartbeatOk: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    evidence: { create: mocks.evidenceCreate },
    executionJob: {
      findMany: mocks.executionFindMany,
      findUnique: mocks.executionFindUnique,
    },
    executionVerification: {
      findMany: mocks.verificationFindMany,
      updateMany: mocks.verificationUpdateMany,
      update: mocks.verificationUpdate,
    },
  },
}));
vi.mock("@/server/security/errors", () => ({
  isAgentelseError: mocks.isAgentelseError,
}));
vi.mock("@/server/execution/execution-service", () => ({
  ExecutionService: {
    pollOnce: mocks.pollOnce,
    startExecution: mocks.executionStart,
  },
}));
vi.mock("@/server/repositories/outbox.repository", () => ({
  OUTBOX_EVENT_TYPES: { EXECUTION_DISPATCH: "execution.dispatch" },
  OutboxRepository: {
    claimBatch: mocks.claimBatch,
    markFailed: mocks.markFailed,
    markProcessed: mocks.markProcessed,
    scheduleRetry: mocks.scheduleRetry,
  },
}));
// The observability stages have their own tests; here we're measuring the
// worker's flow, so their prisma calls shouldn't pollute the counters.
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: mocks.heartbeatBeat, ok: mocks.heartbeatOk },
}));
vi.mock("@/server/observability/self-healing.service", () => ({
  SelfHealingService: { run: mocks.selfHealingRun },
}));
vi.mock("@/server/observability/provider-health.service", () => ({
  ProviderHealthService: { refresh: mocks.providerHealthRefresh },
}));
vi.mock("@/server/repositories/dead-letter.repository", () => ({
  DeadLetterRepository: { create: mocks.deadLetterCreate },
}));
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { expireOverdue: mocks.approvalExpiry },
}));
vi.mock("@/server/repositories/human-intervention.repository", () => ({
  HumanInterventionRepository: { expireOverdue: mocks.humanExpiry },
}));
vi.mock("@/server/repositories/temporary-secret.repository", () => ({
  TemporarySecretRepository: { deleteExpired: mocks.secretExpiry },
}));
vi.mock("@/server/repositories/execution-job.repository", () => ({
  ExecutionJobRepository: {
    completeAfterVerification: mocks.executionComplete,
  },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { completeAfterVerification: mocks.taskComplete },
}));
vi.mock("@/server/scheduler/scheduler-service", () => ({
  SchedulerService: { runDueSchedules: mocks.schedulerRun },
}));
vi.mock("@/server/agency/continuous/continuous-agency-engine", () => ({
  ContinuousAgencyEngine: { tick: mocks.agencyTick },
}));
vi.mock("@/server/agency/continuous/agency-wiring", () => ({}));

import { ExecutionWorker } from "@/server/workers/execution-worker";

describe("ExecutionWorker.tick", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.schedulerRun.mockResolvedValue(undefined);
    mocks.claimBatch.mockResolvedValue([]);
    mocks.markProcessed.mockResolvedValue({ count: 1 });
    mocks.markFailed.mockResolvedValue({ count: 1 });
    mocks.executionStart.mockResolvedValue({
      id: "job-default",
      status: "COMPLETED",
      providerExecutionReference: "provider-ref",
    });
    mocks.executionFindMany.mockResolvedValue([]);
    mocks.executionFindUnique.mockResolvedValue({ status: "COMPLETED" });
    mocks.executionComplete.mockResolvedValue(true);
    mocks.taskComplete.mockResolvedValue(true);
    mocks.verificationFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(
      async (
        callback: (tx: {
          evidence: { create: typeof mocks.evidenceCreate };
          executionVerification: {
            update: typeof mocks.verificationUpdate;
            updateMany: typeof mocks.verificationUpdateMany;
          };
        }) => Promise<unknown>,
      ) =>
        callback({
          evidence: { create: mocks.evidenceCreate },
          executionVerification: {
            update: mocks.verificationUpdate,
            updateMany: mocks.verificationUpdateMany,
          },
        }),
    );
    mocks.agencyTick.mockResolvedValue(undefined);
    mocks.humanExpiry.mockResolvedValue(undefined);
    mocks.approvalExpiry.mockResolvedValue(undefined);
    mocks.secretExpiry.mockResolvedValue(undefined);
    mocks.heartbeatBeat.mockResolvedValue(undefined);
    mocks.heartbeatOk.mockResolvedValue(undefined);
  });

  it("coalesces overlapping calls and releases the lock after completion", async () => {
    let releaseScheduler!: () => void;
    mocks.schedulerRun.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseScheduler = resolve;
        }),
    );

    const first = ExecutionWorker.tick();
    const overlapping = ExecutionWorker.tick();

    expect(mocks.schedulerRun).toHaveBeenCalledTimes(1);
    // The fast lane (dispatch, poll, verify) is not held up by the slow one:
    // a slow scheduler or agency step no longer delays a queued job.
    await vi.waitFor(() => expect(mocks.claimBatch).toHaveBeenCalledTimes(1));
    expect(mocks.agencyTick).not.toHaveBeenCalled();

    releaseScheduler();
    await Promise.all([first, overlapping]);

    expect(mocks.claimBatch).toHaveBeenCalledTimes(1);
    expect(mocks.executionFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.verificationFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.agencyTick).toHaveBeenCalledTimes(1);
    expect(mocks.humanExpiry).toHaveBeenCalledTimes(1);

    await ExecutionWorker.tick();
    expect(mocks.schedulerRun).toHaveBeenCalledTimes(2);
    expect(mocks.claimBatch).toHaveBeenCalledTimes(2);
  });

  it("the two lanes are independent: a stuck agency step never delays dispatch, and each lane coalesces on its own", async () => {
    let releaseAgency!: () => void;
    mocks.agencyTick.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAgency = resolve;
        }),
    );

    const slow = ExecutionWorker.tickSlow();
    await vi.waitFor(() => expect(mocks.agencyTick).toHaveBeenCalledTimes(1));

    // The slow lane is stuck inside the agency step: dispatch still runs, on
    // every call, while a second slow call just joins the running one.
    await ExecutionWorker.tickFast();
    await ExecutionWorker.tickFast();
    expect(mocks.claimBatch).toHaveBeenCalledTimes(2);
    const joined = ExecutionWorker.tickSlow();
    expect(mocks.schedulerRun).toHaveBeenCalledTimes(1);

    releaseAgency();
    await Promise.all([slow, joined]);
    expect(mocks.heartbeatOk).toHaveBeenCalledTimes(1);
  });

  it("releases the single-flight lock when a tick fails", async () => {
    // Every stage is isolated now; the tick itself can still fail at its
    // very end (here: the end-of-tick heartbeat write) and must free the lock.
    mocks.heartbeatOk.mockRejectedValueOnce(new Error("tick failed"));

    const first = ExecutionWorker.tick();
    const overlapping = ExecutionWorker.tick();

    await expect(Promise.all([first, overlapping])).rejects.toThrow(
      "tick failed",
    );
    expect(mocks.claimBatch).toHaveBeenCalledTimes(1);

    await ExecutionWorker.tick();
    expect(mocks.claimBatch).toHaveBeenCalledTimes(2);
  });

  it("a broken dispatch queue does not bring down poll, verify or the agency loop (F0b)", async () => {
    mocks.claimBatch.mockRejectedValueOnce(new Error("dispatch failed"));

    await expect(ExecutionWorker.tick()).resolves.toBeUndefined();

    expect(mocks.executionFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.verificationFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.agencyTick).toHaveBeenCalledTimes(1);
    expect(mocks.deadLetterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "worker.tick.stage_failed.dispatch",
        lastError: "dispatch failed",
      }),
    );
  });

  it("writes the heartbeat at the start and the end of a tick (F0b)", async () => {
    await ExecutionWorker.tick();

    expect(mocks.heartbeatBeat).toHaveBeenCalledWith("worker.tick");
    expect(mocks.heartbeatOk).toHaveBeenCalledWith("worker.tick");
  });

  it("a broken scheduler does not bring down the rest of the tick", async () => {
    // Stage isolation: a single broken cron expression used to also block
    // the dispatch/poll/verify steps; now the error is recorded and
    // execution continues.
    mocks.schedulerRun.mockRejectedValueOnce(new Error("scheduler failed"));

    await expect(ExecutionWorker.tick()).resolves.toBeUndefined();

    expect(mocks.claimBatch).toHaveBeenCalledTimes(1);
    expect(mocks.deadLetterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "worker.tick.stage_failed.scheduler",
        lastError: "scheduler failed",
      }),
    );
  });

  it("does not dispatch a job twice when concurrent queue polls compete", async () => {
    const claimedUntil = new Date("2026-08-08T00:15:00.000Z");
    let claimed = false;
    mocks.claimBatch.mockImplementation(async () => {
      if (claimed) return [];
      claimed = true;
      return [
        {
          id: "event-1",
          eventType: "execution.dispatch",
          payload: { executionJobId: "job-1", riskLevel: "LOW" },
          attemptCount: 0,
          nextAttemptAt: claimedUntil,
          reclaimed: false,
        },
      ];
    });

    const results = await Promise.all([
      ExecutionWorker.processDispatchQueue(),
      ExecutionWorker.processDispatchQueue(),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(mocks.executionStart).toHaveBeenCalledTimes(1);
    expect(mocks.executionStart).toHaveBeenCalledWith("job-1", "LOW", {
      recoverStalledDispatch: true,
    });
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
    expect(mocks.markProcessed).toHaveBeenCalledWith("event-1", claimedUntil);
  });

  it("schedules a retry with exponential backoff after dispatch failure", async () => {
    const claimedUntil = new Date("2026-08-08T00:15:00.000Z");
    mocks.claimBatch.mockResolvedValue([
      {
        id: "event-1",
        eventType: "execution.dispatch",
        payload: { executionJobId: "job-1", riskLevel: "LOW" },
        attemptCount: 0,
        nextAttemptAt: claimedUntil,
        reclaimed: false,
      },
    ]);
    mocks.executionStart.mockRejectedValue(new Error("provider unavailable"));

    await expect(ExecutionWorker.processDispatchQueue()).resolves.toBe(0);

    // Backoff has jitter (+-25%): a range is verified, not the exact value —
    // otherwise jobs that fail at the same time would retry at the same time.
    expectBackoffRetry(1, 4_000, claimedUntil);
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.deadLetterCreate).not.toHaveBeenCalled();
  });

  it("moves the fifth failed dispatch to the dead-letter queue", async () => {
    const claimedUntil = new Date("2026-08-08T00:15:00.000Z");
    mocks.claimBatch.mockResolvedValue([
      {
        id: "event-1",
        eventType: "execution.dispatch",
        payload: { executionJobId: "job-1", riskLevel: "HIGH" },
        attemptCount: 4,
        nextAttemptAt: claimedUntil,
        reclaimed: false,
      },
    ]);
    mocks.executionStart.mockRejectedValue(new Error("provider timed out"));

    await expect(ExecutionWorker.processDispatchQueue()).resolves.toBe(0);

    expect(mocks.markFailed).toHaveBeenCalledWith("event-1", 5, claimedUntil);
    expect(mocks.deadLetterCreate).toHaveBeenCalledWith({
      executionJobId: "job-1",
      reason: "execution.dispatch failed after max attempts",
      payload: { executionJobId: "job-1", riskLevel: "HIGH" },
      attempts: 5,
      lastError: "provider timed out",
    });
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  // Audit problem 15 (dispatch-time retry loop): previously every error was
  // treated identically — 5 attempts with backoff before dead-letter, even
  // for an error that will never succeed on retry (bad credentials, missing
  // config, budget exhausted). classifyError/isAutoRecoverable now lets a
  // confidently-permanent AgentelseError skip straight to dead-letter on
  // attempt 1 instead of wasting 4 more dispatch cycles reaching the same
  // outcome.
  it("dead-letters a permanent-class AgentelseError immediately (attempt 1), without going through the retry loop", async () => {
    const claimedUntil = new Date("2026-08-08T00:15:00.000Z");
    mocks.claimBatch.mockResolvedValue([
      {
        id: "event-1",
        eventType: "execution.dispatch",
        payload: { executionJobId: "job-1", riskLevel: "LOW" },
        attemptCount: 0,
        nextAttemptAt: claimedUntil,
        reclaimed: false,
      },
    ]);
    mocks.isAgentelseError.mockReturnValue(true);
    mocks.executionStart.mockRejectedValue(
      Object.assign(new Error("permission denied"), {
        code: "PERMISSION_DENIED",
        retryable: false,
      }),
    );

    await expect(ExecutionWorker.processDispatchQueue()).resolves.toBe(0);

    expect(mocks.markFailed).toHaveBeenCalledWith("event-1", 1, claimedUntil);
    expect(mocks.deadLetterCreate).toHaveBeenCalledWith({
      executionJobId: "job-1",
      reason: "execution.dispatch failed with a non-recoverable error",
      payload: { executionJobId: "job-1", riskLevel: "LOW" },
      attempts: 1,
      lastError: "permission denied",
    });
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("still retries a transient AgentelseError (e.g. PROVIDER_RATE_LIMITED) through the normal backoff path instead of dead-lettering early", async () => {
    const claimedUntil = new Date("2026-08-08T00:15:00.000Z");
    mocks.claimBatch.mockResolvedValue([
      {
        id: "event-1",
        eventType: "execution.dispatch",
        payload: { executionJobId: "job-1", riskLevel: "LOW" },
        attemptCount: 0,
        nextAttemptAt: claimedUntil,
        reclaimed: false,
      },
    ]);
    mocks.isAgentelseError.mockReturnValue(true);
    mocks.executionStart.mockRejectedValue(
      Object.assign(new Error("rate limit exceeded"), {
        code: "PROVIDER_RATE_LIMITED",
        retryable: true,
      }),
    );

    await expect(ExecutionWorker.processDispatchQueue()).resolves.toBe(0);

    expectBackoffRetry(1, 4_000, claimedUntil);
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.deadLetterCreate).not.toHaveBeenCalled();
  });

  it("resolves a pending verification in only one concurrent worker", async () => {
    const verification = {
      id: "verification-1",
      status: "PENDING",
      workspaceId: "workspace-1",
      projectId: "project-1",
      brandId: "brand-1",
      executionJob: {
        id: "job-1",
        projectId: "project-1",
        taskId: "task-1",
        capability: "WEB_RESEARCH",
        rawResult: { isMock: true },
      },
    };
    let persistedStatus = "PENDING";
    mocks.verificationFindMany.mockResolvedValue([verification]);
    mocks.verificationUpdateMany.mockImplementation(async () => {
      if (persistedStatus !== "PENDING") return { count: 0 };
      persistedStatus = "VERIFIED";
      return { count: 1 };
    });
    mocks.evidenceCreate.mockResolvedValue({ id: "evidence-1" });

    const results = await Promise.all([
      ExecutionWorker.resolvePendingVerifications(),
      ExecutionWorker.resolvePendingVerifications(),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(mocks.evidenceCreate).toHaveBeenCalledTimes(1);
    expect(mocks.verificationUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.executionComplete).toHaveBeenCalledTimes(1);
    expect(mocks.taskComplete).toHaveBeenCalledTimes(1);
  });

  it("recovers a verified record whose job transition was interrupted", async () => {
    mocks.verificationFindMany.mockResolvedValue([
      {
        id: "verification-1",
        status: "VERIFIED",
        workspaceId: "workspace-1",
        projectId: "project-1",
        brandId: "brand-1",
        executionJob: {
          id: "job-1",
          status: "VERIFYING",
          projectId: "project-1",
          taskId: "task-1",
          capability: "WEB_RESEARCH",
          rawResult: { isMock: false },
        },
      },
    ]);

    await expect(ExecutionWorker.resolvePendingVerifications()).resolves.toBe(
      1,
    );

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.evidenceCreate).not.toHaveBeenCalled();
    expect(mocks.executionComplete).toHaveBeenCalledWith("job-1", "project-1");
    expect(mocks.taskComplete).toHaveBeenCalledWith("task-1", "project-1");
  });

  it("does not finalize a reclaimed event while its job lacks a provider reference", async () => {
    const claimedUntil = new Date("2026-08-08T00:15:00.000Z");
    mocks.claimBatch.mockResolvedValue([
      {
        id: "event-1",
        eventType: "execution.dispatch",
        payload: { executionJobId: "job-1", riskLevel: "LOW" },
        attemptCount: 0,
        nextAttemptAt: claimedUntil,
        reclaimed: true,
      },
    ]);
    mocks.executionStart.mockResolvedValue({
      id: "job-1",
      status: "RUNNING",
      providerExecutionReference: null,
    });

    await expect(ExecutionWorker.processDispatchQueue()).resolves.toBe(0);

    expect(mocks.executionStart).toHaveBeenCalledWith("job-1", "LOW", {
      recoverStalledDispatch: true,
    });
    expect(mocks.markProcessed).not.toHaveBeenCalled();
    // Backoff has jitter (+-25%): a range is verified, not the exact value —
    // otherwise jobs that fail at the same time would retry at the same time.
    expectBackoffRetry(1, 4_000, claimedUntil);
  });

  it("still recovers a stuck job on a normal (non-reclaimed) retry", async () => {
    // Regression guard: a job left RUNNING with no providerExecutionReference
    // after provider.execute() throws on attempt #1 must self-heal on later
    // attempts even though scheduleRetry always leaves the outbox event
    // non-reclaimed (PENDING, not a stale PROCESSING lease). Passing
    // recoverStalledDispatch only on event.reclaimed missed this — the far
    // more common path — leaving the job wedged until it was dead-lettered
    // with a synthetic error instead of the real provider failure.
    const claimedUntil = new Date("2026-08-08T00:15:00.000Z");
    mocks.claimBatch.mockResolvedValue([
      {
        id: "event-1",
        eventType: "execution.dispatch",
        payload: { executionJobId: "job-1", riskLevel: "LOW" },
        attemptCount: 1,
        nextAttemptAt: claimedUntil,
        reclaimed: false,
      },
    ]);
    mocks.executionStart.mockResolvedValue({
      id: "job-1",
      status: "RUNNING",
      providerExecutionReference: null,
    });

    await expect(ExecutionWorker.processDispatchQueue()).resolves.toBe(0);

    expect(mocks.executionStart).toHaveBeenCalledWith("job-1", "LOW", {
      recoverStalledDispatch: true,
    });
    expect(mocks.markProcessed).not.toHaveBeenCalled();
    expectBackoffRetry(2, 8_000, claimedUntil);
  });
});

// Verifies that a retry is scheduled within +-25% of the expected base
// backoff for the given attempt.
function expectBackoffRetry(
  attempt: number,
  baseMs: number,
  claimedUntil: Date,
) {
  expect(mocks.scheduleRetry).toHaveBeenCalledTimes(1);
  const call = mocks.scheduleRetry.mock.calls[0];
  expect(call?.[0]).toBe("event-1");
  expect(call?.[1]).toBe(attempt);
  expect(call?.[2]).toBeGreaterThanOrEqual(baseMs * 0.75);
  expect(call?.[2]).toBeLessThanOrEqual(baseMs * 1.25);
  expect(call?.[3]).toBe(claimedUntil);
}
