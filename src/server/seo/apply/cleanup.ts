import "server-only";

import type { Prisma, TaskStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SEO_CHANGE_SCRUB_TITLE } from "@/lib/seo/apply/copy";

// SC-F8 Disconnect temizliği (docs/website-apply.md "Veri ve gizlilik"):
// çağıran (disconnectWordPress) CmsSite'ı silmeden ÖNCE çalıştırır; satırlar
// (SeoChange) CmsSite ile cascade gider, ama Task, Approval ve sohbet kartı
// satırları siteye bağlı değildir. Bu yüzden:
//  - bekleyen PROPOSED/APPROVED değişiklikler EXPIRED olur, bekleyen onaylar
//    CANCELLED, açık Task'lar CANCELLED (kartta ölü düğme kalmaz);
//  - sitenin BÜTÜN değişikliklerinin Task metni (başlık, açıklama, payload)
//    ve sohbet kartı metni sabit başlığa çevrilir. Başlıklar zaten sabittir
//    (sayfa yolu yalnız payload.details satırlarındadır) ama ayrıntı satırları
//    müşterinin sayfa içeriğidir ve site kopunca kalmaz.
// Sohbet kartları Command satırlarında durur: onay isteği kartı
// (postApprovalRequestCard) parsedIntent.card.approvalId / card.taskId ile
// bulunur; karar verilince resolveApprovalDecisionCard aynı satırı
// "approval-decision" kartına çevirir (başlık sabit, ayrıntı yok). İkisi de
// aynı süzgeçten geçer: başlık sabit metne döner, ayrıntı alanları silinir,
// replyText sabit metin olur.
// Bayrağa bağlı DEĞİLDİR (SEO_APPLY kapatılsa da Disconnect temizler) ve asla
// fırlatmaz: hata Disconnect'i durdurmaz, yalnız adıyla loglanır.

const BATCH = 50;
const TERMINAL_TASK_STATUSES: TaskStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];
// Kartlarda başlıkla birlikte sayfa içeriği taşıyabilen alanlar.
const CARD_TEXT_FIELDS = ["details", "resultText", "note", "errorMessage"];

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    parts.push(items.slice(index, index + size));
  }
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueIds(values: (string | null)[]): string[] {
  return [...new Set(values.filter((id): id is string => id !== null))];
}

function scrubParsedIntent(
  parsedIntent: unknown,
): Prisma.InputJsonValue | null {
  if (!isRecord(parsedIntent) || !isRecord(parsedIntent.card)) return null;
  const card: Record<string, unknown> = { ...parsedIntent.card };
  card.title = SEO_CHANGE_SCRUB_TITLE;
  for (const field of CARD_TEXT_FIELDS) delete card[field];
  return { ...parsedIntent, card } as Prisma.InputJsonValue;
}

async function scrubChatCards(
  projectIds: string[],
  taskIds: string[],
  approvalIds: string[],
): Promise<void> {
  const filters: Prisma.CommandWhereInput[] = [
    ...taskIds.map((id) => ({
      parsedIntent: { path: ["card", "taskId"], equals: id },
    })),
    ...approvalIds.map((id) => ({
      parsedIntent: { path: ["card", "approvalId"], equals: id },
    })),
  ];
  for (const part of chunk(filters, BATCH)) {
    const rows = await prisma.command.findMany({
      where: { source: "SYSTEM", projectId: { in: projectIds }, OR: part },
      select: { id: true, parsedIntent: true },
    });
    for (const row of rows) {
      const next = scrubParsedIntent(row.parsedIntent);
      if (!next) continue;
      await prisma.command.update({
        where: { id: row.id },
        data: { parsedIntent: next, replyText: SEO_CHANGE_SCRUB_TITLE },
      });
    }
  }
}

// Adımlar birbirinden bağımsızdır: biri düşse de sonrakiler denenir.
async function attempt(step: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(
      `[seo-apply] disconnect cleanup (${step}) failed:`,
      error instanceof Error ? error.name : "unknown",
    );
  }
}

export async function cleanupSeoApplyForSite(siteId: string): Promise<number> {
  // Hata sonrası da o ana dek kapatılan satır sayısı döner.
  let expired = 0;
  let rows: {
    id: string;
    projectId: string;
    status: string;
    taskId: string | null;
    approvalId: string | null;
  }[] = [];
  try {
    rows = await prisma.seoChange.findMany({
      where: { siteId },
      select: {
        id: true,
        projectId: true,
        status: true,
        taskId: true,
        approvalId: true,
      },
    });
  } catch (error) {
    console.error(
      "[seo-apply] disconnect cleanup failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return 0;
  }
  if (rows.length === 0) return 0;

  const taskIds = uniqueIds(rows.map((row) => row.taskId));
  const approvalIds = uniqueIds(rows.map((row) => row.approvalId));
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const openIds = rows
    .filter((row) => row.status === "PROPOSED" || row.status === "APPROVED")
    .map((row) => row.id);

  // 1) Bekleyen değişiklikler kapanır.
  await attempt("expire", async () => {
    if (openIds.length === 0) return;
    const closed = await prisma.seoChange.updateMany({
      where: { id: { in: openIds }, status: { in: ["PROPOSED", "APPROVED"] } },
      data: {
        status: "EXPIRED",
        openKey: null,
        leaseUntil: null,
        leaseOwner: null,
      },
    });
    expired = closed.count;
  });

  // 2) Bekleyen onaylar ve açık görevler iptal edilir (uygulanmış satırların
  // görevi de: site gidince "çalışıyor" kalmasın).
  await attempt("approvals", async () => {
    if (approvalIds.length === 0) return;
    await prisma.approval.updateMany({
      where: { id: { in: approvalIds }, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
  });
  await attempt("tasks", async () => {
    if (taskIds.length === 0) return;
    await prisma.task.updateMany({
      where: { id: { in: taskIds }, status: { notIn: TERMINAL_TASK_STATUSES } },
      data: { status: "CANCELLED" },
    });
  });

  // 3) Görevi olan HER değişikliğin (her durum) metni silinir.
  await attempt("scrub-tasks", async () => {
    if (taskIds.length === 0) return;
    await prisma.task.updateMany({
      where: { id: { in: taskIds } },
      data: {
        title: SEO_CHANGE_SCRUB_TITLE,
        description: null,
        payload: {},
      },
    });
  });
  await attempt("scrub-cards", async () => {
    if (taskIds.length === 0 && approvalIds.length === 0) return;
    await scrubChatCards(projectIds, taskIds, approvalIds);
  });

  return expired;
}
