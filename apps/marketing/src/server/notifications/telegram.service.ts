// A direct HTTP call to the Telegram Bot API — no SDK required. Mirrors
// hubconnect's src/server/notifications/telegram.service.ts; duplicated
// here (not imported) because apps/marketing is a fully separate workspace
// with its own deploy and no shared package between the two. If config is
// missing, it's a silent no-op: a missing optional integration must never
// break the contact form.
export async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
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
    console.error("Failed to send Telegram notification:", error);
  }
}
