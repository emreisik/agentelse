import "server-only";

import { getEnv, isIntegrationConfigured } from "@/lib/env";

// A direct HTTP call to the Telegram Bot API — no SDK required. If
// configuration is missing (see env.ts), it's a silent no-op: a missing
// optional integration must never break the system.
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
        `Telegram notification failed: ${response.status} ${await response.text()}`,
      );
    }
  } catch (error) {
    // A crash in the notification infrastructure must never break the actual operation.
    console.error("Failed to send Telegram notification:", error);
  }
}
