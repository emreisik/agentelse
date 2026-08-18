import "server-only";

import type {
  CouncilRecommendation,
  CouncilType,
  CreativeLens,
  IdeaStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateIdeaInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  opportunityId?: string;
  lens?: CreativeLens;
  title: string;
  description: string;
  concept?: unknown;
  fingerprint?: string;
  isMock?: boolean;
};

export type CreateCouncilEvaluationInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  ideaId: string;
  councilType: CouncilType;
  scores: Record<string, number>;
  overallScore: number;
  recommendation: CouncilRecommendation;
  rationale?: string;
  reasoningCallId?: string;
  isMock?: boolean;
};

export const IdeaRepository = {
  create(input: CreateIdeaInput) {
    return prisma.idea.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        opportunityId: input.opportunityId,
        lens: input.lens,
        title: input.title,
        description: input.description,
        concept: input.concept as never,
        fingerprint: input.fingerprint,
        isMock: input.isMock ?? false,
      },
    });
  },

  findByIdInProject(ideaId: string, projectId: string) {
    return prisma.idea.findFirst({
      where: { id: ideaId, projectId },
      include: { councilEvaluations: true },
    });
  },

  // Soft dedup: same opportunity + lens means the foundry already produced
  // this angle — skip instead of generating a near-identical idea.
  existsForOpportunityLens(opportunityId: string, lens: CreativeLens) {
    return prisma.idea
      .count({ where: { opportunityId, lens } })
      .then((count) => count > 0);
  },

  listForProject(
    projectId: string,
    filter?: { status?: IdeaStatus; limit?: number },
  ) {
    return prisma.idea.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: [{ nbaScore: "desc" }, { createdAt: "desc" }],
      take: filter?.limit ?? 100,
      include: { councilEvaluations: true },
    });
  },

  listByStatus(status: IdeaStatus, limit: number) {
    return prisma.idea.findMany({
      where: { status },
      take: limit,
      orderBy: { createdAt: "asc" },
      include: { councilEvaluations: true },
    });
  },

  countActive(projectId: string) {
    return prisma.idea.count({
      where: {
        projectId,
        status: {
          in: [
            "RAW",
            "RESEARCHING",
            "VALIDATED",
            "CONCEPT",
            "SHORTLISTED",
            "APPROVED",
            "PLANNING",
            "ACTIVE",
          ],
        },
      },
    });
  },

  async transition(
    ideaId: string,
    projectId: string,
    to: IdeaStatus,
    extra?: { scores?: unknown; nbaScore?: number; workPlanId?: string },
  ) {
    const idea = await prisma.idea.findFirst({
      where: { id: ideaId, projectId },
    });
    if (!idea)
      throw new HubConnectError(
        "NOT_FOUND",
        `Idea ${ideaId} not found in project ${projectId}`,
      );

    StateMachine.assertIdeaTransition(idea.status, to);

    return prisma.idea.update({
      where: { id: ideaId },
      data: {
        status: to,
        scores:
          extra?.scores === undefined
            ? (idea.scores as never)
            : (extra.scores as never),
        nbaScore: extra?.nbaScore ?? idea.nbaScore,
        workPlanId: extra?.workPlanId ?? idea.workPlanId,
      },
    });
  },

  addCouncilEvaluation(input: CreateCouncilEvaluationInput) {
    return prisma.councilEvaluation.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        ideaId: input.ideaId,
        councilType: input.councilType,
        scores: input.scores,
        overallScore: input.overallScore,
        recommendation: input.recommendation,
        rationale: input.rationale,
        reasoningCallId: input.reasoningCallId,
        isMock: input.isMock ?? false,
      },
    });
  },

  listEvaluations(ideaId: string) {
    return prisma.councilEvaluation.findMany({
      where: { ideaId },
      orderBy: { createdAt: "asc" },
    });
  },
};
