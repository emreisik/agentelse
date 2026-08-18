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

// Ölü kuyruktaki bir kaydı elle yeniden kuyruğa alır. Otomatik kurtarmanın
// dokunmadığı (yapılandırma/bakiye sınıfı) kayıtlar için: kullanıcı sorunu
// giderdikten sonra işi tekrar denemek ister.
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
    if (!entry) return { ok: false, message: "Kayıt bulunamadı" };
    if (entry.resolvedAt) return { ok: true };
    if (!entry.executionJobId) {
      // Sistem seviyesi kayıt (worker/cron hatası) — yeniden kuyruğa
      // alınacak bir iş yok, yalnızca kapatılır.
      await prisma.deadLetterJob.update({
        where: { id: entry.id },
        data: { resolvedAt: new Date() },
      });
      revalidatePath("/saglik");
      return { ok: true };
    }

    const job = await prisma.executionJob.findUnique({
      where: { id: entry.executionJobId },
      select: { id: true, workspaceId: true, projectId: true, status: true },
    });
    if (!job || job.workspaceId !== workspaceId) {
      return { ok: false, message: "İş bu çalışma alanına ait değil" };
    }
    if (job.status === "COMPLETED" || job.status === "CANCELLED") {
      return { ok: false, message: `İş zaten ${job.status} durumunda` };
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

    revalidatePath("/saglik");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "İşlem başarısız",
    };
  }
}

// Kaydı yeniden denemeden kapatır — "biliyorum, umursamıyorum".
export async function dismissDeadLetterAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const deadLetterId = String(formData.get("deadLetterId"));
    const { userId } = await requireUser();
    await requireWorkspaceMembership(userId);

    await prisma.deadLetterJob.updateMany({
      where: { id: deadLetterId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });

    revalidatePath("/saglik");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "İşlem başarısız",
    };
  }
}

// Sağlık taramasını ve otomatik kurtarmayı beklemeden çalıştırır.
export async function runHealthScanAction(): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    await requireWorkspaceMembership(userId);

    await SelfHealingService.run();
    await ProviderHealthService.refresh();

    revalidatePath("/saglik");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Tarama başarısız",
    };
  }
}

// Sağlayıcıyı elle "sağlıklı" işaretler: kullanıcı kök nedeni (anahtar,
// bakiye) düzelttiğinde devre kesiciyi beklemeden kapatmak için.
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
    if (!definition) return { ok: false, message: "Sağlayıcı bulunamadı" };

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

    revalidatePath("/saglik");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "İşlem başarısız",
    };
  }
}
