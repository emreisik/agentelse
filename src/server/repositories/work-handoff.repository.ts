import "server-only";

import type { DepartmentKey, WorkHandoffStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateWorkHandoffInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  workPlanId?: string;
  fromDepartment: DepartmentKey;
  toDepartment: DepartmentKey;
  fromTaskId?: string;
  reason: string;
  payload?: unknown;
  decisionId?: string;
  expiresAt?: Date;
};

export const WorkHandoffRepository = {
  create(input: CreateWorkHandoffInput) {
    return prisma.workHandoff.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        workPlanId: input.workPlanId,
        fromDepartment: input.fromDepartment,
        toDepartment: input.toDepartment,
        fromTaskId: input.fromTaskId,
        reason: input.reason,
        payload: input.payload as never,
        decisionId: input.decisionId,
        expiresAt: input.expiresAt,
      },
    });
  },

  findByIdInProject(handoffId: string, projectId: string) {
    return prisma.workHandoff.findFirst({
      where: { id: handoffId, projectId },
    });
  },

  listForProject(
    projectId: string,
    filter?: { status?: WorkHandoffStatus; limit?: number },
  ) {
    return prisma.workHandoff.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 50,
    });
  },

  listByStatus(status: WorkHandoffStatus, limit: number) {
    return prisma.workHandoff.findMany({
      where: { status },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
  },

  async transition(
    handoffId: string,
    projectId: string,
    to: WorkHandoffStatus,
    extra?: { toTaskId?: string; decisionId?: string },
  ) {
    const handoff = await prisma.workHandoff.findFirst({
      where: { id: handoffId, projectId },
    });
    if (!handoff)
      throw new AgentelseError(
        "NOT_FOUND",
        `WorkHandoff ${handoffId} not found in project ${projectId}`,
      );

    StateMachine.assertWorkHandoffTransition(handoff.status, to);

    return prisma.workHandoff.update({
      where: { id: handoffId },
      data: {
        status: to,
        toTaskId: extra?.toTaskId ?? handoff.toTaskId,
        decisionId: extra?.decisionId ?? handoff.decisionId,
      },
    });
  },
};
