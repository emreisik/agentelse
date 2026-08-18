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
  isHubConnectError: vi.fn(),
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
  isHubConnectError: mocks.isHubConnectError,
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
// Gözlemlenebilirlik aşamalarının kendi testleri var; burada worker'ın
// akışını ölçüyoruz, onların prisma çağrıları sayaçları kirletmesin.
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
    expect(mocks.claimBatch).not.toHaveBeenCalled();

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

  it("releases the single-flight lock when a tick fails", async () => {
    // Yalıtılmamış aşama: dispatch kuyruğu patlarsa tick gerçekten düşer.
    mocks.claimBatch.mockRejectedValueOnce(new Error("dispatch failed"));

    const first = ExecutionWorker.tick();
    const overlapping = ExecutionWorker.tick();

    await expect(Promise.all([first, overlapping])).rejects.toThrow(
      "dispatch failed",
    );
    expect(mocks.claimBatch).toHaveBeenCalledTimes(1);

    await ExecutionWorker.tick();
    expect(mocks.claimBatch).toHaveBeenCalledTimes(2);
  });

  it("bozuk bir zamanlayıcı tick'in geri kalanını düşürmez", async () => {
    // Aşama yalıtımı: tek bir bozuk cron ifadesi dispatch/poll/verify
    // adımlarını da engelliyordu; artık hata kaydedilip devam edilir.
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
      recoverStalledDispatch: false,
    });
    expect(mocks.markProcessed).toHaveBeenCalledTimes(1);
    expect(mocks.markProcessed).toHaveBeenCalledWith(
      "event-1",
      claimedUntil,
    );
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

    // Backoff jitter'lı (±%25): tam değer değil aralık doğrulanır, aksi
    // halde aynı anda düşen işler aynı anda yeniden denenir.
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

    expect(mocks.markFailed).toHaveBeenCalledWith(
      "event-1",
      5,
      claimedUntil,
    );
    expect(mocks.deadLetterCreate).toHaveBeenCalledWith({
      executionJobId: "job-1",
      reason: "execution.dispatch failed after max attempts",
      payload: { executionJobId: "job-1", riskLevel: "HIGH" },
      attempts: 5,
      lastError: "provider timed out",
    });
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
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
    expect(mocks.executionComplete).toHaveBeenCalledWith(
      "job-1",
      "project-1",
    );
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
    // Backoff jitter'lı (±%25): tam değer değil aralık doğrulanır, aksi
    // halde aynı anda düşen işler aynı anda yeniden denenir.
    expectBackoffRetry(1, 4_000, claimedUntil);
  });
});

// attempt için beklenen taban backoff'un ±%25 bandında bir yeniden deneme
// planlandığını doğrular.
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
