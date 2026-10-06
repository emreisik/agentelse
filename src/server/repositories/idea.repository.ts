import "server-only";

import type {
  CouncilRecommendation,
  CouncilType,
  CreativeLens,
  IdeaStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

const SCHEDULING_PRE_SHORTLIST: ReadonlySet<IdeaStatus> = new Set([
  "RAW",
  "RESEARCHING",
  "VALIDATED",
  "CONCEPT",
]);
const SCHEDULING_CHAIN: readonly IdeaStatus[] = [
  "SHORTLISTED",
  "APPROVED",
  "PLANNING",
  "ACTIVE",
  "MEASURING",
];

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
  // Typed ideas (src/lib/ideas/concept.ts) are born VALIDATED: out of reach of
  // the old Council (RAW) and Director (SHORTLISTED). Absent = RAW.
  status?: IdeaStatus;
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

// Where each pre-shortlist status has to go next to reach SHORTLISTED.
const PROMOTION_PATH: Partial<Record<IdeaStatus, IdeaStatus[]>> = {
  RAW: ["VALIDATED", "CONCEPT", "SHORTLISTED"],
  RESEARCHING: ["VALIDATED", "CONCEPT", "SHORTLISTED"],
  VALIDATED: ["CONCEPT", "SHORTLISTED"],
  CONCEPT: ["SHORTLISTED"],
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
        ...(input.status ? { status: input.status } : {}),
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
  // this angle — skip instead of generating a near-identical idea. ARCHIVED/
  // REJECTED ideas don't count as "already exists" — a revised or
  // Scenario-K-retried idea for the same lens must still be regeneratable;
  // without this exclusion, one archived idea for a lens permanently blocks
  // that lens from ever getting a fresh attempt regardless of how eligible
  // the parent Opportunity is.
  existsForOpportunityLens(opportunityId: string, lens: CreativeLens) {
    return prisma.idea
      .count({
        where: {
          opportunityId,
          lens,
          status: { notIn: ["ARCHIVED", "REJECTED"] },
        },
      })
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

  // Oldest-first ideas in `status`, up to `perProject` from each of up to
  // `projects` distinct projects (distinct, so a project with an old backlog
  // can't starve the others). The previous one-idea-per-project listing
  // capped every project at ONE idea per tick, which at the production tick cadence (~5 min) meant
  // one council review / director decision per project per tick — and a
  // director idea sitting in its BACKLOG cooldown held that single slot.
  async listByStatusPerProject(
    status: IdeaStatus,
    opts: { projects: number; perProject: number },
  ) {
    const projects = await prisma.idea.findMany({
      where: { status },
      distinct: ["projectId"],
      orderBy: { createdAt: "asc" },
      take: opts.projects,
      select: { projectId: true },
    });
    const perProject = await Promise.all(
      projects.map(({ projectId }) =>
        prisma.idea.findMany({
          where: { status, projectId },
          orderBy: { createdAt: "asc" },
          take: opts.perProject,
          include: { councilEvaluations: true },
        }),
      ),
    );
    return perProject;
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
      throw new AgentelseError(
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

  // The LLM-free path to SHORTLISTED that the Council pass takes for every idea
  // it does not reject (council-engine.ts): RAW -> VALIDATED -> CONCEPT ->
  // SHORTLISTED, each step through the state machine. Idempotent: an idea that
  // is already SHORTLISTED or further along, or REJECTED / ARCHIVED, is left
  // exactly as it is. Returns the idea's status afterwards.
  async promoteToShortlist(
    ideaId: string,
    projectId: string,
  ): Promise<IdeaStatus> {
    const idea = await prisma.idea.findFirst({
      where: { id: ideaId, projectId },
      select: { status: true },
    });
    if (!idea) {
      throw new AgentelseError(
        "NOT_FOUND",
        `Idea ${ideaId} not found in project ${projectId}`,
      );
    }
    const steps = PROMOTION_PATH[idea.status];
    if (!steps) return idea.status;
    for (const to of steps) {
      await IdeaRepository.transition(ideaId, projectId, to);
    }
    return "SHORTLISTED";
  },

  // Moves an idea that was just put on the calendar to MEASURING, every step
  // through transition() so the state machine stays the judge. MEASURING (not
  // ACTIVE) on purpose: countActive excludes it, so scheduled ideas never
  // starve maxActiveIdeas. Idempotent by current status; REJECTED / ARCHIVED
  // throw before any write.
  async advanceForScheduling(
    ideaId: string,
    projectId: string,
  ): Promise<IdeaStatus> {
    const idea = await prisma.idea.findFirst({
      where: { id: ideaId, projectId },
      select: { status: true },
    });
    if (!idea) {
      throw new AgentelseError(
        "NOT_FOUND",
        `Idea ${ideaId} not found in project ${projectId}`,
      );
    }
    if (idea.status === "REJECTED" || idea.status === "ARCHIVED") {
      throw new AgentelseError(
        "INVALID_STATE_TRANSITION",
        `Idea ${ideaId} is ${idea.status} and cannot be scheduled`,
      );
    }
    if (idea.status === "MEASURING" || idea.status === "LEARNED") {
      return idea.status;
    }
    let status: IdeaStatus = idea.status;
    if (SCHEDULING_PRE_SHORTLIST.has(status)) {
      status = await IdeaRepository.promoteToShortlist(ideaId, projectId);
    }
    const start = SCHEDULING_CHAIN.indexOf(status);
    if (start === -1) return status;
    for (const to of SCHEDULING_CHAIN.slice(start + 1)) {
      await IdeaRepository.transition(ideaId, projectId, to);
    }
    return "MEASURING";
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
