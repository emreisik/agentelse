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
    const candidates = await prisma.agencyTrigger.findMany({
      where: { status: "PENDING", scheduledFor: { lte: new Date() } },
      take: limit,
      orderBy: { scheduledFor: "asc" },
    });

    // Sent together, each swap atomic on its own row; order kept.
    const results = await Promise.all(
      candidates.map((trigger) =>
        prisma.agencyTrigger.updateMany({
          where: { id: trigger.id, status: "PENDING" },
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
    return prisma.agencyTrigger.update({
      where: { id: triggerId },
      data: { status: "PENDING" },
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
