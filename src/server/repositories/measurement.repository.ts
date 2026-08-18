import "server-only";

import type { MeasurementCheckStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateMeasurementPlanInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  taskId?: string;
  workPlanId?: string;
  ideaId?: string;
  description: string;
  checks: Array<{ label: string; dueAt: Date }>;
};

export const MeasurementRepository = {
  createPlan(input: CreateMeasurementPlanInput) {
    return prisma.measurementPlan.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        taskId: input.taskId,
        workPlanId: input.workPlanId,
        ideaId: input.ideaId,
        description: input.description,
        checks: {
          create: input.checks.map((check) => ({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            brandId: input.brandId,
            label: check.label,
            dueAt: check.dueAt,
          })),
        },
      },
      include: { checks: true },
    });
  },

  findPlanForTask(taskId: string) {
    return prisma.measurementPlan.findFirst({
      where: { taskId },
      include: { checks: true },
    });
  },

  listDueChecks(limit: number) {
    return prisma.measurementCheck.findMany({
      where: { status: "PENDING", dueAt: { lte: new Date() } },
      take: limit,
      orderBy: { dueAt: "asc" },
      include: { plan: true },
    });
  },

  findCheckByResultTask(resultTaskId: string) {
    return prisma.measurementCheck.findFirst({
      where: { resultTaskId },
      include: { plan: true },
    });
  },

  async transitionCheck(
    checkId: string,
    projectId: string,
    to: MeasurementCheckStatus,
    extra?: { resultTaskId?: string; resultSummary?: unknown },
  ) {
    const check = await prisma.measurementCheck.findFirst({
      where: { id: checkId, projectId },
    });
    if (!check)
      throw new AgentelseError(
        "NOT_FOUND",
        `MeasurementCheck ${checkId} not found in project ${projectId}`,
      );

    StateMachine.assertMeasurementCheckTransition(check.status, to);

    return prisma.measurementCheck.update({
      where: { id: checkId },
      data: {
        status: to,
        resultTaskId: extra?.resultTaskId ?? check.resultTaskId,
        resultSummary:
          extra?.resultSummary === undefined
            ? (check.resultSummary as never)
            : (extra.resultSummary as never),
      },
    });
  },

  // Marks the plan COMPLETED when every check reached a terminal status.
  async completePlanIfDone(planId: string) {
    const checks = await prisma.measurementCheck.findMany({
      where: { planId },
      select: { status: true },
    });
    const done = checks.every((c) =>
      ["COMPLETED", "FAILED", "SKIPPED"].includes(c.status),
    );
    if (!done) return null;
    return prisma.measurementPlan.update({
      where: { id: planId },
      data: { status: "COMPLETED" },
    });
  },

  listCompletedPlansWithoutLearning(limit: number) {
    // Learning extraction marks plans by setting status COMPLETED; the
    // LearningEngine keeps its own processed marker inside resultSummary of
    // the final check, so here we just list recently completed plans.
    return prisma.measurementPlan.findMany({
      where: { status: "COMPLETED" },
      take: limit,
      orderBy: { updatedAt: "desc" },
      include: { checks: true },
    });
  },
};
