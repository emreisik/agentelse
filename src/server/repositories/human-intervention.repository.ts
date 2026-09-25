import "server-only";

import type {
  HumanInterventionInputType,
  HumanInterventionStatus,
  HumanInterventionType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";
import { notifyProjectTelegram } from "@/server/notifications/project-telegram-notifier";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes to respond via the web Human Action Center

// Shared by resolve()/transition() below — best-effort, same reasoning as
// the Telegram notify in create(): a chat-post failure must never break
// the actual state transition, which already committed by the time this
// runs. Not called from expireOverdue()'s batch sweep (a cron tick, not a
// single-row user action) — an expired PENDING card just stays showing
// "pending" until someone tries to act on it and gets a real error from
// the action itself; a known, minor, low-blast-radius gap rather than
// worth a per-row loop in a batch update.
async function resolveHumanActionChatCard(
  taskId: string | null,
  requestId: string,
  status: "RESOLVED" | "CANCELLED" | "EXPIRED",
): Promise<void> {
  try {
    const ideaId = taskId
      ? await IdeaChatRepository.resolveIdeaIdForTask(taskId)
      : null;
    await IdeaChatRepository.resolveHumanActionCard({
      ideaId,
      requestId,
      status,
    });
  } catch (error) {
    console.error(
      "[human-intervention.repository] resolveHumanActionCard failed:",
      error,
    );
  }
}

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
        `🖐️ Human intervention needed: ${input.title}`,
      );
    } catch {
      // Best-effort — a notification failure must never break the intervention request.
    }

    // Single-chat consolidation — previously invisible outside the Human
    // Action Center panel despite being architecturally central. Best-
    // effort, same as the Telegram notify above: a chat-post failure must
    // never break the intervention request itself.
    try {
      const ideaId = input.taskId
        ? await IdeaChatRepository.resolveIdeaIdForTask(input.taskId)
        : null;
      await IdeaChatRepository.postSystemMessage({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ideaId,
        text: `🖐️ ${input.title}${input.message ? ` — ${input.message}` : ""}`,
        card: {
          kind: "human-action-required",
          requestId: request.id,
          title: input.title,
          message: input.message,
          interventionType: input.type,
          inputType: input.inputType,
          status: "PENDING",
        },
      });
    } catch (error) {
      console.error(
        "[human-intervention.repository] postSystemMessage failed:",
        error,
      );
    }

    return request;
  },

  async resolve(id: string, projectId: string, resolvedByUserId: string) {
    const request = await prisma.humanInterventionRequest.findFirst({
      where: { id, projectId },
    });
    if (!request)
      throw new AgentelseError(
        "NOT_FOUND",
        `HumanInterventionRequest ${id} not found in project ${projectId}`,
      );

    StateMachine.assertHumanInterventionTransition(request.status, "RESOLVED");

    const updated = await prisma.humanInterventionRequest.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId },
    });
    await resolveHumanActionChatCard(request.taskId, id, "RESOLVED");
    return updated;
  },

  async transition(id: string, projectId: string, to: HumanInterventionStatus) {
    const request = await prisma.humanInterventionRequest.findFirst({
      where: { id, projectId },
    });
    if (!request)
      throw new AgentelseError(
        "NOT_FOUND",
        `HumanInterventionRequest ${id} not found in project ${projectId}`,
      );

    StateMachine.assertHumanInterventionTransition(request.status, to);

    const updated = await prisma.humanInterventionRequest.update({
      where: { id },
      data: { status: to },
    });
    if (to === "CANCELLED" || to === "EXPIRED") {
      await resolveHumanActionChatCard(request.taskId, id, to);
    }
    return updated;
  },

  expireOverdue() {
    return prisma.humanInterventionRequest.updateMany({
      where: { status: "PENDING", expiresAt: { lt: new Date() } },
      data: { status: "EXPIRED" },
    });
  },
};
