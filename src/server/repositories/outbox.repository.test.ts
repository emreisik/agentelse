import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  create: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    outboxEvent: {
      create: prismaMocks.create,
      findFirst: prismaMocks.findFirst,
      findMany: prismaMocks.findMany,
      update: prismaMocks.update,
      updateMany: prismaMocks.updateMany,
    },
  },
}));

import {
  OUTBOX_EVENT_TYPES,
  OUTBOX_PROCESSING_LEASE_MS,
  OutboxRepository,
} from "@/server/repositories/outbox.repository";

const event = {
  id: "event-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  aggregateType: "ExecutionJob",
  aggregateId: "job-1",
  eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
  payload: { executionJobId: "job-1", riskLevel: "LOW" },
  status: "PENDING" as const,
  executionJobId: "job-1",
  attemptCount: 0,
  nextAttemptAt: new Date("2026-08-08T00:00:00.000Z"),
  processedAt: null,
  createdAt: new Date("2026-08-08T00:00:00.000Z"),
};

describe("OutboxRepository.claimBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an event to only one of two concurrent claimers", async () => {
    let persistedStatus = "PENDING";

    // Both workers have already observed the same candidate. PostgreSQL's
    // conditional UPDATE is the serialization point that chooses a winner.
    prismaMocks.findMany.mockResolvedValue([event]);
    prismaMocks.updateMany.mockImplementation(
      async (input: { where: { status: string } }) => {
        if (
          input.where.status === "PENDING" &&
          persistedStatus === "PENDING"
        ) {
          persistedStatus = "PROCESSING";
          return { count: 1 };
        }
        return { count: 0 };
      },
    );

    const claims = await Promise.all([
      OutboxRepository.claimBatch(
        10,
        OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
      ),
      OutboxRepository.claimBatch(
        10,
        OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
      ),
    ]);

    expect(claims.flat()).toHaveLength(1);
    expect(claims.flat()[0]).toMatchObject({
      id: event.id,
      status: "PROCESSING",
      reclaimed: false,
    });
    expect(prismaMocks.updateMany).toHaveBeenCalledTimes(2);

    const candidateQuery = prismaMocks.findMany.mock.calls[0]?.[0];
    const claimUpdate = prismaMocks.updateMany.mock.calls[0]?.[0];
    expect(candidateQuery.where.eventType).toBe(
      OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
    );
    expect(claimUpdate.where).toMatchObject({
      id: event.id,
      status: "PENDING",
      eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
    });
    expect(claimUpdate.where.nextAttemptAt.lte).toBe(
      candidateQuery.where.nextAttemptAt.lte,
    );
    expect(claims.flat()[0]?.nextAttemptAt.getTime()).toBe(
      candidateQuery.where.nextAttemptAt.lte.getTime() +
        OUTBOX_PROCESSING_LEASE_MS,
    );
  });

  it("reclaims a PROCESSING event only after its lease has expired", async () => {
    const stale = { ...event, status: "PROCESSING" as const };
    prismaMocks.findMany.mockResolvedValue([stale]);
    prismaMocks.updateMany.mockResolvedValue({ count: 1 });

    const claimed = await OutboxRepository.claimBatch(
      1,
      OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: stale.id,
      status: "PROCESSING",
      reclaimed: true,
    });
    expect(prismaMocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: stale.id,
        status: "PROCESSING",
        nextAttemptAt: { lte: expect.any(Date) },
        eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
      },
      data: {
        status: "PROCESSING",
        nextAttemptAt: expect.any(Date),
      },
    });
  });

  it("does not query PostgreSQL for an empty batch", async () => {
    await expect(OutboxRepository.claimBatch(0)).resolves.toEqual([]);
    expect(prismaMocks.findMany).not.toHaveBeenCalled();
    expect(prismaMocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("OutboxRepository.claimDispatchForInline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("takes a PENDING dispatch event out of the worker's hands", async () => {
    prismaMocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      OutboxRepository.claimDispatchForInline("job-1"),
    ).resolves.toBe("claimed");

    // Only a PENDING event of THIS job is taken, atomically (one UPDATE).
    expect(prismaMocks.updateMany).toHaveBeenCalledWith({
      where: {
        executionJobId: "job-1",
        eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
        status: "PENDING",
      },
      data: { status: "PROCESSED", processedAt: expect.any(Date) },
    });
    expect(prismaMocks.findFirst).not.toHaveBeenCalled();
  });

  it("reports the worker as the owner when it already holds the event", async () => {
    prismaMocks.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.findFirst.mockResolvedValue({ id: "event-1" });

    await expect(
      OutboxRepository.claimDispatchForInline("job-1"),
    ).resolves.toBe("worker");
    expect(prismaMocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executionJobId: "job-1",
          status: "PROCESSING",
        }),
      }),
    );
  });

  it("reports no live dispatch when the event is already processed or absent", async () => {
    prismaMocks.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.findFirst.mockResolvedValue(null);

    await expect(
      OutboxRepository.claimDispatchForInline("job-1"),
    ).resolves.toBe("none");
  });

  it("gives the event to only one of an inline caller and a worker", async () => {
    let persistedStatus = "PENDING";
    // The worker's claimBatch CAS and the inline claim both need the row to
    // still be PENDING; PostgreSQL's conditional UPDATE picks the winner.
    prismaMocks.updateMany.mockImplementation(
      async (input: { where: { status: string } }) => {
        if (input.where.status === "PENDING" && persistedStatus === "PENDING") {
          persistedStatus = "PROCESSED";
          return { count: 1 };
        }
        return { count: 0 };
      },
    );
    prismaMocks.findMany.mockResolvedValue([event]);
    prismaMocks.findFirst.mockResolvedValue(null);

    const inline = await OutboxRepository.claimDispatchForInline("job-1");
    const worker = await OutboxRepository.claimBatch(
      10,
      OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
    );

    expect(inline).toBe("claimed");
    expect(worker).toEqual([]);
  });
});
