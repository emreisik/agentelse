import "server-only";

import type { GaConfigChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  gaGlobalWorkAllowedHere,
  gaSyncAllowedFor,
} from "@/lib/website-analytics/flags";
import {
  gaFixesEnabled,
  gaFixKindEnabled,
  gaSyncProjectAllowList,
} from "@/lib/website-analytics/fixes/flags";
import { GA_FIX_APPROVED_STALE_MS } from "@/lib/website-analytics/fixes/lifecycle";
import {
  GA_FIX_KINDS,
  type GaFixKind,
} from "@/lib/website-analytics/fixes/types";
import { Heartbeat } from "@/server/observability/heartbeat";
import { claimPeriodic } from "@/server/observability/periodic";
import { TaskRepository } from "@/server/repositories/task.repository";

import { applyGaConfigChange } from "./apply";
import { syncGaFixApprovalState } from "./approval-hook";
import { recordGaFixAudit } from "./audit";

// GA-F7 uzlaştırma (docs/website-fixes.md): `ga-fixes` tick adımı. Her turda
// toplam en çok `limit` satır işlenir. Sıra (MOTOR GEÇİŞLERİ tablosu,
// lifecycle.ts):
//  1-3. PROPOSED: onay kararı satıra yansır (reddedildi/iptal/süresi doldu ->
//       kapanır, onaylandı -> onayla ve uygula); karar yoksa ve öneri
//       expiresAt'i geçtiyse EXPIRED.
//  5.   Kirası dolmuş APPLYING: yazma dönmemişse APPROVED, döndüyse APPLIED.
//  7.   Kirası dolmuş UNDOING: VERIFIED.
//  8.   14 gündür uygulanmamış APPROVED: EXPIRED.
//  4.   Vadesi gelmiş APPROVED: uygula.
//  6.   Boş kiralı APPLIED: yalnız geri okuma.
//  9.   Günlük temizlik (yalnız canlıda): 24 aydan eski kapanmış satırlar silinir.
// Bayrak kapalıyken hiçbir sorgu yok. Yerel geliştirme süreci canlı
// veritabanını paylaşırken yalnız GA_SYNC_DEV_PROJECTS'teki projeler işlenir
// (aday sorgusuna da izin listesi girer: izin dışı satırlar LIMIT'in başında
// durup izinli satırları aç bırakmasın).

const CANDIDATES = 100;
const HEARTBEAT_KEY = "ga.fixes";
const HOUSEKEEPING_KEY = "ga.fixes.housekeeping";
const HOUSEKEEPING_EVERY_MS = 24 * 3_600_000;
const RETENTION_MONTHS = 24;
const TERMINAL_STATUSES = [
  "VERIFIED",
  "FAILED",
  "UNDONE",
  "REJECTED",
  "EXPIRED",
] as const;
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
      `[ga-fixes] task could not be cancelled: ${errorName(error)}`,
    );
  }
}

async function auditExpired(change: GaConfigChange): Promise<void> {
  await recordGaFixAudit(
    "ga_config_change.expired",
    { changeId: change.id, kind: change.kind as GaFixKind },
    { workspaceId: change.workspaceId, projectId: change.projectId },
  );
}

// PROPOSED, karar yok ve süre doldu: satır, bekleyen onay ve Task kapanır.
async function expireProposal(change: GaConfigChange): Promise<void> {
  const closed = await prisma.gaConfigChange.updateMany({
    where: { id: change.id, status: "PROPOSED" },
    data: { status: "EXPIRED", openKey: null },
  });
  if (closed.count !== 1) return;
  if (change.approvalId) {
    await prisma.approval.updateMany({
      where: { id: change.approvalId, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
  }
  await cancelTask(change.taskId, change.projectId, "Approval expired");
  await auditExpired(change);
}

// Onaylı ama 14 gündür uygulanmamış: kapanır (onay satırı APPROVED kalır).
async function expireStaleApproved(change: GaConfigChange): Promise<void> {
  const closed = await prisma.gaConfigChange.updateMany({
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

// Kural 1-3: onay satırının durumu değişikliğe yansır.
async function reconcileProposed(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const rows = await prisma.gaConfigChange.findMany({
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
    if (!gaSyncAllowedFor(row.projectId)) continue;
    const approval = row.approvalId
      ? statusById.get(row.approvalId)
      : undefined;
    const overdue = row.expiresAt.getTime() <= now.getTime();
    try {
      if (approval === "APPROVED") {
        // Başka yoldan (sohbet, Telegram dışı) onaylanmış: önce onayla, sonra uygula.
        take(budget);
        await syncGaFixApprovalState(row.id);
        await applyGaConfigChange(row.id);
      } else if (
        approval === "REJECTED" ||
        approval === "REVISION_REQUESTED" ||
        approval === "CANCELLED" ||
        approval === "EXPIRED"
      ) {
        take(budget);
        await syncGaFixApprovalState(row.id);
      } else if (overdue) {
        take(budget);
        await expireProposal(row);
      }
    } catch (error) {
      console.error(
        `[ga-fixes] proposal could not be reconciled: ${errorName(error)}`,
      );
    }
  }
}

// Kural 5: kirası dolmuş APPLYING. Yazma dönmemişse APPROVED (yeniden
// planlanır), döndüyse APPLIED (yalnız geri okuma; ikinci yazma yok).
async function reconcileApplying(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const rows = await prisma.gaConfigChange.findMany({
    where: {
      status: "APPLYING",
      leaseUntil: { lt: now },
      ...projectScope(allowList),
    },
    select: { id: true, projectId: true, appliedAt: true },
    orderBy: { updatedAt: "asc" },
    take: budget.left,
  });
  const allowed = rows.filter((row) => gaSyncAllowedFor(row.projectId));
  const unwritten = allowed.filter((row) => row.appliedAt === null);
  const written = allowed.filter((row) => row.appliedAt !== null);
  const release = { leaseUntil: null, leaseOwner: null };
  if (unwritten.length > 0) {
    await prisma.gaConfigChange.updateMany({
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
    await prisma.gaConfigChange.updateMany({
      where: {
        id: { in: written.map((row) => row.id) },
        status: "APPLYING",
        leaseUntil: { lt: now },
        appliedAt: { not: null },
      },
      data: { status: "APPLIED", ...release },
    });
  }
  for (let index = 0; index < allowed.length; index += 1) take(budget);
}

// Kural 7: kirası dolmuş geri alma, değişikliği VERIFIED'a döndürür.
async function reconcileUndoing(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const rows = await prisma.gaConfigChange.findMany({
    where: {
      status: "UNDOING",
      leaseUntil: { lt: now },
      ...projectScope(allowList),
    },
    select: { id: true, projectId: true },
    orderBy: { updatedAt: "asc" },
    take: budget.left,
  });
  const allowed = rows.filter((row) => gaSyncAllowedFor(row.projectId));
  if (allowed.length === 0) return;
  await prisma.gaConfigChange.updateMany({
    where: {
      id: { in: allowed.map((row) => row.id) },
      status: "UNDOING",
      leaseUntil: { lt: now },
    },
    data: { status: "VERIFIED", leaseUntil: null, leaseOwner: null },
  });
  for (let index = 0; index < allowed.length; index += 1) take(budget);
}

// Kural 8: uygulanmamış eski onay.
async function reconcileStale(
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const cutoff = new Date(now.getTime() - GA_FIX_APPROVED_STALE_MS);
  const rows = await prisma.gaConfigChange.findMany({
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
    if (!gaSyncAllowedFor(row.projectId)) continue;
    try {
      take(budget);
      await expireStaleApproved(row);
    } catch (error) {
      console.error(
        `[ga-fixes] stale approval could not be closed: ${errorName(error)}`,
      );
    }
  }
}

// Kural 4 ve 6: uygulanacak (APPROVED) ve yalnız geri okunacak (APPLIED)
// satırlar. Kapatma anahtarı kapalı kind'lar APPROVED sorgusuna girmez: apply
// onları "skipped" döndürür ve her turda aynı satırlar LIMIT'i yerdi. APPLIED
// satırlar yazma yapmaz, bu yüzden kind anahtarına bakılmaz (yalnız GA_FIXES).
async function applyDue(
  status: "APPROVED" | "APPLIED",
  budget: Budget,
  now: Date,
  allowList: string[] | null,
): Promise<void> {
  const kinds = GA_FIX_KINDS.filter((kind) =>
    status === "APPLIED" ? gaFixesEnabled() : gaFixKindEnabled(kind),
  );
  if (kinds.length === 0) return;
  const stale =
    status === "APPROVED"
      ? {
          approvedAt: {
            gte: new Date(now.getTime() - GA_FIX_APPROVED_STALE_MS),
          },
        }
      : {};
  const rows = await prisma.gaConfigChange.findMany({
    where: {
      status,
      kind: { in: [...kinds] },
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
      ...stale,
      ...projectScope(allowList),
    },
    select: { id: true, projectId: true },
    orderBy: { updatedAt: "asc" },
    take: budget.left,
  });
  for (const row of rows) {
    if (budget.left <= 0) break;
    if (!gaSyncAllowedFor(row.projectId)) continue;
    take(budget);
    try {
      await applyGaConfigChange(row.id);
    } catch (error) {
      console.error(
        `[ga-fixes] change could not be applied: ${errorName(error)}`,
      );
    }
  }
}

// Kural 9: günlük temizlik. 24 aydan eski kapanmış satırlar silinir (gizlilik
// sayfası 24 ay der). Yalnız canlıda: yerel geliştirme süreci canlı
// veritabanını paylaşırken hiç çalışmaz.
async function housekeeping(now: Date): Promise<void> {
  try {
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
    await prisma.gaConfigChange.deleteMany({
      where: {
        status: { in: [...TERMINAL_STATUSES] },
        createdAt: { lt: cutoff },
      },
    });
  } catch (error) {
    console.error(`[ga-fixes] housekeeping failed: ${errorName(error)}`);
  }
}

export async function runGaFixesDue(
  limit = 5,
  now: Date = new Date(),
): Promise<number> {
  if (!gaFixesEnabled()) return 0;
  await Heartbeat.beat(HEARTBEAT_KEY, now);
  if (
    gaGlobalWorkAllowedHere() &&
    (await claimPeriodic(HOUSEKEEPING_KEY, HOUSEKEEPING_EVERY_MS, now))
  ) {
    await housekeeping(now);
  }

  const allowList = gaSyncProjectAllowList();
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
      console.error(`[ga-fixes] reconcile step failed: ${errorName(error)}`);
    }
  }
  await Heartbeat.ok(HEARTBEAT_KEY, now);
  return budget.done;
}
