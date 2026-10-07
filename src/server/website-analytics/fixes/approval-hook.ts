import "server-only";

import type { GaConfigChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { GA_FIX_INLINE_BUDGET_MS } from "@/lib/website-analytics/fixes/lifecycle";
import type {
  GaFixKind,
  GaFixStatus,
} from "@/lib/website-analytics/fixes/types";
import { TaskRepository } from "@/server/repositories/task.repository";

import { applyGaConfigChange } from "./apply";
import { recordGaFixAudit } from "./audit";
import type { GaFixDeps } from "./types";

// Onay kararı ile GaConfigChange arasındaki köprü (docs/website-fixes.md).
// İki giriş vardır: onaylı Task'ı dispatchApprovedTask yakalar (onGaTaskApproved),
// diğer her yol (sohbet kararı, panel, tick) syncGaFixApprovalState ile
// değişikliği Approval satırına göre hizalar.

function asStatus(value: string): GaFixStatus {
  return value as GaFixStatus;
}

function auditCtx(change: GaConfigChange, userId?: string | null) {
  return {
    workspaceId: change.workspaceId,
    projectId: change.projectId,
    userId,
  };
}

async function cancelTask(
  change: Pick<GaConfigChange, "taskId" | "projectId">,
  reason: string,
): Promise<void> {
  if (!change.taskId) return;
  // Task zaten başka durumdaysa geçiş geçersizdir; sessizce geçilir.
  await TaskRepository.transition(change.taskId, change.projectId, "CANCELLED", {
    failureReason: reason,
  }).catch(() => undefined);
}

// Satırı PROPOSED durumundan CAS ile kapatır; kapanış yarışını kaybedersek
// güncel durumu okuyup döndürür.
async function closeProposed(
  change: GaConfigChange,
  to: "REJECTED" | "EXPIRED",
): Promise<GaFixStatus> {
  const result = await prisma.gaConfigChange.updateMany({
    where: { id: change.id, status: "PROPOSED" },
    data: { status: to, openKey: null },
  });
  if (result.count === 0) return currentStatus(change.id, to);

  await cancelTask(
    change,
    to === "REJECTED"
      ? "Google Analytics change was rejected"
      : "Google Analytics change expired",
  );
  await recordGaFixAudit(
    to === "REJECTED" ? "ga_config_change.rejected" : "ga_config_change.expired",
    { changeId: change.id, kind: change.kind as GaFixKind },
    auditCtx(change),
  );
  return to;
}

async function currentStatus(
  changeId: string,
  fallback: GaFixStatus,
): Promise<GaFixStatus> {
  const row = await prisma.gaConfigChange.findUnique({
    where: { id: changeId },
    select: { status: true },
  });
  return row ? asStatus(row.status) : fallback;
}

// Değişikliği Approval satırına göre hizalar. Idempotenttir: PROPOSED dışındaki
// her durum olduğu gibi döner. Onay süresi (Approval.expiresAt) burada
// aranmaz; karar anında ApprovalRepository.decide zaten denetler.
export async function syncGaFixApprovalState(
  changeId: string,
  deps: GaFixDeps = {},
): Promise<GaFixStatus | null> {
  const now = deps.now ?? new Date();
  const change = await prisma.gaConfigChange.findUnique({
    where: { id: changeId },
  });
  if (!change) return null;
  if (change.status !== "PROPOSED") return asStatus(change.status);
  if (!change.approvalId) return "PROPOSED";

  const approval = await prisma.approval.findUnique({
    where: { id: change.approvalId },
    select: { status: true, reviewedByUserId: true },
  });
  // Onay satırı yoksa (silinmiş) süresi dolmuş sayılır.
  if (!approval) return closeProposed(change, "EXPIRED");

  switch (approval.status) {
    case "APPROVED": {
      const result = await prisma.gaConfigChange.updateMany({
        where: { id: change.id, status: "PROPOSED" },
        data: {
          status: "APPROVED",
          approvedByUserId: approval.reviewedByUserId,
          approvedAt: now,
        },
      });
      if (result.count === 0) return currentStatus(change.id, "APPROVED");
      await recordGaFixAudit(
        "ga_config_change.approved",
        { changeId: change.id, kind: change.kind as GaFixKind },
        auditCtx(change, approval.reviewedByUserId),
      );
      return "APPROVED";
    }
    case "REJECTED":
    case "REVISION_REQUESTED":
      return closeProposed(change, "REJECTED");
    case "CANCELLED":
    case "EXPIRED":
      return closeProposed(change, "EXPIRED");
    default:
      return "PROPOSED";
  }
}

function timeout(ms: number): { promise: Promise<"timeout">; clear: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, clear: () => clearTimeout(handle) };
}

// Onaylanan ANALYTICS_EDIT görevi için çağrılır (TaskPlanner.dispatchApprovedTask).
// Asla fırlatmaz: onay zaten verilmiştir, uygulama hatası kullanıcıya panelden
// ve tick güvenlik ağından döner. Uygulama GA_FIX_INLINE_BUDGET_MS kadar
// beklenir; süre dolsa da arka planda sürer.
export async function onGaTaskApproved(
  task: { id: string; projectId: string; workspaceId: string },
  deps: GaFixDeps = {},
): Promise<void> {
  try {
    const change = await prisma.gaConfigChange.findFirst({
      where: { taskId: task.id },
      select: { id: true },
    });
    if (!change) {
      await TaskRepository.transition(task.id, task.projectId, "CANCELLED", {
        failureReason: "Google Analytics change no longer exists",
      }).catch(() => undefined);
      return;
    }

    const status = await syncGaFixApprovalState(change.id, deps);
    // Onay hizalanamadıysa (reddedildi, süresi doldu) Task'a dokunulmaz;
    // sync zaten kapattı ya da kapatacak.
    if (status !== "APPROVED" && status !== "APPLYING" && status !== "APPLIED") {
      return;
    }

    // Geçersiz geçişler (görev zaten çalışıyor) yutulur.
    await TaskRepository.transition(task.id, task.projectId, "QUEUED").catch(
      () => undefined,
    );
    await TaskRepository.transition(task.id, task.projectId, "RUNNING").catch(
      () => undefined,
    );

    const applying = applyGaConfigChange(change.id, deps).catch(
      (error: unknown) => {
        console.error(
          "[ga-fixes] apply failed after approval:",
          error instanceof Error ? error.name : "unknown",
        );
      },
    );
    const budget = timeout(GA_FIX_INLINE_BUDGET_MS);
    try {
      await Promise.race([applying, budget.promise]);
    } finally {
      budget.clear();
    }
  } catch (error) {
    console.error(
      "[ga-fixes] approval hook failed:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
