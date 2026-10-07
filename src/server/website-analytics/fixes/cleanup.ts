import "server-only";

import type { Prisma, TaskStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// GA-F7 Disconnect temizliği (docs/website-fixes.md "Limited Use"): çağıran
// (google-disconnect.ts) gaFixesEnabled() ile kapılar ve bağ silinmeden ÖNCE
// çalıştırır. GaConfigChange ve GaChangeWatch satırları bağ silinince cascade
// ile gider; ama Task, Approval ve sohbet kartı satırları bağa bağlı değildir.
// Bu yüzden:
//  - bekleyen PROPOSED/APPROVED değişiklikler EXPIRED olur, bekleyen onaylar
//    CANCELLED, Task'ları CANCELLED (açık kart ölü düğmeyle kalmaz);
//  - bağın BÜTÜN değişikliklerinin Task metni (başlık, açıklama, payload) ve
//    sohbet kartı metni sabit başlığa çevrilir. Onay kartında mülk adı yoktur
//    ama olay adı ve kampanya adı Agentelse'in kendi öneri metnindedir; yine
//    de Google'a bağlı veri sayılır ve bağ kopunca kalmaz.
// Sohbet kartları Command satırlarında durur (IdeaChatRepository.
// postApprovalRequestCard / resolveTaskResultCard): parsedIntent.card.taskId
// ile görev kartları, card.approvalId ile karar kartları bulunur; başlık ve
// ayrıntı alanları temizlenir. Hata Disconnect'i durdurmaz.

export const GA_FIX_SCRUBBED_TITLE = "Google Analytics change";

const BATCH = 50;
const TERMINAL_TASK_STATUSES: TaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
// Kartlarda başlıkla birlikte Google'a bağlı metin taşıyabilen alanlar.
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

// Kartın başlığı sabit metne çevrilir, ayrıntı alanları silinir. Eski başlık
// döner ki replyText içindeki kopyası da değiştirilebilsin.
function scrubParsedIntent(parsedIntent: unknown): {
  next: Prisma.InputJsonValue;
  oldTitle: string | null;
} | null {
  if (!isRecord(parsedIntent) || !isRecord(parsedIntent.card)) return null;
  const card: Record<string, unknown> = { ...parsedIntent.card };
  const oldTitle = typeof card.title === "string" ? card.title : null;
  card.title = GA_FIX_SCRUBBED_TITLE;
  for (const field of CARD_TEXT_FIELDS) delete card[field];
  return {
    next: { ...parsedIntent, card } as Prisma.InputJsonValue,
    oldTitle,
  };
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
      select: { id: true, replyText: true, parsedIntent: true },
    });
    for (const row of rows) {
      const scrubbed = scrubParsedIntent(row.parsedIntent);
      if (!scrubbed) continue;
      const replyText =
        row.replyText && scrubbed.oldTitle
          ? row.replyText.split(scrubbed.oldTitle).join(GA_FIX_SCRUBBED_TITLE)
          : row.replyText;
      await prisma.command.update({
        where: { id: row.id },
        data: { parsedIntent: scrubbed.next, replyText },
      });
    }
  }
}

export async function cancelPendingGaFixesForCredential(
  credentialId: string,
): Promise<number> {
  // Hata sonrası da o ana dek kapatılan satır sayısı döner.
  let expired = 0;
  try {
    const links = await prisma.gaPropertyLink.findMany({
      where: { credentialId },
      select: { id: true },
    });
    if (links.length === 0) return 0;
    const linkIds = links.map((link) => link.id);

    // 1) Bekleyen değişiklikler kapanır.
    const open = await prisma.gaConfigChange.findMany({
      where: {
        linkId: { in: linkIds },
        status: { in: ["PROPOSED", "APPROVED"] },
      },
      select: { id: true, taskId: true, approvalId: true },
    });
    if (open.length > 0) {
      const closed = await prisma.gaConfigChange.updateMany({
        where: {
          id: { in: open.map((row) => row.id) },
          status: { in: ["PROPOSED", "APPROVED"] },
        },
        data: {
          status: "EXPIRED",
          openKey: null,
          leaseUntil: null,
          leaseOwner: null,
        },
      });
      expired = closed.count;
      const openApprovalIds = open
        .map((row) => row.approvalId)
        .filter((id): id is string => id !== null);
      if (openApprovalIds.length > 0) {
        await prisma.approval.updateMany({
          where: { id: { in: openApprovalIds }, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
      }
      const openTaskIds = open
        .map((row) => row.taskId)
        .filter((id): id is string => id !== null);
      if (openTaskIds.length > 0) {
        await prisma.task.updateMany({
          where: {
            id: { in: openTaskIds },
            status: { notIn: TERMINAL_TASK_STATUSES },
          },
          data: { status: "CANCELLED" },
        });
      }
    }

    // 2) Görevi olan HER değişikliğin (her durum) metni silinir.
    const withTask = await prisma.gaConfigChange.findMany({
      where: { linkId: { in: linkIds }, taskId: { not: null } },
      select: { projectId: true, taskId: true, approvalId: true },
    });
    const taskIds = [
      ...new Set(
        withTask
          .map((row) => row.taskId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (taskIds.length === 0) return expired;
    const approvalIds = [
      ...new Set(
        withTask
          .map((row) => row.approvalId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const projectIds = [...new Set(withTask.map((row) => row.projectId))];

    await prisma.task.updateMany({
      where: { id: { in: taskIds } },
      data: { title: GA_FIX_SCRUBBED_TITLE, description: null, payload: {} },
    });
    await scrubChatCards(projectIds, taskIds, approvalIds);
    return expired;
  } catch (error) {
    // Disconnect devam eder; hata yalnız adıyla loglanır (metin ya da kimlik yok).
    console.error(
      "[ga-fixes] disconnect cleanup failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return expired;
  }
}
