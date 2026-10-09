import "server-only";

import { randomUUID } from "node:crypto";

import type { CapabilityKey, TaskPriority } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { planCreativeIdOf } from "@/server/execution/plan-creative-link";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  OUTBOX_EVENT_TYPES,
  OutboxRepository,
} from "@/server/repositories/outbox.repository";
import { TaskRepository } from "@/server/repositories/task.repository";

import { JOB_RESERVATION_TTL_MS } from "@/lib/billing/plans";

import { getBillingConfig } from "./config";
import {
  beginOperation,
  releaseOperationReservations,
  type OperationReserve,
} from "./operation";
import { NoPlanError, QuotaExceededError, isQuotaError } from "./quota-errors";

// Plan hakkı bitince iş HATA olmaz, BEKLER (WAITING_BUDGET): üretilmiş içerik ve
// tamamlanan aşamalar yerinde kalır, hak yenilenince ya da ek paket alınınca iş
// öncelik + son tarih sırasıyla kuyruğa döner. Durum veritabanındadır; worker
// yeniden başlasa da iş kaybolmaz. docs/billing-tasks.md

// Bir işin en çok bu kadar beklemesine izin verilir; sonra iptal edilir (bayat
// bağlam, geçmiş slot tarihi, sonsuza kilitli görev yerine). Kota penceresi en çok
// 31 gündür: erken bitiren kullanıcının işi yenilemeden ÖNCE iptal edilmemeli
// ("kota yenilendiğinde uygun görevler otomatik devam etsin"); sınır, en uzun
// bekleme (bir tam pencere) + güvenlik payıdır.
export const MAX_PARK_AGE_MS = 45 * 24 * 60 * 60 * 1000;

// Devam adımının önceden ayırdığı hakkın jeton öneki: dispatch olayı jetonu
// taşır, startExecution aynı anahtarı bulup devralır (yeniden rezerve etmez).
export const RESUME_TOKEN_PREFIX = "resume.";

// Bir süpürmede en çok bu kadar workspace ve workspace başına bu kadar iş: hakkı
// olmayan tek bir kiracının çok sayıda parklı işi, hak yatıran diğer kiracıların
// işlerini görünmez kılmasın.
const MAX_WORKSPACES_PER_SWEEP = 50;
const MAX_JOBS_PER_WORKSPACE = 50;

const PRIORITY_RANK: Record<TaskPriority, number> = {
  URGENT: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
};

const TERMINAL_TASK = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const isTerminalTask = (status: string) =>
  (TERMINAL_TASK as readonly string[]).includes(status);

// Görevin "güncellendi" damgası ilerleme yoklamasını (chat/progress.ts) uyandırır:
// park/devam kullanıcıya görünür olsun.
async function touchTask(taskId: string): Promise<void> {
  await prisma.task
    .updateMany({ where: { id: taskId }, data: { updatedAt: new Date() } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// park

// İşi WAITING_BUDGET'e park eder (CAS: yalnız QUEUED olan). startExecution içinden
// çağrılır ve işi döndürür; "olay işlendi" işareti startExecution döndükten sonra
// çağıranın normal akışında konur, arada çökme olsa olay yeniden teslim edilir ve
// iş artık QUEUED olmadığı için erken döner (yetim iş doğmaz).
export async function parkJob(
  executionJobId: string,
  error: QuotaExceededError | NoPlanError,
): Promise<boolean> {
  const job = await prisma.executionJob.findUnique({
    where: { id: executionJobId },
    select: { workspaceId: true, projectId: true, brandId: true, taskId: true },
  });
  if (!job) return false;

  const moved = await prisma.executionJob.updateMany({
    where: { id: executionJobId, status: "QUEUED" },
    data: {
      status: "WAITING_BUDGET",
      errorCode: error.code,
      errorMessage: error.message,
      retryable: true,
    },
  });
  if (moved.count !== 1) return false;

  try {
    // Park CAS'i QUEUED'dan başardı: bu işi şu an koşan kimse yok. Önceki
    // denemelerden kalan açık tutuşlar (ör. claim'den önce kopan bir koşu) yeni
    // rezervasyonu kendi kendine engellemesin diye hemen iade edilir.
    await releaseOperationReservations({
      workspaceId: job.workspaceId,
      operationId: `exec:${executionJobId}`,
    });
    await touchTask(job.taskId);
    await AuditLogRepository.record({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      brandId: job.brandId,
      actorType: "SYSTEM",
      action: "billing.job.parked",
      entityType: "ExecutionJob",
      entityId: executionJobId,
      metadata: { code: error.code, ...(error.meta ?? {}) },
    });
  } catch (sideEffectError) {
    console.error(
      "[billing] parked job side effects failed:",
      sideEffectError instanceof Error
        ? sideEffectError.name
        : sideEffectError,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// devam

export type ResumeSummary = {
  resumed: number;
  cancelled: number;
  stillParked: number;
};

const emptySummary = (): ResumeSummary => ({
  resumed: 0,
  cancelled: 0,
  stillParked: 0,
});

type ParkedRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  capability: CapabilityKey;
  requestPayload: unknown;
  createdAt: Date;
  updatedAt: Date;
  task: {
    status: string;
    priority: TaskPriority;
    riskLevel: string;
    dueAt: Date | null;
    createdByType: string;
    payload: unknown;
  };
};

const PARKED_SELECT = {
  id: true,
  workspaceId: true,
  projectId: true,
  taskId: true,
  capability: true,
  requestPayload: true,
  createdAt: true,
  updatedAt: true,
  task: {
    select: {
      status: true,
      priority: true,
      riskLevel: true,
      dueAt: true,
      createdByType: true,
      payload: true,
    },
  },
} as const;

// Sıralama anahtarı: öncelik (URGENT→LOW), sonra kullanıcının kendi isteği (arka
// plan işinden önce), sonra son tarih (boş sonda), sonra oluşturulma. Task.priority
// ve Task.dueAt bugün hiçbir yerde yazılmıyor (hepsi MEDIUM/boş): son tarih,
// görevin takvim slotunun planlı zamanından türetilir (deadlines). İkisi de
// ileride yazılırsa kendiliğinden önce gelir.
export function resumeOrder(
  deadlines: ReadonlyMap<string, Date>,
): (a: ParkedRow, b: ParkedRow) => number {
  const due = (row: ParkedRow) =>
    (row.task.dueAt ?? deadlines.get(row.id))?.getTime() ??
    Number.POSITIVE_INFINITY;
  return (a, b) => {
    const priority =
      PRIORITY_RANK[b.task.priority] - PRIORITY_RANK[a.task.priority];
    if (priority !== 0) return priority;
    const own =
      Number(b.task.createdByType === "USER") -
      Number(a.task.createdByType === "USER");
    if (own !== 0) return own;
    const aDue = due(a);
    const bDue = due(b);
    if (aDue !== bDue) return aDue < bDue ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  };
}

// WAITING_BUDGET → QUEUED ve yeni dispatch olayı TEK işlemde. CAS görevin hâlâ
// istendiğini de koşul yapar: görevi kullanıcı bu arada iptal ettiyse iş
// diriltilmez. Hak önceden ayrılmışsa jeton olayın içinde taşınır.
async function requeue(
  job: ParkedRow,
  attemptToken: string | undefined,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.executionJob.updateMany({
      where: {
        id: job.id,
        status: "WAITING_BUDGET",
        task: { status: { notIn: [...TERMINAL_TASK] } },
      },
      data: { status: "QUEUED", errorCode: null, errorMessage: null },
    });
    if (moved.count !== 1) return false;
    await tx.task.updateMany({
      where: { id: job.taskId },
      data: { updatedAt: new Date() },
    });
    await OutboxRepository.enqueue(tx, {
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      aggregateType: "ExecutionJob",
      aggregateId: job.id,
      eventType: OUTBOX_EVENT_TYPES.EXECUTION_DISPATCH,
      payload: {
        executionJobId: job.id,
        riskLevel: job.task.riskLevel,
        ...(attemptToken ? { attemptToken } : {}),
      },
      executionJobId: job.id,
    });
    return true;
  });
}

// İş artık istenmiyor: görevi bitmiş/iptal ya da çok uzun beklemiş. İş kapanır;
// aşırı beklemede görev de iptal edilir ki plan sonsuza dek asılı kalmasın.
async function closeParked(
  job: ParkedRow,
  why: "task-gone" | "expired",
  now: Date,
): Promise<boolean> {
  const closed = await prisma.executionJob.updateMany({
    where: { id: job.id, status: "WAITING_BUDGET" },
    data: { status: "CANCELLED", completedAt: now },
  });
  if (closed.count !== 1) return false;
  if (why === "expired") {
    await TaskRepository.transition(job.taskId, job.projectId, "CANCELLED", {
      failureReason: "Paused too long waiting for the plan allowance",
    }).catch(() => undefined);
    await AuditLogRepository.record({
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      actorType: "SYSTEM",
      action: "billing.job.park_expired",
      entityType: "ExecutionJob",
      entityId: job.id,
      metadata: { parkedSince: job.updatedAt.toISOString() },
    }).catch(() => undefined);
  }
  return true;
}

// Hakkı yetecek park edilmiş işleri kuyruğa döndürür (enforce). `workspaceId`
// verilirse yalnız o workspace (ek paket satın alınınca / kota yenilenince
// çağrılır); verilmezse bakım adımı hepsini tarar.
//
// Karar GERÇEK defterle verilir: her iş için startExecution'ın yapacağı aynı
// rezervasyon denenir, başarılıysa hak iş kuyruğa dönmeden ÖNCE ayrılmış olur ve
// dispatch olayının jetonuyla taşınır (startExecution aynı anahtarı devralır).
// Böylece "sığar" tahmini ile gerçek hakem ayrışmaz (her tick yeniden park etme
// döngüsü olmaz) ve paralel işler aynı bakiyeyi iki kez tüketemez. Olay hiç
// işlenmezse ayrılan hak 45 dk sonra süpürücüyle geri döner.
//
// Sıkı öncelik: bir iş sığmıyorsa onun BİRİMLERİ bu süpürmede kapanır; küçük ve
// düşük öncelikli iş, büyük ve yüksek öncelikli olanı aç bırakmaz. Plan yoksa
// (NO_PLAN) workspace'in geri kalanı denenmez.
//
// Resume hiçbir onay üretmez ve atlamaz: iş zaten onaydan geçip dispatch edilmişti,
// payload'ı ve onayları üzerinde durur ("önceki yetkiler geçerli").
export async function resumeParkedWork(
  options: { workspaceId?: string; now?: Date; limit?: number } = {},
): Promise<ResumeSummary> {
  const summary = emptySummary();
  const mode = getBillingConfig().mode;
  if (mode === "off") return summary;
  // Gölgede hiçbir şey park olmaz: kalanlar enforce döneminden artıktır.
  if (mode === "shadow") return drainParkedWork(options);

  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;

  // Yalnız durumu değişmiş workspace'ler: park edildikten SONRA bakiyesi ya da
  // aboneliği güncellenenler (yenileme, ek paket, ödeme, serbest bırakılan hak),
  // bekleme sınırını aşan iş taşıyanlar ve görevi artık istenmeyen iş taşıyanlar.
  // Hakkı hiç değişmeyen (bitmiş, boşta) kiracılar her tick sırayı işgal edip
  // hak yatıran diğerlerini açıkta bırakmasın. Belirli bir workspace istenmişse
  // (ek paket işleyicisi çağırır) süzgeç yok: değiştiğini zaten biliyor.
  const expiryCutoff = new Date(now.getTime() - MAX_PARK_AGE_MS);
  const groups = options.workspaceId
    ? [{ workspaceId: options.workspaceId }]
    : await prisma.$queryRaw<Array<{ workspaceId: string }>>`
        SELECT j."workspaceId" AS "workspaceId"
          FROM "ExecutionJob" j
         WHERE j."status" = 'WAITING_BUDGET'
         GROUP BY j."workspaceId"
        HAVING MIN(j."updatedAt") < ${expiryCutoff}
            OR EXISTS (SELECT 1 FROM "UsageBalance" b
                        WHERE b."workspaceId" = j."workspaceId"
                          AND b."updatedAt" > MIN(j."updatedAt"))
            OR EXISTS (SELECT 1 FROM "Subscription" s
                        WHERE s."workspaceId" = j."workspaceId"
                          AND s."updatedAt" > MIN(j."updatedAt"))
            OR EXISTS (SELECT 1 FROM "ExecutionJob" gone
                         JOIN "Task" t ON t."id" = gone."taskId"
                        WHERE gone."workspaceId" = j."workspaceId"
                          AND gone."status" = 'WAITING_BUDGET'
                          AND t."status" IN ('COMPLETED', 'FAILED', 'CANCELLED'))
         ORDER BY MIN(j."updatedAt") ASC
         LIMIT ${MAX_WORKSPACES_PER_SWEEP}`;

  for (const { workspaceId } of groups) {
    if (summary.resumed >= limit) break;
    try {
      const outcome = await resumeWorkspace(
        workspaceId,
        now,
        limit - summary.resumed,
      );
      summary.resumed += outcome.resumed;
      summary.cancelled += outcome.cancelled;
      summary.stillParked += outcome.stillParked;
      if (outcome.ledgerDown) break;
    } catch (error) {
      console.error(
        "[billing] resume failed for a workspace:",
        error instanceof Error ? error.name : error,
      );
    }
  }
  return summary;
}

async function resumeWorkspace(
  workspaceId: string,
  now: Date,
  budget: number,
): Promise<ResumeSummary & { ledgerDown: boolean }> {
  const outcome = { ...emptySummary(), ledgerDown: false };
  const rows = (await prisma.executionJob.findMany({
    where: { workspaceId, status: "WAITING_BUDGET" },
    orderBy: { updatedAt: "asc" },
    take: MAX_JOBS_PER_WORKSPACE,
    select: PARKED_SELECT,
  })) as ParkedRow[];

  // Artık istenmeyenleri kapat; geri kalanlar sıraya girer.
  const live: ParkedRow[] = [];
  for (const row of rows) {
    if (isTerminalTask(row.task.status)) {
      if (await closeParked(row, "task-gone", now)) outcome.cancelled += 1;
    } else if (now.getTime() - row.updatedAt.getTime() > MAX_PARK_AGE_MS) {
      if (await closeParked(row, "expired", now)) outcome.cancelled += 1;
    } else {
      live.push(row);
    }
  }
  if (live.length === 0) return outcome;

  // Duraklatılmış/kapatılmış projenin işi bekler (proje açılınca devam eder).
  const projects = await prisma.project.findMany({
    where: { id: { in: [...new Set(live.map((row) => row.projectId))] } },
    select: { id: true, status: true },
  });
  const inactiveProjects = new Set(
    projects
      .filter((p) => p.status === "PAUSED" || p.status === "CLOSED")
      .map((p) => p.id),
  );

  const deadlines = await slotDeadlines(live);
  const { usageNeedOf } = await import("@/server/execution/usage-need");
  const blocked = new Set<string>();
  const ordered = [...live].sort(resumeOrder(deadlines));

  for (const [index, job] of ordered.entries()) {
    if (outcome.resumed >= budget || outcome.ledgerDown) {
      outcome.stillParked += 1;
      continue;
    }
    if (inactiveProjects.has(job.projectId)) {
      outcome.stillParked += 1;
      continue;
    }

    const need = usageNeedOf(job.capability, job.requestPayload);
    const reserve: OperationReserve = need
      ? need.unit === "IMAGE"
        ? { IMAGE: Number(need.amount) }
        : { AI_MICROS: need.amount }
      : {};
    const units = need ? [need.unit] : [];
    if (units.some((unit) => blocked.has(unit))) {
      outcome.stillParked += 1;
      continue;
    }

    const attemptToken = `${RESUME_TOKEN_PREFIX}${randomUUID()}`;
    let operation;
    try {
      operation = await beginOperation({
        workspaceId,
        projectId: job.projectId,
        operationId: `exec:${job.id}`,
        attemptToken,
        reserve,
        requireAccess: true,
        ttlMs: JOB_RESERVATION_TTL_MS,
        now,
      });
    } catch (error) {
      if (error instanceof NoPlanError) {
        // Plan yok: bu workspace'in kalan işleri de beklemeye devam eder.
        outcome.stillParked += ordered.length - index;
        return outcome;
      }
      if (isQuotaError(error)) {
        for (const unit of units) blocked.add(unit);
        outcome.stillParked += 1;
        continue;
      }
      // Defter okunamadı: bu süpürmeyi bırak, bir sonraki tick yeniden dener.
      outcome.ledgerDown = true;
      outcome.stillParked += 1;
      continue;
    }

    let woken = false;
    try {
      woken = await requeue(
        job,
        operation.holdsReservation ? attemptToken : undefined,
      );
    } finally {
      // Kuyruğa dönemediyse (yarış, iptal, hata) ayrılan hak hemen iade edilir.
      if (!woken) await operation.finish("aborted");
    }
    if (woken) outcome.resumed += 1;
    else outcome.stillParked += 1;
  }
  return outcome;
}

// Görevin takvim slotunun planlı zamanı (Task.payload.planCreativeId →
// Creative.scheduledFor): "son tarih" budur.
async function slotDeadlines(rows: ParkedRow[]): Promise<Map<string, Date>> {
  const byCreative = new Map<string, string[]>();
  for (const row of rows) {
    const creativeId = planCreativeIdOf(row.task.payload);
    if (!creativeId) continue;
    byCreative.set(creativeId, [...(byCreative.get(creativeId) ?? []), row.id]);
  }
  const deadlines = new Map<string, Date>();
  if (byCreative.size === 0) return deadlines;
  const creatives = await prisma.creative.findMany({
    where: { id: { in: [...byCreative.keys()] } },
    select: { id: true, scheduledFor: true },
  });
  for (const creative of creatives) {
    if (!creative.scheduledFor) continue;
    for (const jobId of byCreative.get(creative.id) ?? []) {
      deadlines.set(jobId, creative.scheduledFor);
    }
  }
  return deadlines;
}

// ---------------------------------------------------------------------------
// boşaltma (kill-switch)

// Faturalama enforce'tan çıktığında (shadow/off) parklı işler hak beklemez:
// hepsi hakka bakmadan kuyruğa döner. Tek yönlü bir kapı olmaz: operatör
// BILLING_MODE'u kapatınca işler sonsuza dek asılı kalmasın.
export async function drainParkedWork(
  options: { now?: Date; limit?: number } = {},
): Promise<ResumeSummary> {
  const summary = emptySummary();
  const now = options.now ?? new Date();
  const rows = (await prisma.executionJob.findMany({
    where: { status: "WAITING_BUDGET" },
    orderBy: { updatedAt: "asc" },
    take: options.limit ?? 200,
    select: PARKED_SELECT,
  })) as ParkedRow[];
  for (const row of rows) {
    if (isTerminalTask(row.task.status)) {
      if (await closeParked(row, "task-gone", now)) summary.cancelled += 1;
    } else if (await requeue(row, undefined)) {
      summary.resumed += 1;
    } else {
      summary.stillParked += 1;
    }
  }
  return summary;
}
