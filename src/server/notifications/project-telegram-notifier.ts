import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import { telegramSendMessage } from "@/server/integrations/telegram-client";

// Sends a message to the project's own Telegram connection
// (IntegrationCredential, provider="telegram"). Same "a notification
// failure must never break the actual operation" principle as the
// global/env-based system alerts in `telegram.service.ts`: if the project
// was never connected to Telegram, or the connection is REVOKED, this is a
// silent no-op; if sending fails, it's only logged.
export async function notifyProjectTelegram(
  projectId: string,
  text: string,
): Promise<void> {
  try {
    const credential = await prisma.integrationCredential.findFirst({
      where: { projectId, provider: "telegram", status: "ACTIVE" },
    });
    if (!credential) return;

    const metadata = (credential.metadata ?? {}) as { chatId?: string };
    if (!metadata.chatId) return;

    const token = decryptSecret(credential.encryptedSecret);
    await telegramSendMessage(token, metadata.chatId, text);
  } catch (error) {
    console.error("Failed to send project Telegram notification:", error);
  }
}
