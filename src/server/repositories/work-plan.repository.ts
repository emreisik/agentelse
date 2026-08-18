import "server-only";

import type { WorkPlanStatus, WorkPlanType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateWorkPlanInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  ideaId?: string;
  opportunityId?: string;
  decisionId?: string;
  title: string;
  planType: WorkPlanType;
  goalIds?: string[];
  graph: unknown;
  isMock?: boolean;
};

export const WorkPlanRepository = {
  create(input: CreateWorkPlanInput) {
    return prisma.workPlan.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        ideaId: input.ideaId,
        opportunityId: input.opportunityId,
        decisionId: input.decisionId,
        title: input.title,
        planType: input.planType,
        goalIds: input.goalIds ?? [],
        graph: input.graph as never,
        isMock: input.isMock ?? false,
      },
    });
  },

  findByIdInProject(workPlanId: string, projectId: string) {
    return prisma.workPlan.findFirst({
      where: { id: workPlanId, projectId },
      include: { tasks: true },
    });
  },

  listForProject(
    projectId: string,
    filter?: { status?: WorkPlanStatus; limit?: number },
  ) {
    return prisma.workPlan.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 50,
      include: { tasks: { select: { id: true, status: true } } },
    });
  },

  listInProgress(limit: number) {
    return prisma.workPlan.findMany({
      where: { status: "IN_PROGRESS" },
      take: limit,
      orderBy: { updatedAt: "asc" },
      include: { tasks: true },
    });
  },

  async transition(workPlanId: string, projectId: string, to: WorkPlanStatus) {
    const plan = await prisma.workPlan.findFirst({
      where: { id: workPlanId, projectId },
    });
    if (!plan)
      throw new HubConnectError(
        "NOT_FOUND",
        `WorkPlan ${workPlanId} not found in project ${projectId}`,
      );

    StateMachine.assertWorkPlanTransition(plan.status, to);

    return prisma.workPlan.update({
      where: { id: workPlanId },
      data: { status: to },
    });
  },
};
