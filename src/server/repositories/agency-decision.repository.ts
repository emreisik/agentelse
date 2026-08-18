import "server-only";

import type {
  AgencyDecisionSubject,
  AgencyDecisionType,
  ApprovalLevel,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type CreateAgencyDecisionInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  subjectType: AgencyDecisionSubject;
  subjectId: string;
  decision: AgencyDecisionType;
  rationale: string;
  scoreBreakdown?: unknown;
  inputsSnapshot?: unknown;
  workPlanId?: string;
  taskIds?: string[];
  approvalLevel?: ApprovalLevel;
  isMock?: boolean;
};

export const AgencyDecisionRepository = {
  create(input: CreateAgencyDecisionInput) {
    return prisma.agencyDecision.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        decision: input.decision,
        rationale: input.rationale,
        scoreBreakdown: input.scoreBreakdown as never,
        inputsSnapshot: input.inputsSnapshot as never,
        workPlanId: input.workPlanId,
        taskIds: input.taskIds ?? [],
        approvalLevel: input.approvalLevel,
        isMock: input.isMock ?? false,
      },
    });
  },

  listForProject(projectId: string, limit = 50) {
    return prisma.agencyDecision.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  listForSubject(subjectType: AgencyDecisionSubject, subjectId: string) {
    return prisma.agencyDecision.findMany({
      where: { subjectType, subjectId },
      orderBy: { createdAt: "desc" },
    });
  },

  findMostRecentForSubject(
    subjectType: AgencyDecisionSubject,
    subjectId: string,
  ) {
    return prisma.agencyDecision.findFirst({
      where: { subjectType, subjectId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
  },
};
