import "server-only";

import type { SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  applyMockMode,
  seoApplyEnabled,
  seoApplyGlobalWorkAllowedHere,
  seoApplyRestrictedProjects,
} from "@/lib/seo/apply/flags";
import { SEO_APPLY_APPROVED_STALE_MS } from "@/lib/seo/apply/lifecycle";
import type { SeoChangeKind } from "@/lib/seo/apply/types";
import { Heartbeat } from "@/server/observability/heartbeat";
import { TaskRepository } from "@/server/repositories/task.repository";

import { applySeoChange } from "./apply";
import { syncSeoChangeApprovalState } from "./approval-hook";
import { recordSeoApplyAudit } from "./audit";
import { SeoIndexNow } from "./indexnow";
import { SeoApplyRetention } from "./retention";

// SC-F8 uzlaştırma (docs/website-apply.md): `seo-apply` tick adımı. Her turda
// toplam en çok `limit` satır işlenir. Sıra (ENGINE TRANSITIONS tablosu):
//  1. PROPOSED: karar Approval SATIRI okunarak değişikliğe yansır (reddedildi/
//     iptal/süresi doldu -> kapanır, onaylandı -> onayla ve uygula). Onay
//     satırı yoksa ve öneri expiresAt'i geçtiyse EXPIRED.
//  2. Kirası dolmuş APPLYING: yazma dönmemişse APPROVED, döndüyse APPLIED.
//  3. Kirası dolmuş UNDOING: VERIFIED (verifiedAt doluysa) ya da FAILED.
//  4. 14 gündür uygulanmamış APPROVED: EXPIRED.
//  5. Vadesi gelmiş APPROVED, sonra kiradan düşmüş APPLIED: uygula/devam et.
//  6. IndexNow bildirimleri ve günlük saklama temizliği (yalnız canlıda).
// Bayrak kapalıyken hiçbir sorgu yok. Yerel geliştirme süreci canlı
// veritabanını paylaşırken yalnız SEO_DEV_PROJECTS'teki projeler işlenir (aday
// sorgularına izin listesi WHERE ile girer: izin dışı satırlar LIMIT'in
// başında durup izinli satırları aç bırakmasın) ve genel işler (nabız,
// IndexNow gönderimi, saklama) hiç çalışmaz.

const CANDIDATES = 100;
const HEARTBEAT_KEY = "seo.apply";
const TERMINAL_TASK_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

type Budget = { left: number; done: number };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function take(budget: Budget): void {
  budget.left -= 1;
  budget.done += 1;
}

function projectScope(allowList: string[] | null): {
  projectId?: { in: string[] };
} {
  return allowList ? { projectId: { in: allowList } } : {};
}

// Kapanan değişikliğin Task'ı da kapanır (Task metni Disconnect'te silinir;
// burada yalnız durum). Hata uzlaştırmayı durdurmaz.
async function cancelTask(
  taskId: string | null,
  projectId: string,
  reason: string,
): Promise<void> {
  if (!taskId) return;
  try {
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId },
      select: { status: true },
    });
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return;
    await TaskRepository.transition(taskId, projectId, "CANCELLED", {
      failureReason: reason,
    });
  } catch (error) {
    console.error(
      `[seo-apply] task could not be cancelled: ${errorName(error)}`,
    );
  }
}

async function auditExpired(change: SeoChange): Promise<void> {
  await recordSeoApplyAudit(
    "seo_change.expired",
    { changeId: change.id, kind: change.kind as SeoChangeKind },
    { workspaceId: change.workspaceId, projectId: change.projectId },
  );
}

// Onay satırı olmayan, süresi dolan öneri (onay oluşturma yarım kalmış):
// satır ve Task kapanır. Onay satırı olan öneriler syncSeoChangeApprovalState'e gider.
async function expireOrphanProposal(change: SeoChange): Promise<void> {
  const closed = await prisma.seoChange.updateMany({
    where: { id: change.id, status: "PROPOSED" },
    data: { status: "EXPIRED", openKey: null },
  });
  if (closed.count !== 1) return;
  await cancelTask(change.taskId, change.projectId, "Approval expired");
  await auditExpired(change);
}

// Onaylı ama 14 gündür uygulanmamış: kapanır (onay satırı APPROVED kalır).
async function expireStaleApproved(change: SeoChange): Promise<void> {
  const closed = await prisma.seoChange.updateMany({
    where: { id: change.id, status: "APPROVED" },
    data: {
      status: "EXPIRED",
      openKey: null,
      leaseUntil: null,
      leaseOwner: null,
    },
  });
  if (closed.count !== 1) return;
  await cancelTask(change.taskId, change.projectId, "Change was not applied");
  await auditExpired(change);
}

// Kural 1: onay satırının durumu değişikliğe yansır.
async function reconcileProposed(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const rows = await prisma.seoChange.findMany({
    where: { status: "PROPOSED", ...projectScope(allowList) },
    orderBy: { createdAt: "asc" },
    take: CANDIDATES,
  });
  if (rows.length === 0) return;
  const approvalIds = rows
    .map((row) => row.approvalId)
    .filter((id): id is string => id !== null);
  const approvals =
    approvalIds.length > 0
      ? await prisma.approval.findMany({
          where: { id: { in: approvalIds } },
          select: { id: true, status: true },
        })
      : [];
  const statusById = new Map(approvals.map((row) => [row.id, row.status]));

  for (const row of rows) {
    if (budget.left <= 0) break;
    const approval = row.approvalId
      ? statusById.get(row.approvalId)
      : undefined;
    const overdue = row.expiresAt.getTime() <= now.getTime();
    try {
      if (!row.approvalId) {
        // Onay satırı hiç oluşmamış (yarım kalmış öneri): yalnız süre dolunca kapanır.
        if (overdue) {
          take(budget);
          await expireOrphanProposal(row);
        }
        continue;
      }
      // Karar başka yoldan (sohbet, kancayı atlayan yol) verilmiş, onay satırı
      // silinmiş ya da onay PENDING iken süresi geçmiş: tek tablo
      // syncSeoChangeApprovalState'te. Onaylandıysa o fonksiyon onaylar ve uygular.
      if (approval === undefined || approval !== "PENDING" || overdue) {
        take(budget);
        await syncSeoChangeApprovalState(row.id, { now });
      }
    } catch (error) {
      console.error(
        `[seo-apply] proposal could not be reconciled: ${errorName(error)}`,
      );
    }
  }
}

// Kural 2: kirası dolmuş APPLYING. Yazma dönmemişse APPROVED (yeniden
// planlanır; create'in yazısı indiyse sonraki deneme taslağı sahiplenir),
// döndüyse APPLIED (kaldığı yerden devam / geri okuma; ikinci yazma planı
// planChange'den geçer).
async function reconcileApplying(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const rows = await prisma.seoChange.findMany({
    where: {
      status: "APPLYING",
      leaseUntil: { lt: now },
      ...projectScope(allowList),
    },
    select: { id: true, appliedAt: true },
    orderBy: { updatedAt: "asc" },
    take: budget.left,
  });
  if (rows.length === 0) return;
  const unwritten = rows.filter((row) => row.appliedAt === null);
  const written = rows.filter((row) => row.appliedAt !== null);
  const release = { leaseUntil: null, leaseOwner: null };
  if (unwritten.length > 0) {
    await prisma.seoChange.updateMany({
      where: {
        id: { in: unwritten.map((row) => row.id) },
        status: "APPLYING",
        leaseUntil: { lt: now },
        appliedAt: null,
      },
      data: { status: "APPROVED", ...release },
    });
  }
  if (written.length > 0) {
    await prisma.seoChange.updateMany({
      where: {
        id: { in: written.map((row) => row.id) },
        status: "APPLYING",
        leaseUntil: { lt: now },
        appliedAt: { not: null },
      },
      data: { status: "APPLIED", ...release },
    });
  }
  for (let index = 0; index < rows.length; index += 1) take(budget);
}

// Kural 3: kirası dolmuş geri alma geldiği duruma döner. verifiedAt doluysa
// VERIFIED, değilse (yazısı inmiş FAILED satırdı) FAILED.
async function reconcileUndoing(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const rows = await prisma.seoChange.findMany({
    where: {
      status: "UNDOING",
      leaseUntil: { lt: now },
      ...projectScope(allowList),
    },
    select: { id: true, verifiedAt: true },
    orderBy: { updatedAt: "asc" },
    take: budget.left,
  });
  if (rows.length === 0) return;
  const release = { leaseUntil: null, leaseOwner: null };
  const verified = rows.filter((row) => row.verifiedAt !== null);
  const failed = rows.filter((row) => row.verifiedAt === null);
  if (verified.length > 0) {
    await prisma.seoChange.updateMany({
      where: {
        id: { in: verified.map((row) => row.id) },
        status: "UNDOING",
        leaseUntil: { lt: now },
      },
      data: { status: "VERIFIED", ...release },
    });
  }
  if (failed.length > 0) {
    await prisma.seoChange.updateMany({
      where: {
        id: { in: failed.map((row) => row.id) },
        status: "UNDOING",
        leaseUntil: { lt: now },
      },
      data: { status: "FAILED", ...release },
    });
  }
  for (let index = 0; index < rows.length; index += 1) take(budget);
}

// Kural 4: uygulanmamış eski onay.
async function reconcileStale(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const cutoff = new Date(now.getTime() - SEO_APPLY_APPROVED_STALE_MS);
  const rows = await prisma.seoChange.findMany({
    where: {
      status: "APPROVED",
      approvedAt: { lt: cutoff },
      ...projectScope(allowList),
    },
    orderBy: { approvedAt: "asc" },
    take: budget.left,
  });
  for (const row of rows) {
    if (budget.left <= 0) break;
    try {
      take(budget);
      await expireStaleApproved(row);
    } catch (error) {
      console.error(
        `[seo-apply] stale approval could not be closed: ${errorName(error)}`,
      );
    }
  }
}

// Kural 5: uygulanacak (APPROVED) ve kaldığı yerden sürecek (APPLIED) satırlar.
// Süreç kipine uymayan satırlar (mock süreç gerçek satıra) aday olmaz: apply
// onları "skipped" döndürür ve her turda aynı satırlar LIMIT'i yerdi.
async function applyDue(
  status: "APPROVED" | "APPLIED",
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const stale =
    status === "APPROVED"
      ? {
          approvedAt: {
            gte: new Date(now.getTime() - SEO_APPLY_APPROVED_STALE_MS),
          },
        }
      : {};
  const rows = await prisma.seoChange.findMany({
    where: {
      status,
      isMock: applyMockMode(),
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
      ...stale,
      ...projectScope(allowList),
    },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: budget.left,
  });
  for (const row of rows) {
    if (budget.left <= 0) break;
    take(budget);
    try {
      await applySeoChange(row.id, { now });
    } catch (error) {
      console.error(
        `[seo-apply] change could not be applied: ${errorName(error)}`,
      );
    }
  }
}

export async function runSeoApplyDue(
  limit = 5,
  now: Date = new Date(),
): Promise<number> {
  // Bayrak kapalıyken tek bir sorgu bile yok.
  if (!seoApplyEnabled()) return 0;
  const globalWork = seoApplyGlobalWorkAllowedHere();
  if (globalWork) await Heartbeat.beat(HEARTBEAT_KEY, now);

  const allowList = seoApplyRestrictedProjects();
  const budget: Budget = { left: limit, done: 0 };
  const steps = [
    () => reconcileProposed(budget, now, allowList),
    () => reconcileApplying(budget, now, allowList),
    () => reconcileUndoing(budget, now, allowList),
    () => reconcileStale(budget, now, allowList),
    () => applyDue("APPROVED", budget, now, allowList),
    () => applyDue("APPLIED", budget, now, allowList),
  ];
  for (const step of steps) {
    if (budget.left <= 0) break;
    try {
      await step();
    } catch (error) {
      console.error(`[seo-apply] reconcile step failed: ${errorName(error)}`);
    }
  }

  // Genel işler: canlı veritabanını paylaşan yerel süreçte asla çalışmaz
  // (izin listesi dışı müşterilerin değişiklikleri bildirilmez, silinmez).
  if (globalWork) {
    try {
      await SeoIndexNow.flushDue(now);
    } catch (error) {
      console.error(`[seo-apply] indexnow flush failed: ${errorName(error)}`);
    }
    try {
      await SeoApplyRetention.runDue(now);
    } catch (error) {
      console.error(`[seo-apply] retention failed: ${errorName(error)}`);
    }
    await Heartbeat.ok(HEARTBEAT_KEY, now);
  }
  return budget.done;
}
