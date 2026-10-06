// A direct HTTP call to the Telegram Bot API — no SDK required. Mirrors
// hubconnect's src/server/notifications/telegram.service.ts; duplicated
// here (not imported) because apps/marketing is a fully separate workspace
// with its own deploy and no shared package between the two.
//
// Plain text, never a parse mode: what a visitor typed is shown as typed and
// cannot break markup. Telegram takes at most 4096 characters per message,
// so a long text goes out as several messages, in order.

export type TelegramDelivery = "sent" | "not-configured" | "failed";

// Below Telegram's 4096, with room to spare.
export const TELEGRAM_TEXT_LIMIT = 4000;

// The text in pieces of at most `limit` characters, cut at a line break or a
// space when there is one in the second half of a piece, and never inside a
// surrogate pair (an emoji).
export function telegramChunks(
  text: string,
  limit = TELEGRAM_TEXT_LIMIT,
): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    let cut = breakAt > limit / 2 ? breakAt : limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// "not-configured": TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set on this
// deploy. "failed": Telegram refused a piece or could not be reached; the
// pieces after it are not sent.
export async function sendTelegramMessage(
  text: string,
): Promise<TelegramDelivery> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not-configured";

  try {
    for (const chunk of telegramChunks(text)) {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        },
      );
      if (!response.ok) {
        console.error(
          `Telegram notification failed: ${response.status} ${await response.text()}`,
        );
        return "failed";
      }
    }
    return "sent";
  } catch (error) {
    console.error("Failed to send Telegram notification:", error);
    return "failed";
  }
}
