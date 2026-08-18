import "server-only";

import type { ActorType, ProjectGoalStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateGoalInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  title: string;
  description?: string;
  metricKey?: string;
  targetValue?: number;
  priority?: number;
  sourceInsightIds?: string[];
  isMock?: boolean;
};

export const ProjectGoalRepository = {
  createMany(inputs: CreateGoalInput[]) {
    return prisma.projectGoal.createManyAndReturn({
      data: inputs.map((input) => ({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        title: input.title,
        description: input.description,
        metricKey: input.metricKey,
        targetValue: input.targetValue,
        priority: input.priority ?? 3,
        sourceInsightIds: input.sourceInsightIds ?? [],
        isMock: input.isMock ?? false,
      })),
    });
  },

  findByIdInProject(goalId: string, projectId: string) {
    return prisma.projectGoal.findFirst({ where: { id: goalId, projectId } });
  },

  listForProject(projectId: string, filter?: { status?: ProjectGoalStatus }) {
    return prisma.projectGoal.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { priority: "asc" },
    });
  },

  listActiveOrApproved(projectId: string) {
    return prisma.projectGoal.findMany({
      where: { projectId, status: { in: ["APPROVED", "ACTIVE"] } },
      orderBy: { priority: "asc" },
    });
  },

  async transition(
    goalId: string,
    projectId: string,
    to: ProjectGoalStatus,
    extra?: { approvedByType?: ActorType; approvedByUserId?: string },
  ) {
    const goal = await prisma.projectGoal.findFirst({
      where: { id: goalId, projectId },
    });
    if (!goal)
      throw new HubConnectError(
        "NOT_FOUND",
        `ProjectGoal ${goalId} not found in project ${projectId}`,
      );

    StateMachine.assertProjectGoalTransition(goal.status, to);

    return prisma.projectGoal.update({
      where: { id: goalId },
      data: {
        status: to,
        approvedByType:
          to === "APPROVED"
            ? (extra?.approvedByType ?? goal.approvedByType)
            : goal.approvedByType,
        approvedByUserId:
          to === "APPROVED"
            ? (extra?.approvedByUserId ?? goal.approvedByUserId)
            : goal.approvedByUserId,
      },
    });
  },
};
