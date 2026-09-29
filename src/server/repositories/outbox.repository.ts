import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const OUTBOX_EVENT_TYPES = {
  EXECUTION_DISPATCH: "execution.dispatch",
} as const;

export const OUTBOX_PROCESSING_LEASE_MS = 15 * 60_000;

type DbClient = PrismaClient | Prisma.TransactionClient;

export const OutboxRepository = {
  // Accepts an optional transaction client so callers can write the
  // aggregate (ExecutionJob) and its outbox event atomically.
  enqueue(
    db: DbClient,
    input: {
      workspaceId: string;
      projectId?: string;
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      payload: unknown;
      executionJobId?: string;
    },
  ) {
    return db.outboxEvent.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload as never,
        executionJobId: input.executionJobId,
        status: "PENDING",
      },
    });
  },

  async claimBatch(limit: number, eventType?: string) {
    if (limit <= 0) return [];

    const claimCutoff = new Date();
    const leaseUntil = new Date(
      claimCutoff.getTime() + OUTBOX_PROCESSING_LEASE_MS,
    );
    const candidates = await prisma.outboxEvent.findMany({
      where: {
        status: { in: ["PENDING", "PROCESSING"] },
        nextAttemptAt: { lte: claimCutoff },
        ...(eventType ? { eventType } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    // The candidate read is intentionally followed by a compare-and-swap.
    // PostgreSQL evaluates each update atomically: when two workers saw the
    // same PENDING row, only one can flip it to PROCESSING and receive it in
    // its claimed batch. SKIP LOCKED raw SQL would also work, but this keeps
    // the repository on Prisma's typed API and matches AgencyTrigger claims.
    const claimed: Array<
      (typeof candidates)[number] & { reclaimed: boolean }
    > = [];
    for (const event of candidates) {
      const result = await prisma.outboxEvent.updateMany({
        where: {
          id: event.id,
          status: event.status,
          nextAttemptAt: { lte: claimCutoff },
          ...(eventType ? { eventType } : {}),
        },
        data: { status: "PROCESSING", nextAttemptAt: leaseUntil },
      });

      if (result.count === 1) {
        claimed.push({
          ...event,
          status: "PROCESSING",
          nextAttemptAt: leaseUntil,
          reclaimed: event.status === "PROCESSING",
        });
      }
    }

    return claimed;
  },

  // A chat turn that drives its own execution job (see inline-job.ts) takes
  // that job's dispatch event out of the worker's hands. Without this the
  // event stays PENDING while the job sits at RUNNING with no provider
  // reference (the OpenAI providers do their whole generation inside
  // execute()), and the worker's stalled-dispatch recovery would reset the job
  // to QUEUED and run the provider a second time — double spend.
  //  "claimed": the event was PENDING and is now PROCESSED; this caller owns it.
  //  "worker":  the worker holds it (PROCESSING); the job must NOT be started.
  //  "none":    no live dispatch event (already processed, or never enqueued).
  async claimDispatchForInline(
    executionJobId: string,
  ): Promise<"claimed" | "worker" | "none"> {
    const claimed = await prisma.outboxEvent.updateMany({
      where: {
        executionJobId,
        eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
        status: "PENDING",
      },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    if (claimed.count > 0) return "claimed";

    const held = await prisma.outboxEvent.findFirst({
      where: {
        executionJobId,
        eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
        status: "PROCESSING",
      },
      select: { id: true },
    });
    return held ? "worker" : "none";
  },

  markProcessed(id: string, claimedUntil: Date) {
    return prisma.outboxEvent.updateMany({
      where: { id, status: "PROCESSING", nextAttemptAt: claimedUntil },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  },

  scheduleRetry(
    id: string,
    attemptCount: number,
    delayMs: number,
    claimedUntil: Date,
  ) {
    return prisma.outboxEvent.updateMany({
      where: { id, status: "PROCESSING", nextAttemptAt: claimedUntil },
      data: {
        status: "PENDING",
        attemptCount,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
  },

  markFailed(id: string, attemptCount: number, claimedUntil: Date) {
    return prisma.outboxEvent.updateMany({
      where: { id, status: "PROCESSING", nextAttemptAt: claimedUntil },
      data: { status: "FAILED", attemptCount },
    });
  },
};
