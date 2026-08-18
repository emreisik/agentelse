"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  OUTBOX_EVENT_TYPES,
  OutboxRepository,
} from "@/server/repositories/outbox.repository";
import { SelfHealingService } from "@/server/observability/self-healing.service";
import { ProviderHealthService } from "@/server/observability/provider-health.service";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Manually re-queues a dead-letter entry. For entries auto-recovery doesn't
// touch (configuration/balance class): the user wants to retry the job after
// fixing the issue.
export async function retryDeadLetterAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const deadLetterId = String(formData.get("deadLetterId"));
    const { userId } = await requireUser();
    const { workspaceId } = await requireWorkspaceMembership(userId);

    const entry = await prisma.deadLetterJob.findUnique({
      where: { id: deadLetterId },
    });
    if (!entry) return { ok: false, message: "Record not found" };
    if (entry.resolvedAt) return { ok: true };
    if (!entry.executionJobId) {
      // System-level entry (worker/cron error) — there is no job to
      // re-queue, it is just closed.
      await prisma.deadLetterJob.update({
        where: { id: entry.id },
        data: { resolvedAt: new Date() },
      });
      revalidatePath("/health");
      return { ok: true };
    }

    const job = await prisma.executionJob.findUnique({
      where: { id: entry.executionJobId },
      select: { id: true, workspaceId: true, projectId: true, status: true },
    });
    if (!job || job.workspaceId !== workspaceId) {
      return {
        ok: false,
        message: "The job does not belong to this workspace",
      };
    }
    if (job.status === "COMPLETED" || job.status === "CANCELLED") {
      return {
        ok: false,
        message: `The job is already in ${job.status} status`,
      };
    }

    await prisma.$transaction(async (tx) => {
      await OutboxRepository.enqueue(tx, {
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        aggregateType: "ExecutionJob",
        aggregateId: job.id,
        eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
        payload: entry.payload,
        executionJobId: job.id,
      });
      await tx.deadLetterJob.update({
        where: { id: entry.id },
        data: { resolvedAt: new Date() },
      });
    });

    await AuditLogRepository.record({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      actorType: "USER",
      actorId: userId,
      action: "health.dead_letter_retried",
      entityType: "ExecutionJob",
      entityId: job.id,
      metadata: { deadLetterId: entry.id },
    });

    revalidatePath("/health");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// Closes the entry without retrying — "I know, I don't care".
export async function dismissDeadLetterAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const deadLetterId = String(formData.get("deadLetterId"));
    const { userId } = await requireUser();
    const { workspaceId } = await requireWorkspaceMembership(userId);

    const entry = await prisma.deadLetterJob.findUnique({
      where: { id: deadLetterId },
      select: {
        id: true,
        executionJobId: true,
        executionJob: { select: { workspaceId: true } },
      },
    });
    if (!entry) return { ok: false, message: "Record not found" };
    if (
      entry.executionJobId &&
      entry.executionJob?.workspaceId !== workspaceId
    ) {
      return {
        ok: false,
        message: "The job does not belong to this workspace",
      };
    }

    await prisma.deadLetterJob.updateMany({
      where: { id: deadLetterId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });

    revalidatePath("/health");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// Runs the health scan and auto-recovery without waiting.
export async function runHealthScanAction(): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    await requireWorkspaceMembership(userId);

    await SelfHealingService.run();
    await ProviderHealthService.refresh();

    revalidatePath("/health");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Scan failed",
    };
  }
}

// Manually marks the provider "healthy": lets the user close the circuit
// breaker without waiting once they've fixed the root cause (key, balance).
export async function clearProviderIncidentAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const providerKey = String(formData.get("providerKey"));
    const { userId } = await requireUser();
    await requireWorkspaceMembership(userId);

    const definition = await prisma.providerDefinition.findUnique({
      where: { key: providerKey },
    });
    if (!definition) return { ok: false, message: "Provider not found" };

    await prisma.providerHealth.upsert({
      where: { providerId: definition.id },
      create: {
        providerId: definition.id,
        status: "AVAILABLE",
        lastCheckAt: new Date(),
      },
      update: {
        status: "AVAILABLE",
        lastCheckAt: new Date(),
        lastErrorMessage: null,
      },
    });
    await prisma.providerIncident.updateMany({
      where: { providerId: definition.id, resolved: false },
      data: { resolved: true, resolvedAt: new Date() },
    });

    revalidatePath("/health");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
