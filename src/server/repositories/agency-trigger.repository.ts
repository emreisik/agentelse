import "server-only";

import { Prisma, type AgencyTriggerType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { StateMachine } from "@/server/state-machine/transitions";

export type EnqueueTriggerInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  type: AgencyTriggerType;
  payload?: unknown;
  dedupeKey?: string;
  scheduledFor?: Date;
};

// A claimed trigger whose worker vanished is taken back after this.
const PROCESSING_LEASE_MS = 15 * 60_000;

export function triggerBackoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 60_000, 60 * 60_000);
}

export const AgencyTriggerRepository = {
  // Duplicate dedupeKey (P2002) is swallowed — the trigger already exists,
  // which is exactly the dedup guarantee callers rely on.
  async enqueue(input: EnqueueTriggerInput): Promise<{ enqueued: boolean }> {
    try {
      await prisma.agencyTrigger.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
          type: input.type,
          payload: input.payload as never,
          dedupeKey: input.dedupeKey,
          scheduledFor: input.scheduledFor ?? new Date(),
        },
      });
      return { enqueued: true };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return { enqueued: false };
      }
      throw error;
    }
  },

  // Claim a batch by flipping PENDING -> PROCESSING; only rows we actually
  // flipped are returned, so two concurrent workers never process the same
  // trigger (updateMany's count-checked per-row claim).
  async claimPending(limit: number) {
    const now = new Date();
    // A PROCESSING row whose worker died (deploy overlap, crash) is taken over
    // once its lease ran out, instead of staying PROCESSING forever
    // (docs/meta-ads-plan.md F1).
    const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const candidates = await prisma.agencyTrigger.findMany({
      where: {
        OR: [
          { status: "PENDING", scheduledFor: { lte: now } },
          { status: "PROCESSING", updatedAt: { lt: staleBefore } },
        ],
      },
      take: limit,
      orderBy: { scheduledFor: "asc" },
    });

    // Sent together, each swap atomic on its own row; order kept. The swap is
    // conditional on the status (and, for a stale row, the same updatedAt) read
    // above, so two workers never take the same trigger.
    const results = await Promise.all(
      candidates.map((trigger) =>
        prisma.agencyTrigger.updateMany({
          where:
            trigger.status === "PROCESSING"
              ? { id: trigger.id, status: "PROCESSING", updatedAt: trigger.updatedAt }
              : { id: trigger.id, status: "PENDING" },
          data: { status: "PROCESSING" },
        }),
      ),
    );
    return candidates.filter((_, index) => results[index]?.count === 1);
  },

  async markProcessed(triggerId: string) {
    const trigger = await prisma.agencyTrigger.findUnique({
      where: { id: triggerId },
    });
    if (!trigger) return null;
    StateMachine.assertAgencyTriggerTransition(trigger.status, "PROCESSED");
    return prisma.agencyTrigger.update({
      where: { id: triggerId },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  },

  async markFailed(triggerId: string, error: string, maxAttempts = 5) {
    const trigger = await prisma.agencyTrigger.findUnique({
      where: { id: triggerId },
    });
    if (!trigger) return null;

    const attemptCount = trigger.attemptCount + 1;
    // Failure is always PROCESSING -> FAILED; a retry then walks
    // FAILED -> PENDING (both legal per the transition table).
    StateMachine.assertAgencyTriggerTransition(trigger.status, "FAILED");
    await prisma.agencyTrigger.update({
      where: { id: triggerId },
      data: { status: "FAILED", attemptCount, error },
    });
    if (attemptCount >= maxAttempts) return null;
    // Retried with a growing pause (2, 4, 8... minutes, at most an hour),
    // not on the very next tick.
    return prisma.agencyTrigger.update({
      where: { id: triggerId },
      data: {
        status: "PENDING",
        scheduledFor: new Date(Date.now() + triggerBackoffMs(attemptCount)),
      },
    });
  },

  listForProject(projectId: string, limit = 50) {
    return prisma.agencyTrigger.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },
};
