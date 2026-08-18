import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import { telegramSendMessage } from "@/server/integrations/telegram-client";

// Projenin kendi Telegram bağlantısına (IntegrationCredential, provider=
// "telegram") bir mesaj gönderir. `telegram.service.ts`'teki global/env
// tabanlı sistem uyarılarıyla aynı "bildirim hatası asıl işlemi asla
// bozmamalı" prensibi: proje Telegram'a hiç bağlanmamışsa veya bağlantı
// REVOKED ise sessizce no-op, gönderim başarısız olursa sadece log.
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
    console.error("Proje Telegram bildirimi gönderilemedi:", error);
  }
}
