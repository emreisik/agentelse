import "server-only";

import type { SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { seoApplyChangeIdOf } from "@/lib/seo/apply/approval-details";
import { SEO_APPLY_INLINE_BUDGET_MS } from "@/lib/seo/apply/lifecycle";
import type { SeoChangeStatus } from "@/lib/seo/apply/types";
import { TaskRepository } from "@/server/repositories/task.repository";

import { applySeoChange } from "./apply";
import { recordSeoApplyAudit } from "./audit";
import { kindOf, statusOf } from "./store";
import type { SeoApplyDeps } from "./types";

// Onay kararı ile SeoChange arasındaki köprü (docs/website-apply.md). İki giriş
// vardır: onaylı Task'ı dispatchApprovedTask yakalar (onSeoApplyTaskApproved);
// diğer her yol (sohbet kararı, panel, tick) syncSeoChangeApprovalState ile
// değişikliği Approval satırına göre hizalar. Task metni sabittir; başarısızlık
// nedeni de sabit metindir (WordPress'ten gelen hiçbir metin taşınmaz).

const TASK_REASON = {
  rejected: "The WordPress change was rejected",
  expired: "The WordPress change expired",
  gone: "The WordPress change no longer exists",
} as const;

function auditCtx(change: SeoChange, userId?: string | null) {
  return {
    workspaceId: change.workspaceId,
    projectId: change.projectId,
    userId,
  };
}

async function cancelTask(
  change: Pick<SeoChange, "taskId" | "projectId">,
  reason: string,
): Promise<void> {
  if (!change.taskId) return;
  // Task zaten başka durumdaysa geçiş geçersizdir; sessizce geçilir.
  await TaskRepository.transition(change.taskId, change.projectId, "CANCELLED", {
    failureReason: reason,
  }).catch(() => undefined);
}

async function currentStatus(
  changeId: string,
  fallback: SeoChangeStatus,
): Promise<SeoChangeStatus> {
  const row = await prisma.seoChange.findUnique({
    where: { id: changeId },
    select: { status: true },
  });
  return row ? statusOf(row) : fallback;
}

// Satırı PROPOSED durumundan CAS ile kapatır; yarışı kaybedersek güncel
// durumu okuyup döndürür.
async function closeProposed(
  change: SeoChange,
  to: "REJECTED" | "EXPIRED",
): Promise<SeoChangeStatus> {
  const result = await prisma.seoChange.updateMany({
    where: { id: change.id, status: "PROPOSED" },
    data: { status: to, openKey: null },
  });
  if (result.count === 0) return currentStatus(change.id, to);

  await cancelTask(
    change,
    to === "REJECTED" ? TASK_REASON.rejected : TASK_REASON.expired,
  );
  await recordSeoApplyAudit(
    to === "REJECTED" ? "seo_change.rejected" : "seo_change.expired",
    { changeId: change.id, kind: kindOf(change) },
    auditCtx(change),
  );
  return to;
}

async function approveChange(
  change: SeoChange,
  reviewedByUserId: string | null,
  now: Date,
): Promise<{ status: SeoChangeStatus; won: boolean }> {
  const result = await prisma.seoChange.updateMany({
    where: { id: change.id, status: "PROPOSED" },
    data: {
      status: "APPROVED",
      approvedByUserId: reviewedByUserId,
      approvedAt: now,
    },
  });
  if (result.count === 0) {
    return { status: await currentStatus(change.id, "APPROVED"), won: false };
  }
  await recordSeoApplyAudit(
    "seo_change.approved",
    { changeId: change.id, kind: kindOf(change) },
    auditCtx(change, reviewedByUserId),
  );
  return { status: "APPROVED", won: true };
}

// Satırı Approval satırına GÖRE hizalar (okuyarak; kimin kapattığına bakmaz).
// Idempotenttir: PROPOSED dışındaki her durum olduğu gibi döner. APPROVED'a
// geçişi ilk yapan çağrı `won` ile bildirilir.
async function align(
  changeId: string,
  now: Date,
): Promise<{ status: SeoChangeStatus; won: boolean; change: SeoChange } | null> {
  const change = await prisma.seoChange.findUnique({ where: { id: changeId } });
  if (!change) return null;
  const status = statusOf(change);
  if (status !== "PROPOSED") return { status, won: false, change };
  if (!change.approvalId) return { status, won: false, change };

  const approval = await prisma.approval.findUnique({
    where: { id: change.approvalId },
    select: { status: true, reviewedByUserId: true, expiresAt: true },
  });
  // Onay satırı yoksa (silinmiş) süresi dolmuş sayılır.
  if (!approval) {
    return { status: await closeProposed(change, "EXPIRED"), won: false, change };
  }

  switch (approval.status) {
    case "APPROVED": {
      const approved = await approveChange(change, approval.reviewedByUserId, now);
      return { ...approved, change };
    }
    case "REJECTED":
    case "REVISION_REQUESTED":
      return { status: await closeProposed(change, "REJECTED"), won: false, change };
    case "CANCELLED":
    case "EXPIRED":
      return { status: await closeProposed(change, "EXPIRED"), won: false, change };
    default:
      // Süresi geçmiş ama henüz EXPIRED'a çekilmemiş bekleyen onay.
      if (approval.expiresAt && approval.expiresAt <= now) {
        await prisma.approval
          .updateMany({
            where: { id: change.approvalId, status: "PENDING" },
            data: { status: "EXPIRED" },
          })
          .catch(() => undefined);
        return {
          status: await closeProposed(change, "EXPIRED"),
          won: false,
          change,
        };
      }
      return { status, won: false, change };
  }
}

function timeout(ms: number): { promise: Promise<"timeout">; clear: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, clear: () => clearTimeout(handle) };
}

// Uygulamayı başlatır ve SEO_APPLY_INLINE_BUDGET_MS kadar bekler; süre dolsa da
// uygulama arka planda sürer, hata yutulur (kullanıcıya panelden ve tick
// güvenlik ağından döner).
async function applyInline(changeId: string, deps: SeoApplyDeps): Promise<void> {
  const applying = applySeoChange(changeId, deps).catch((error: unknown) => {
    console.error(
      "[seo-apply] apply failed after approval:",
      error instanceof Error ? error.name : "unknown",
    );
  });
  const budget = timeout(SEO_APPLY_INLINE_BUDGET_MS);
  try {
    await Promise.race([applying, budget.promise]);
  } finally {
    budget.clear();
  }
}

// Değişikliği Approval satırına göre hizalar; onaylıysa uygulamayı başlatır.
export async function syncSeoChangeApprovalState(
  changeId: string,
  deps: SeoApplyDeps = {},
): Promise<SeoChangeStatus | null> {
  const aligned = await align(changeId, deps.now ?? new Date());
  if (!aligned) return null;
  if (aligned.won) await applyInline(changeId, deps);
  return aligned.won ? currentStatus(changeId, aligned.status) : aligned.status;
}

// Onaylanan WEBSITE_UPDATE (seoApply işaretli) görevi için çağrılır
// (TaskPlanner.dispatchApprovedTask). Asla fırlatmaz: onay zaten verilmiştir.
export async function onSeoApplyTaskApproved(
  task: { id: string; projectId: string; workspaceId: string },
  deps: SeoApplyDeps = {},
): Promise<void> {
  try {
    const row = await prisma.task.findFirst({
      where: { id: task.id, projectId: task.projectId },
      select: { payload: true },
    });
    const changeId = seoApplyChangeIdOf(row?.payload);
    const found = changeId
      ? await prisma.seoChange.findUnique({
          where: { id: changeId },
          select: { id: true, projectId: true, taskId: true },
        })
      : null;
    // Kiracı bağı: değişiklik bu görevin projesine ve görevine ait olmalı
    // (taskId öneri anında görevden sonra yazılır, o ana kadar boş olabilir).
    const change =
      found &&
      found.projectId === task.projectId &&
      (found.taskId === null || found.taskId === task.id)
        ? found
        : null;
    if (!change) {
      await TaskRepository.transition(task.id, task.projectId, "CANCELLED", {
        failureReason: TASK_REASON.gone,
      }).catch(() => undefined);
      return;
    }

    const aligned = await align(change.id, deps.now ?? new Date());
    // Onay hizalanamadıysa (reddedildi, süresi doldu) Task'a dokunulmaz; align
    // zaten kapattı ya da kapatacak.
    if (
      !aligned ||
      (aligned.status !== "APPROVED" &&
        aligned.status !== "APPLYING" &&
        aligned.status !== "APPLIED")
    ) {
      return;
    }

    // Geçersiz geçişler (görev zaten çalışıyor) yutulur.
    await TaskRepository.transition(task.id, task.projectId, "QUEUED").catch(
      () => undefined,
    );
    await TaskRepository.transition(task.id, task.projectId, "RUNNING").catch(
      () => undefined,
    );

    await applyInline(change.id, deps);
  } catch (error) {
    console.error(
      "[seo-apply] approval hook failed:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
