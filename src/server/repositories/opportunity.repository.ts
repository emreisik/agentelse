import "server-only";

import {
  Prisma,
  type OpportunityStatus,
  type SignalCategory,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateOpportunityInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  insightId?: string;
  title: string;
  description?: string;
  category?: SignalCategory;
  goalIds?: string[];
  valueScore?: number;
  urgencyScore?: number;
  confidenceScore?: number;
  riskScore?: number;
  evidenceStrength?: number;
  nbaScore?: number;
  timeWindowStart?: Date;
  timeWindowEnd?: Date;
  fingerprint?: string;
  isMock?: boolean;
};

export type CreateOpportunityResult =
  | {
      duplicate: false;
      opportunity: Awaited<ReturnType<typeof prisma.opportunity.create>>;
    }
  | { duplicate: true; existingId: string };

export const OpportunityRepository = {
  async create(
    input: CreateOpportunityInput,
  ): Promise<CreateOpportunityResult> {
    try {
      const opportunity = await prisma.opportunity.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
          insightId: input.insightId,
          title: input.title,
          description: input.description,
          category: input.category,
          goalIds: input.goalIds ?? [],
          valueScore: input.valueScore,
          urgencyScore: input.urgencyScore,
          confidenceScore: input.confidenceScore,
          riskScore: input.riskScore,
          evidenceStrength: input.evidenceStrength,
          nbaScore: input.nbaScore,
          timeWindowStart: input.timeWindowStart,
          timeWindowEnd: input.timeWindowEnd,
          fingerprint: input.fingerprint,
          isMock: input.isMock ?? false,
        },
      });
      return { duplicate: false, opportunity };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        input.fingerprint
      ) {
        const existing = await prisma.opportunity.findUnique({
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

  findByIdInProject(opportunityId: string, projectId: string) {
    return prisma.opportunity.findFirst({
      where: { id: opportunityId, projectId },
    });
  },

  // Cooldown check: an existing DISMISSED/EXPIRED opportunity with the same
  // fingerprint whose cooldownUntil is in the future blocks recreation.
  findCoolingDown(projectId: string, fingerprint: string) {
    return prisma.opportunity.findFirst({
      where: {
        projectId,
        fingerprint,
        cooldownUntil: { gt: new Date() },
      },
    });
  },

  listForProject(
    projectId: string,
    filter?: { status?: OpportunityStatus; limit?: number },
  ) {
    return prisma.opportunity.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: [{ nbaScore: "desc" }, { createdAt: "desc" }],
      take: filter?.limit ?? 100,
    });
  },

  // Opportunities still waiting for attention: the ones the cap
  // (maxOpenOpportunities) is there to keep from piling up. ACCEPTED is NOT
  // open: it is what an opportunity becomes once ideas were made from it, and
  // nothing ever moves it on, so counting it filled the cap for good (30
  // opportunities with ideas and the project could never get a new one).
  countOpen(projectId: string) {
    return prisma.opportunity.count({
      where: {
        projectId,
        status: { in: ["NEW", "REVIEWING", "EVALUATED"] },
      },
    });
  },

  async transition(
    opportunityId: string,
    projectId: string,
    to: OpportunityStatus,
    extra?: { cooldownUntil?: Date; duplicateOfId?: string; nbaScore?: number },
  ) {
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: opportunityId, projectId },
    });
    if (!opportunity)
      throw new AgentelseError(
        "NOT_FOUND",
        `Opportunity ${opportunityId} not found in project ${projectId}`,
      );

    StateMachine.assertOpportunityTransition(opportunity.status, to);

    return prisma.opportunity.update({
      where: { id: opportunityId },
      data: {
        status: to,
        cooldownUntil: extra?.cooldownUntil ?? opportunity.cooldownUntil,
        duplicateOfId: extra?.duplicateOfId ?? opportunity.duplicateOfId,
        nbaScore: extra?.nbaScore ?? opportunity.nbaScore,
      },
    });
  },
};
