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

// The same local-disk asset scheme also exists in
// src/app/api/assets/[assetId]/route.ts — a small copy is deliberately kept
// here (extending that route for this feature is out of scope).
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
        { text: "✅ Approve", callback_data: `approve:${approvalId}` },
        { text: "❌ Reject", callback_data: `reject:${approvalId}` },
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

// When a new Approval is created, if the project is connected to Telegram,
// sends a rich notification: for a Creative, caption/copy plus an image if
// available, otherwise plain text — in both cases (if the allowed-approver
// list is non-empty) "Approve"/"Reject" buttons are added; if the list is
// empty, no button is added (to avoid showing a button that doesn't work).
// The returned message id is written back onto the Approval so the buttons
// can be removed after the decision. Best-effort — an error never breaks
// approval creation.
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
          "📋 Creative approval pending",
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
        `🔔 Awaiting approval: ${label} (${approval.type})`,
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
    console.error("Failed to send Telegram approval request:", error);
  }
}

function buildPublishPromptKeyboard(creativeId: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📷 Post", callback_data: `pubfeed:${creativeId}` },
        { text: "📱 Story", callback_data: `pubstory:${creativeId}` },
      ],
      [{ text: "No, don't share", callback_data: `pubskip:${creativeId}` }],
    ],
  };
}

// The Telegram counterpart of the "publish-prompt" card in chat when a
// creative is approved — called from approval-decisions.ts. NOT tied to a
// real Approval row (it isn't even known yet which format it'll be shared
// in), so unlike approve/reject it has its own callback_data prefixes (see
// telegram-approval-poller.ts). Since this is as sensitive a decision as the
// approval buttons, it uses the same allowedApproverIds list — if that list
// is empty (same as the approval buttons), nothing is sent at all.
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
    const text = `📤 ${input.title} approved — want to share it on social media?`;

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
    console.error("Failed to send Telegram publish prompt:", error);
  }
}

// When an approval decision is made: removes the buttons on the original
// message (if any) and — for APPROVED/REJECTED/REVISION_REQUESTED — sends a
// short follow-up message. Best-effort, never breaks the decision process.
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
        // The message may have been deleted/is no longer editable — still send the follow-up.
      }
    }

    const prefix =
      to === "APPROVED"
        ? "✅ Approved"
        : to === "REJECTED"
          ? "❌ Rejected"
          : to === "REVISION_REQUESTED"
            ? "✏️ Revision requested"
            : null;
    if (!prefix) return;

    const label = await resolveApprovalLabel(approval);
    const via = reviewedByUserId.startsWith("telegram:")
      ? " (via Telegram)"
      : "";
    await notifyProjectTelegram(
      approval.projectId,
      `${prefix}: ${label}${via}`,
    );
  } catch (error) {
    console.error(
      "Failed to send Telegram approval-decision notification:",
      error,
    );
  }
}
