import { beforeEach, describe, expect, it, vi } from "vitest";

// The critical guarantee of auto-recovery: it only retries TRANSIENT
// errors. Retrying balance/key/configuration errors means an infinite loop
// and wasted cost — this behavior must be nailed down with a test.

const deadLetterJob = {
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
};
const executionJob = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
};
const task = {
  findUnique: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    deadLetterJob,
    executionJob,
    task,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        outboxEvent: { create: vi.fn() },
        deadLetterJob,
        executionJob,
      }),
  },
}));

vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/server/repositories/outbox.repository", () => ({
  OUTBOX_EVENT_TYPES: { EXECUTION_DISPATCH: "execution.dispatch" },
  OutboxRepository: { enqueue: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn().mockResolvedValue(undefined) },
}));

const { SelfHealingService } =
  await import("@/server/observability/self-healing.service");
const { OutboxRepository } =
  await import("@/server/repositories/outbox.repository");
const { TaskRepository } =
  await import("@/server/repositories/task.repository");

function deadLetter(overrides: Record<string, unknown> = {}) {
  return {
    id: "dl-1",
    executionJobId: "job-1",
    reason: "execution.dispatch failed after max attempts",
    lastError: "aborted",
    attempts: 5,
    payload: { executionJobId: "job-1", riskLevel: "LOW" },
    createdAt: new Date("2026-08-08T10:00:00Z"),
    resolvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deadLetterJob.count.mockResolvedValue(1);
  deadLetterJob.update.mockResolvedValue({});
  executionJob.findUnique.mockResolvedValue({
    id: "job-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    status: "FAILED",
  });
  executionJob.updateMany.mockResolvedValue({ count: 1 });
  task.findUnique.mockResolvedValue({
    status: "RUNNING",
    projectId: "p-1",
  });
});

describe("requeueRecoverableDeadLetters", () => {
  it("requeues a timeout error", async () => {
    deadLetterJob.findMany.mockResolvedValue([deadLetter()]);

    const result = await SelfHealingService.requeueRecoverableDeadLetters();

    expect(result).toEqual({ requeued: 1, skipped: 0 });
    expect(OutboxRepository.enqueue).toHaveBeenCalledTimes(1);
  });

  // Bug A (audit problem 15): requeueRecoverableDeadLetters previously only
  // created a fresh OutboxEvent and never flipped the ExecutionJob back to
  // QUEUED. Since execution-service.ts's startExecution() no-ops on
  // `job.status !== "QUEUED"`, that fresh event was processed as a silent
  // no-op — the job stayed FAILED forever and the "auto-heal" was a no-op
  // dressed up as a success. This is the fix: the same transaction that
  // enqueues the retry must also CAS the job FAILED -> QUEUED.
  it("also transitions the ExecutionJob back to QUEUED so the requeued outbox event is not silently ignored by startExecution's `job.status !== QUEUED` guard", async () => {
    deadLetterJob.findMany.mockResolvedValue([deadLetter()]);

    const result = await SelfHealingService.requeueRecoverableDeadLetters();

    expect(result).toEqual({ requeued: 1, skipped: 0 });
    expect(executionJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "FAILED" },
      data: { status: "QUEUED" },
    });
  });

  it("does NOT touch a balance error", async () => {
    deadLetterJob.findMany.mockResolvedValue([
      deadLetter({ lastError: "Your credit balance is too low" }),
    ]);

    const result = await SelfHealingService.requeueRecoverableDeadLetters();

    expect(result).toEqual({ requeued: 0, skipped: 1 });
    expect(OutboxRepository.enqueue).not.toHaveBeenCalled();
  });

  it("does NOT touch a configuration error", async () => {
    deadLetterJob.findMany.mockResolvedValue([
      deadLetter({
        lastError: "No execution provider available for capability SIGNAL_SCAN",
      }),
    ]);

    const result = await SelfHealingService.requeueRecoverableDeadLetters();

    expect(result.requeued).toBe(0);
    expect(OutboxRepository.enqueue).not.toHaveBeenCalled();
  });

  it("stops once the retry cap for the same job is exceeded", async () => {
    deadLetterJob.findMany.mockResolvedValue([deadLetter()]);
    deadLetterJob.count.mockResolvedValue(4); // MAX_AUTO_REQUEUES_PER_JOB = 3

    const result = await SelfHealingService.requeueRecoverableDeadLetters();

    expect(result).toEqual({ requeued: 0, skipped: 1 });
    expect(OutboxRepository.enqueue).not.toHaveBeenCalled();
  });

  it("does not requeue a completed job, and closes the record", async () => {
    deadLetterJob.findMany.mockResolvedValue([deadLetter()]);
    executionJob.findUnique.mockResolvedValue({
      id: "job-1",
      workspaceId: "ws-1",
      projectId: "p-1",
      status: "COMPLETED",
    });

    const result = await SelfHealingService.requeueRecoverableDeadLetters();

    expect(result).toEqual({ requeued: 0, skipped: 1 });
    expect(OutboxRepository.enqueue).not.toHaveBeenCalled();
    expect(deadLetterJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "dl-1" } }),
    );
  });
});

describe("resetStuckJobs", () => {
  const now = new Date("2026-08-08T12:00:00Z");

  it("turns a job that hasn't progressed in a long time into FAILED", async () => {
    executionJob.findMany.mockResolvedValue([
      {
        id: "job-9",
        taskId: "task-9",
        workspaceId: "ws-1",
        projectId: "p-1",
        capability: "WEB_RESEARCH",
        providerId: "openclaw",
        updatedAt: new Date("2026-08-08T10:00:00Z"),
      },
    ]);
    executionJob.updateMany.mockResolvedValue({ count: 1 });

    expect(await SelfHealingService.resetStuckJobs(now)).toBe(1);
    expect(executionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorCode: "STUCK_TIMEOUT",
          retryable: true,
        }),
      }),
    );
  });

  it("does not count a job that progressed in the meantime", async () => {
    executionJob.findMany.mockResolvedValue([
      {
        id: "job-9",
        taskId: "task-9",
        workspaceId: "ws-1",
        projectId: "p-1",
        capability: "WEB_RESEARCH",
        providerId: "openclaw",
        updatedAt: new Date("2026-08-08T10:00:00Z"),
      },
    ]);
    // The conditional update affected no rows = the job genuinely progressed.
    executionJob.updateMany.mockResolvedValue({ count: 0 });

    expect(await SelfHealingService.resetStuckJobs(now)).toBe(0);
    expect(TaskRepository.transition).not.toHaveBeenCalled();
  });

  it("also transitions the parent Task to FAILED — the job alone getting reset previously left the Task stuck showing RUNNING forever", async () => {
    executionJob.findMany.mockResolvedValue([
      {
        id: "job-9",
        taskId: "task-9",
        workspaceId: "ws-1",
        projectId: "p-1",
        capability: "WEB_RESEARCH",
        providerId: "openclaw",
        updatedAt: new Date("2026-08-08T10:00:00Z"),
      },
    ]);
    executionJob.updateMany.mockResolvedValue({ count: 1 });
    task.findUnique.mockResolvedValue({ status: "RUNNING", projectId: "p-1" });

    await SelfHealingService.resetStuckJobs(now);

    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "task-9",
      "p-1",
      "FAILED",
      { failureReason: "Stuck job automatically timed out" },
    );
  });

  it("does not re-transition a Task that's already terminal", async () => {
    executionJob.findMany.mockResolvedValue([
      {
        id: "job-9",
        taskId: "task-9",
        workspaceId: "ws-1",
        projectId: "p-1",
        capability: "WEB_RESEARCH",
        providerId: "openclaw",
        updatedAt: new Date("2026-08-08T10:00:00Z"),
      },
    ]);
    executionJob.updateMany.mockResolvedValue({ count: 1 });
    task.findUnique.mockResolvedValue({ status: "FAILED", projectId: "p-1" });

    await SelfHealingService.resetStuckJobs(now);

    expect(TaskRepository.transition).not.toHaveBeenCalled();
  });
});
