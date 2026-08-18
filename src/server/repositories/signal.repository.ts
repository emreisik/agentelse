import "server-only";

import { Prisma, type SignalCategory, type SignalStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateSignalInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  source: string;
  category: SignalCategory;
  externalRef?: string;
  title: string;
  summary?: string;
  payload?: unknown;
  occurredAt?: Date;
  freshness?: number;
  reliability?: number;
  fingerprint: string;
  evidenceId?: string;
  sourceTaskId?: string;
};

export type CreateSignalResult =
  | {
      duplicate: false;
      signal: Awaited<ReturnType<typeof prisma.signal.create>>;
    }
  | { duplicate: true; existingId: string };

export const SignalRepository = {
  // Unique [projectId, fingerprint] is the dedup mechanism: a P2002 here is a
  // normal outcome (same signal seen twice), not an error.
  async create(input: CreateSignalInput): Promise<CreateSignalResult> {
    try {
      const signal = await prisma.signal.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
          source: input.source,
          category: input.category,
          externalRef: input.externalRef,
          title: input.title,
          summary: input.summary,
          payload: input.payload as never,
          occurredAt: input.occurredAt,
          freshness: input.freshness,
          reliability: input.reliability,
          fingerprint: input.fingerprint,
          evidenceId: input.evidenceId,
          sourceTaskId: input.sourceTaskId,
        },
      });
      return { duplicate: false, signal };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await prisma.signal.findUnique({
          where: {
            projectId_fingerprint: {
              projectId: input.projectId,
              fingerprint: input.fingerprint,
            },
          },
          select: { id: true },
        });
        return { duplicate: true, existingId: existing?.id ?? "" };
      }
      throw error;
    }
  },

  findByIdInProject(signalId: string, projectId: string) {
    return prisma.signal.findFirst({ where: { id: signalId, projectId } });
  },

  listByStatus(status: SignalStatus, limit: number) {
    return prisma.signal.findMany({
      where: { status },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
  },

  listForProject(
    projectId: string,
    filter?: { status?: SignalStatus; limit?: number },
  ) {
    return prisma.signal.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 100,
    });
  },

  async transition(
    signalId: string,
    projectId: string,
    to: SignalStatus,
    extra?: { relevanceScore?: number; duplicateOfId?: string },
  ) {
    const signal = await prisma.signal.findFirst({
      where: { id: signalId, projectId },
    });
    if (!signal)
      throw new HubConnectError(
        "NOT_FOUND",
        `Signal ${signalId} not found in project ${projectId}`,
      );

    StateMachine.assertSignalTransition(signal.status, to);

    return prisma.signal.update({
      where: { id: signalId },
      data: {
        status: to,
        relevanceScore: extra?.relevanceScore ?? signal.relevanceScore,
        duplicateOfId: extra?.duplicateOfId ?? signal.duplicateOfId,
      },
    });
  },
};
