import { beforeEach, describe, expect, it, vi } from "vitest";

const executionJob = { updateMany: vi.fn() };
const task = { findUnique: vi.fn() };
const approval = { findFirst: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { executionJob, task, approval },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn().mockResolvedValue(undefined) },
}));

const { BacklogGate, STALE_AFTER_OUTAGE_REASON } =
  await import("@/server/execution/backlog-gate");
const { TaskRepository } =
  await import("@/server/repositories/task.repository");

const NOW = new Date("2026-10-06T12:00:00Z");
const HOUR = 3600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const job = {
  id: "job-1",
  taskId: "task-1",
  workspaceId: "ws-1",
  projectId: "p-1",
  capability: "META_ADSET_CREATE" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  executionJob.updateMany.mockResolvedValue({ count: 1 });
  task.findUnique.mockResolvedValue({
    createdAt: ago(5 * 24 * HOUR),
    status: "QUEUED",
  });
  approval.findFirst.mockResolvedValue({ reviewedAt: ago(5 * 24 * HOUR) });
});

describe("BacklogGate.cancelIfStale", () => {
  it("cancels a stale Meta write and its task instead of running it", async () => {
    await expect(BacklogGate.cancelIfStale(job, NOW)).resolves.toBe(true);

    expect(executionJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: "QUEUED" },
      data: expect.objectContaining({
        status: "CANCELLED",
        errorCode: "STALE_AFTER_OUTAGE",
        retryable: false,
      }),
    });
    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "task-1",
      "p-1",
      "CANCELLED",
      { failureReason: STALE_AFTER_OUTAGE_REASON },
    );
  });

  it("does nothing for a fresh approval", async () => {
    task.findUnique.mockResolvedValue({
      createdAt: ago(2 * HOUR),
      status: "QUEUED",
    });
    approval.findFirst.mockResolvedValue({ reviewedAt: ago(HOUR) });

    await expect(BacklogGate.cancelIfStale(job, NOW)).resolves.toBe(false);
    expect(executionJob.updateMany).not.toHaveBeenCalled();
  });

  it("never reads the database for a non-Meta capability", async () => {
    await expect(
      BacklogGate.cancelIfStale(
        { ...job, capability: "INSTAGRAM_PUBLISH" },
        NOW,
      ),
    ).resolves.toBe(false);
    expect(task.findUnique).not.toHaveBeenCalled();
  });

  it("leaves a job another worker already claimed (CAS lost)", async () => {
    executionJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(BacklogGate.cancelIfStale(job, NOW)).resolves.toBe(false);
    expect(TaskRepository.transition).not.toHaveBeenCalled();
  });

  it("does not move a task that is already terminal", async () => {
    task.findUnique.mockResolvedValue({
      createdAt: ago(5 * 24 * HOUR),
      status: "CANCELLED",
    });

    await expect(BacklogGate.cancelIfStale(job, NOW)).resolves.toBe(true);
    expect(TaskRepository.transition).not.toHaveBeenCalled();
  });
});
