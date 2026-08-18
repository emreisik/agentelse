"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import {
  TelegramApiError,
  telegramDeleteWebhook,
  telegramGetChat,
  telegramGetMe,
  telegramSendMessage,
} from "@/server/integrations/telegram-client";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Instead of showing Telegram's own error text verbatim, for a handful of
// known cases that trip up almost everyone during initial setup we add an
// actionable hint — the original error is still shown (never replaced with
// a made-up message), we just append a "what do I do now" answer.
function describeTelegramError(error: unknown): string {
  if (!(error instanceof TelegramApiError)) {
    return error instanceof Error ? error.message : "Operation failed";
  }
  const raw = error.message;
  const lower = raw.toLowerCase();
  if (lower.includes("chat not found")) {
    return (
      `Telegram: ${raw} — the bot can't see this chat. Did you add the bot ` +
      `as an admin to the target channel/group? @username doesn't work for ` +
      `private (non-public) channels/groups, you need the numeric ID ` +
      `(usually starting with "-100") — you can find the ID by forwarding a ` +
      `message from the target chat to @userinfobot.`
    );
  }
  if (lower.includes("unauthorized")) {
    return `Telegram: ${raw} — the bot token is invalid. Double-check the token you got from @BotFather.`;
  }
  if (
    lower.includes("bot was blocked") ||
    lower.includes("bot is not a member")
  ) {
    return `Telegram: ${raw} — the bot has been removed/blocked from this chat, you need to add it again.`;
  }
  return `Telegram: ${raw}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeTelegramError(error) };
}

// Users usually copy-paste the chat ID from somewhere (this app's own chat,
// notes, etc.) — source text formatting often converts a plain hyphen (-)
// into unicode characters that look identical but aren't recognized by
// Telegram's API, such as an en dash/em dash/minus sign; this causes a
// "chat not found" error with no visible difference. We normalize all known
// variants (hyphen/non-breaking hyphen/figure dash/en dash/em dash/
// horizontal bar/minus sign, U+2010..U+2015 and U+2212) to a plain ASCII
// hyphen. The character codes are written as hex escape sequences (\uXXXX)
// rather than as actual glyphs — so this regex's own source code doesn't
// fall victim to the very copy-paste corruption it's trying to prevent.
const DASH_CODE_POINTS = [
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212,
];
const DASH_VARIANTS_RE = new RegExp(
  `[${DASH_CODE_POINTS.map((cp) => String.fromCodePoint(cp)).join("")}]`,
  "g",
);

function normalizeChatId(value: string): string {
  return value.trim().replace(DASH_VARIANTS_RE, "-");
}

function parseAllowedApproverIds(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// Validates the token and chat id against Telegram's own API — if either one
// isn't actually working, nothing is saved; a fake "connected" state is
// never produced.
export async function connectTelegramAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const botToken = String(formData.get("botToken") ?? "").trim();
    const chatId = normalizeChatId(String(formData.get("chatId") ?? ""));
    const allowedApproverIds = parseAllowedApproverIds(
      String(formData.get("allowedApproverIds") ?? ""),
    );
    if (!botToken || !chatId) {
      return { ok: false, message: "Bot token and chat ID are required" };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const bot = await telegramGetMe(botToken);
    const chat = await telegramGetChat(botToken, chatId);
    // In case an old webhook exists, so it doesn't conflict with `getUpdates`
    // (the approval-button polling) — see
    // src/server/integrations/telegram-approval-poller.ts.
    await telegramDeleteWebhook(botToken);

    // We merge with the existing metadata instead of overwriting it
    // entirely — otherwise every reconnect would silently wipe the
    // `telegramUpdateOffset` written by the poller.
    const existing = await prisma.integrationCredential.findUnique({
      where: { projectId_provider: { projectId, provider: "telegram" } },
    });
    const existingMetadata = (existing?.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const metadata = {
      ...existingMetadata,
      chatId,
      chatTitle: chat.title ?? chat.username ?? chatId,
      allowedApproverIds,
    };

    const credential = await prisma.integrationCredential.upsert({
      where: { projectId_provider: { projectId, provider: "telegram" } },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        provider: "telegram",
        accountLabel: `@${bot.username}`,
        encryptedSecret: encryptSecret(botToken),
        metadata,
        status: "ACTIVE",
      },
      update: {
        accountLabel: `@${bot.username}`,
        encryptedSecret: encryptSecret(botToken),
        metadata,
        status: "ACTIVE",
      },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.connected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider: "telegram" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Unlike connectTelegramAction, this doesn't ask for a bot token — it only
// updates the approver list without touching the existing connection's
// already-validated credentials. This is a separate action so the user can
// simply say "let me add my own ID" without having the token on hand (e.g.
// weeks after initial setup) — calling connectTelegramAction again would
// require re-pasting the token.
export async function updateTelegramApproversAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const allowedApproverIds = parseAllowedApproverIds(
      String(formData.get("allowedApproverIds") ?? ""),
    );

    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await prisma.integrationCredential.findUnique({
      where: { projectId_provider: { projectId, provider: "telegram" } },
    });
    if (!credential) {
      return { ok: false, message: "Telegram connection not found" };
    }

    const existingMetadata = (credential.metadata ?? {}) as Record<
      string,
      unknown
    >;
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: { ...existingMetadata, allowedApproverIds } },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function sendTelegramTestMessageAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await prisma.integrationCredential.findFirst({
      where: { projectId, provider: "telegram" },
    });
    if (!credential) {
      return { ok: false, message: "Telegram connection not found" };
    }
    const metadata = (credential.metadata ?? {}) as { chatId?: string };
    if (!metadata.chatId) {
      return { ok: false, message: "No chat ID is saved" };
    }

    const token = decryptSecret(credential.encryptedSecret);
    await telegramSendMessage(
      token,
      metadata.chatId,
      "✅ Agentelse test message — this integration is working.",
    );

    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function disconnectTelegramAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const credential = await prisma.integrationCredential.findFirst({
      where: { projectId, provider: "telegram" },
    });
    if (!credential) return { ok: true };

    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { status: "REVOKED" },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.disconnected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider: "telegram" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
