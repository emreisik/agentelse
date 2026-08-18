import "server-only";

import { getEnv, isIntegrationConfigured } from "@/lib/env";

// Telegram Bot API'ye doğrudan HTTP çağrısı — SDK gerektirmiyor. Yapılandırma
// eksikse (bkz. env.ts) sessizce no-op: opsiyonel entegrasyonların hiçbiri
// eksik olduğunda sistemi kıramaz.
export async function sendTelegramMessage(text: string): Promise<void> {
  if (!isIntegrationConfigured("TELEGRAM")) return;

  const env = getEnv();
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      },
    );
    if (!response.ok) {
      console.error(
        `Telegram bildirimi başarısız: ${response.status} ${await response.text()}`,
      );
    }
  } catch (error) {
    // Bildirim altyapısının çökmesi asıl işlemi asla bozmamalı.
    console.error("Telegram bildirimi gönderilemedi:", error);
  }
}
