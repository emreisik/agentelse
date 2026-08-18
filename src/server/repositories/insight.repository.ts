import "server-only";

import {
  Prisma,
  type InsightStatus,
  type SignalCategory,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateInsightInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  title: string;
  summary: string;
  category?: SignalCategory;
  findingIds?: string[];
  signalIds?: string[];
  importance?: number;
  fingerprint: string;
  isMock?: boolean;
};

export type CreateInsightResult =
  | {
      duplicate: false;
      insight: Awaited<ReturnType<typeof prisma.insight.create>>;
    }
  | { duplicate: true; existingId: string };

export const InsightRepository = {
  async create(input: CreateInsightInput): Promise<CreateInsightResult> {
    try {
      const insight = await prisma.insight.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
          title: input.title,
          summary: input.summary,
          category: input.category,
          findingIds: input.findingIds ?? [],
          signalIds: input.signalIds ?? [],
          importance: input.importance,
          fingerprint: input.fingerprint,
          isMock: input.isMock ?? false,
        },
      });
      return { duplicate: false, insight };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await prisma.insight.findUnique({
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

  findByIdInProject(insightId: string, projectId: string) {
    return prisma.insight.findFirst({ where: { id: insightId, projectId } });
  },

  listByStatus(status: InsightStatus, limit: number) {
    return prisma.insight.findMany({
      where: { status },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
  },

  listForProject(
    projectId: string,
    filter?: { status?: InsightStatus; limit?: number },
  ) {
    return prisma.insight.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 100,
    });
  },

  async transition(insightId: string, projectId: string, to: InsightStatus) {
    const insight = await prisma.insight.findFirst({
      where: { id: insightId, projectId },
    });
    if (!insight)
      throw new AgentelseError(
        "NOT_FOUND",
        `Insight ${insightId} not found in project ${projectId}`,
      );

    StateMachine.assertInsightTransition(insight.status, to);

    return prisma.insight.update({
      where: { id: insightId },
      data: { status: to },
    });
  },
};
