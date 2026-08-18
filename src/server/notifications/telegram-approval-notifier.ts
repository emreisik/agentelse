import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Approval, ApprovalStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  telegramSendMessage,
  telegramSendPhoto,
  telegramEditMessageReplyMarkup,
  type TelegramReplyMarkup,
} from "@/server/integrations/telegram-client";
import { notifyProjectTelegram } from "@/server/notifications/project-telegram-notifier";

// Aynı yerel-disk asset şeması src/app/api/assets/[assetId]/route.ts'te de
// var — burada kasıtlı olarak küçük bir kopyası tutuluyor (o route'u bu
// özellik için genişletmek kapsam dışı).
const LOCAL_ASSET_SCHEME = "local-asset://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");
const SAFE_FILENAME = /^[a-zA-Z0-9-]+\.(png|jpe?g|webp|pdf|txt|csv|md)$/;

const TELEGRAM_CAPTION_LIMIT = 1024;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function readLocalAsset(
  storageKey: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  if (!storageKey.startsWith(LOCAL_ASSET_SCHEME)) return null;
  const filename = storageKey.slice(LOCAL_ASSET_SCHEME.length);
  if (!SAFE_FILENAME.test(filename)) return null;
  try {
    const buffer = await readFile(path.join(LOCAL_ASSETS_DIR, filename));
    return { buffer, filename };
  } catch {
    return null;
  }
}

async function resolveApprovalLabel(approval: {
  entityType: string;
  taskId: string | null;
}): Promise<string> {
  if (approval.taskId) {
    const task = await prisma.task.findUnique({
      where: { id: approval.taskId },
      select: { title: true },
    });
    if (task) return task.title;
  }
  return approval.entityType;
}

function buildKeyboard(
  approvalId: string,
  allowedApproverIds: string[],
): TelegramReplyMarkup | undefined {
  if (allowedApproverIds.length === 0) return undefined;
  return {
    inline_keyboard: [
      [
        { text: "✅ Onayla", callback_data: `approve:${approvalId}` },
        { text: "❌ Reddet", callback_data: `reject:${approvalId}` },
      ],
    ],
  };
}

type TelegramCredentialMetadata = {
  chatId?: string;
  allowedApproverIds?: string[];
};

function findActiveTelegramCredential(projectId: string) {
  return prisma.integrationCredential.findFirst({
    where: { projectId, provider: "telegram", status: "ACTIVE" },
  });
}

// Yeni bir Approval oluştuğunda proje Telegram'a bağlıysa zengin bir
// bildirim gönderir: Creative ise caption/copy + varsa görsel, değilse
// düz metin — ikisinde de (izinli kullanıcı listesi doluysa) "Onayla"/
// "Reddet" butonları eklenir; liste boşsa buton eklenmez (çalışmayan bir
// buton göstermemek için). Dönen mesaj id'si karar sonrası butonları
// kaldırabilmek için Approval'a yazılır. Best-effort — hata asla onay
// oluşturmayı bozmaz.
export async function sendApprovalRequestToTelegram(approval: {
  id: string;
  projectId: string;
  taskId: string | null;
  entityType: string;
  entityId: string;
  type: string;
}): Promise<void> {
  try {
    const credential = await findActiveTelegramCredential(approval.projectId);
    if (!credential) return;
    const metadata = (credential.metadata ?? {}) as TelegramCredentialMetadata;
    if (!metadata.chatId) return;

    const token = decryptSecret(credential.encryptedSecret);
    const replyMarkup = buildKeyboard(
      approval.id,
      metadata.allowedApproverIds ?? [],
    );

    let messageId: number | undefined;

    if (approval.entityType === "Creative") {
      const creative = await prisma.creative.findUnique({
        where: { id: approval.entityId },
        select: { currentVersionId: true },
      });
      const version = creative?.currentVersionId
        ? await prisma.creativeVersion.findUnique({
            where: { id: creative.currentVersionId },
            include: { asset: true },
          })
        : null;

      const text = truncate(
        [
          "📋 Creative onayı bekliyor",
          version?.caption ? `\nCaption: ${version.caption}` : null,
          version?.copy ? `\nCopy: ${version.copy}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        TELEGRAM_CAPTION_LIMIT,
      );

      const localAsset = version?.asset
        ? await readLocalAsset(version.asset.storageKey)
        : null;

      const sent = localAsset
        ? await telegramSendPhoto(
            token,
            metadata.chatId,
            localAsset.buffer,
            localAsset.filename,
            { caption: text, replyMarkup },
          )
        : await telegramSendMessage(token, metadata.chatId, text, {
            replyMarkup,
          });
      messageId = sent.message_id;
    } else {
      const label = await resolveApprovalLabel(approval);
      const sent = await telegramSendMessage(
        token,
        metadata.chatId,
        `🔔 Onay bekliyor: ${label} (${approval.type})`,
        { replyMarkup },
      );
      messageId = sent.message_id;
    }

    if (messageId) {
      await prisma.approval.update({
        where: { id: approval.id },
        data: { telegramMessageId: String(messageId) },
      });
    }
  } catch (error) {
    console.error("Telegram onay isteği gönderilemedi:", error);
  }
}

function buildPublishPromptKeyboard(creativeId: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📷 Gönderi", callback_data: `pubfeed:${creativeId}` },
        { text: "📱 Story", callback_data: `pubstory:${creativeId}` },
      ],
      [{ text: "Hayır, paylaşma", callback_data: `pubskip:${creativeId}` }],
    ],
  };
}

// Bir kreatif onaylandığında sohbetteki "publish-prompt" kartının Telegram
// karşılığı — approval-decisions.ts tarafından çağrılır. Gerçek bir Approval
// satırına bağlı DEĞİL (henüz hangi formatta paylaşılacağı bile belli değil),
// bu yüzden approve/reject'ten farklı, kendi callback_data ön ekleri var
// (bkz. telegram-approval-poller.ts). Onay butonlarıyla aynı hassasiyette
// bir karar olduğu için aynı allowedApproverIds listesi kullanılıyor —
// liste boşsa (approval butonlarında olduğu gibi) hiç gönderilmez.
export async function sendPublishPromptToTelegram(input: {
  projectId: string;
  creativeId: string;
  title: string;
}): Promise<void> {
  try {
    const credential = await findActiveTelegramCredential(input.projectId);
    if (!credential) return;
    const metadata = (credential.metadata ?? {}) as TelegramCredentialMetadata;
    if (!metadata.chatId || !metadata.allowedApproverIds?.length) return;

    const token = decryptSecret(credential.encryptedSecret);
    const replyMarkup = buildPublishPromptKeyboard(input.creativeId);
    const text = `📤 ${input.title} onaylandı — sosyal medyada paylaşmak ister misiniz?`;

    const creative = await prisma.creative.findUnique({
      where: { id: input.creativeId },
      select: { currentVersionId: true },
    });
    const version = creative?.currentVersionId
      ? await prisma.creativeVersion.findUnique({
          where: { id: creative.currentVersionId },
          include: { asset: true },
        })
      : null;
    const localAsset = version?.asset
      ? await readLocalAsset(version.asset.storageKey)
      : null;

    if (localAsset) {
      await telegramSendPhoto(
        token,
        metadata.chatId,
        localAsset.buffer,
        localAsset.filename,
        { caption: text, replyMarkup },
      );
    } else {
      await telegramSendMessage(token, metadata.chatId, text, { replyMarkup });
    }
  } catch (error) {
    console.error("Telegram paylaşım sorusu gönderilemedi:", error);
  }
}

// Bir onay karara bağlandığında: orijinal mesajdaki butonları kaldırır
// (varsa) ve — APPROVED/REJECTED/REVISION_REQUESTED için — kısa bir takip
// mesajı gönderir. Best-effort, hiçbir zaman karar işlemini bozmaz.
export async function notifyApprovalDecision(
  approval: Approval,
  to: ApprovalStatus,
  reviewedByUserId: string,
): Promise<void> {
  try {
    const credential = await findActiveTelegramCredential(approval.projectId);
    if (!credential) return;
    const metadata = (credential.metadata ?? {}) as TelegramCredentialMetadata;
    if (!metadata.chatId) return;

    const token = decryptSecret(credential.encryptedSecret);

    if (approval.telegramMessageId) {
      try {
        await telegramEditMessageReplyMarkup(
          token,
          metadata.chatId,
          Number(approval.telegramMessageId),
          null,
        );
      } catch {
        // Mesaj silinmiş/artık düzenlenemez olabilir — takip mesajı yine de gönderilsin.
      }
    }

    const prefix =
      to === "APPROVED"
        ? "✅ Onaylandı"
        : to === "REJECTED"
          ? "❌ Reddedildi"
          : to === "REVISION_REQUESTED"
            ? "✏️ Revizyon istendi"
            : null;
    if (!prefix) return;

    const label = await resolveApprovalLabel(approval);
    const via = reviewedByUserId.startsWith("telegram:")
      ? " (Telegram üzerinden)"
      : "";
    await notifyProjectTelegram(
      approval.projectId,
      `${prefix}: ${label}${via}`,
    );
  } catch (error) {
    console.error("Telegram onay kararı bildirimi gönderilemedi:", error);
  }
}
