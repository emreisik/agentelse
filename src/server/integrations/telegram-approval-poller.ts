import "server-only";

import type { IntegrationCredential } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  telegramGetUpdates,
  telegramAnswerCallbackQuery,
  telegramEditMessageReplyMarkup,
} from "@/server/integrations/telegram-client";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { publishCreativeCore } from "@/server/commands/publish-creative";
import { isHubConnectError } from "@/server/security/errors";

type TelegramCredentialMetadata = {
  chatId?: string;
  allowedApproverIds?: string[];
  telegramUpdateOffset?: number;
};

const CALLBACK_DATA_RE = /^(approve|reject|pubfeed|pubstory|pubskip):(.+)$/;
const PUBLISH_ACTIONS = new Set(["pubfeed", "pubstory", "pubskip"]);

async function processCredential(
  credential: IntegrationCredential,
): Promise<void> {
  const metadata = (credential.metadata ?? {}) as TelegramCredentialMetadata;
  const allowedApproverIds = metadata.allowedApproverIds ?? [];
  const token = decryptSecret(credential.encryptedSecret);

  const updates = await telegramGetUpdates(
    token,
    metadata.telegramUpdateOffset,
    0,
  );
  if (updates.length === 0) return;

  for (const update of updates) {
    const cq = update.callback_query;
    if (!cq?.data) continue;

    const match = CALLBACK_DATA_RE.exec(cq.data);
    if (!match) continue;
    const [, action, id] = match;
    if (!action || !id) continue;

    if (!allowedApproverIds.includes(String(cq.from.id))) {
      await telegramAnswerCallbackQuery(token, cq.id, {
        text: "Bu işlem için yetkiniz yok",
        showAlert: true,
      }).catch(() => {});
      continue;
    }

    // "Sosyal medyada paylaşmak ister misiniz?" sorusu — gerçek bir Approval
    // satırına bağlı değil (bkz. sendPublishPromptToTelegram), `id` burada
    // creativeId. approve/reject'ten ayrı ele alınıyor çünkü karar sonrası
    // henüz oluşmamış bir INSTAGRAM_PUBLISH görevini TETİKLİYOR, var olan
    // birini karara bağlamıyor.
    if (PUBLISH_ACTIONS.has(action)) {
      const clearKeyboard = () =>
        cq.message
          ? telegramEditMessageReplyMarkup(
              token,
              String(cq.message.chat.id),
              cq.message.message_id,
              null,
            ).catch(() => {})
          : Promise.resolve();

      if (action === "pubskip") {
        await clearKeyboard();
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: "Tamam, paylaşılmayacak",
        }).catch(() => {});
        continue;
      }

      try {
        const result = await publishCreativeCore({
          creativeId: id,
          format: action === "pubfeed" ? "FEED" : "STORIES",
          workspaceId: credential.workspaceId,
          projectId: credential.projectId,
          actorUserId: `telegram:${cq.from.id}`,
        });
        await clearKeyboard();
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: result.message,
          showAlert: !result.ok,
        }).catch(() => {});
      } catch (error) {
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: error instanceof Error ? error.message : "İşlem başarısız oldu",
          showAlert: true,
        }).catch(() => {});
      }
      continue;
    }

    try {
      const approval = await prisma.approval.findFirst({
        where: { id, projectId: credential.projectId },
      });
      if (!approval) {
        await telegramAnswerCallbackQuery(token, cq.id, {
          text: "Bu onay bulunamadı",
          showAlert: true,
        }).catch(() => {});
        continue;
      }

      await applyApprovalDecision({
        approval,
        to: action === "approve" ? "APPROVED" : "REJECTED",
        reviewedByUserId: `telegram:${cq.from.id}`,
        actorType: "USER",
      });

      await telegramAnswerCallbackQuery(token, cq.id, {
        text: action === "approve" ? "✅ Onaylandı" : "❌ Reddedildi",
      }).catch(() => {});
    } catch (error) {
      const message = isHubConnectError(error)
        ? "Bu onay artık karara bağlanamıyor (muhtemelen zaten karar verilmiş)"
        : "İşlem başarısız oldu";
      await telegramAnswerCallbackQuery(token, cq.id, {
        text: message,
        showAlert: true,
      }).catch(() => {});
    }
  }

  const maxUpdateId = Math.max(...updates.map((u) => u.update_id));
  await prisma.integrationCredential.update({
    where: { id: credential.id },
    data: {
      metadata: { ...metadata, telegramUpdateOffset: maxUpdateId + 1 },
    },
  });
}

// agency-wiring.ts'teki 3sn'lik tick'e "free-ride" eden bir adım: her
// ACTIVE Telegram bağlantısı için kısa (non-blocking) bir `getUpdates`
// çağrısı yapar, "✅ Onayla"/"❌ Reddet" callback'lerini işler. Bir
// credential'daki hata diğerlerini etkilemesin diye her biri kendi
// try/catch'i içinde işlenir.
export async function pollTelegramApprovals(): Promise<void> {
  const credentials = await prisma.integrationCredential.findMany({
    where: { provider: "telegram", status: "ACTIVE" },
  });

  for (const credential of credentials) {
    try {
      await processCredential(credential);
    } catch (error) {
      console.error(
        `Telegram onay polling hatası (credential ${credential.id}):`,
        error,
      );
    }
  }
}
