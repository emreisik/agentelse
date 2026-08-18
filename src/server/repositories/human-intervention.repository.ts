import "server-only";

import type {
  HumanInterventionInputType,
  HumanInterventionStatus,
  HumanInterventionType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";
import { notifyProjectTelegram } from "@/server/notifications/project-telegram-notifier";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes to respond via the web Human Action Center

export const HumanInterventionRepository = {
  listPendingForProject(projectId: string) {
    return prisma.humanInterventionRequest.findMany({
      where: { projectId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
  },

  listPendingForWorkspace(workspaceId: string) {
    return prisma.humanInterventionRequest.findMany({
      where: { workspaceId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
  },

  findByIdInProject(id: string, projectId: string) {
    return prisma.humanInterventionRequest.findFirst({
      where: { id, projectId },
    });
  },

  async create(input: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    taskId?: string;
    executionJobId?: string;
    browserProfileId?: string;
    type: HumanInterventionType;
    inputType: HumanInterventionInputType;
    title: string;
    message?: string;
    ttlMs?: number;
  }) {
    const request = await prisma.humanInterventionRequest.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        taskId: input.taskId,
        executionJobId: input.executionJobId,
        browserProfileId: input.browserProfileId,
        type: input.type,
        inputType: input.inputType,
        title: input.title,
        message: input.message,
        status: "PENDING",
        expiresAt: new Date(Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      },
    });

    try {
      await notifyProjectTelegram(
        input.projectId,
        `🖐️ İnsan müdahalesi gerekiyor: ${input.title}`,
      );
    } catch {
      // Best-effort — bildirim hatası müdahale talebini asla bozmamalı.
    }

    return request;
  },

  async resolve(id: string, projectId: string, resolvedByUserId: string) {
    const request = await prisma.humanInterventionRequest.findFirst({
      where: { id, projectId },
    });
    if (!request)
      throw new HubConnectError(
        "NOT_FOUND",
        `HumanInterventionRequest ${id} not found in project ${projectId}`,
      );

    StateMachine.assertHumanInterventionTransition(request.status, "RESOLVED");

    return prisma.humanInterventionRequest.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId },
    });
  },

  async transition(id: string, projectId: string, to: HumanInterventionStatus) {
    const request = await prisma.humanInterventionRequest.findFirst({
      where: { id, projectId },
    });
    if (!request)
      throw new HubConnectError(
        "NOT_FOUND",
        `HumanInterventionRequest ${id} not found in project ${projectId}`,
      );

    StateMachine.assertHumanInterventionTransition(request.status, to);

    return prisma.humanInterventionRequest.update({
      where: { id },
      data: { status: to },
    });
  },

  expireOverdue() {
    return prisma.humanInterventionRequest.updateMany({
      where: { status: "PENDING", expiresAt: { lt: new Date() } },
      data: { status: "EXPIRED" },
    });
  },
};
