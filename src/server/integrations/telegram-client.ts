import "server-only";

import { metaWorkExcludedHere } from "@/lib/local-worker-policy";

// A thin, real Telegram Bot API wrapper — no SDK, plain `fetch` (same
// pattern as openai-image-client.ts and the OpenClaw clients). No mock:
// every call is a real HTTP request, and on failure it throws an error
// carrying Telegram's own `description` text.

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 8_000;

export class TelegramApiError extends Error {}

type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; description: string; error_code: number };

// We accept an optional timeout override because `getUpdates` long-polling
// may need to keep Telegram open for `timeoutMs` — otherwise the default
// 8s prevents a hung network request from delaying the sequential tick
// chain in `agency-wiring.ts`.
// Canlı veritabanını paylaşan yerel geliştirme süreci gerçek kullanıcılara
// mesaj göndermez ve canlı onay güncellemelerini (getUpdates) tüketmez
// (docs/meta-ads-plan.md F0b, K19). Bağlantı denemesi (getMe) serbesttir.
const DEV_BLOCKED_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "editMessageText",
  "editMessageReplyMarkup",
  "deleteMessage",
  "answerCallbackQuery",
  "getUpdates",
]);

function blockedInLocalDevelopment(path: string): boolean {
  const method = path.split("?")[0] ?? path;
  return (
    DEV_BLOCKED_METHODS.has(method) &&
    process.env.ALLOW_DEV_NOTIFICATIONS !== "true" &&
    metaWorkExcludedHere(process.env)
  );
}

async function request<T>(
  token: string,
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (blockedInLocalDevelopment(path)) {
    throw new TelegramApiError(
      "Telegram messages are off in local development against the shared database (set ALLOW_DEV_NOTIFICATIONS=true to allow).",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${path}`, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new TelegramApiError(
      isAbort
        ? `Telegram API request timed out (${timeoutMs}ms)`
        : `Could not reach Telegram API: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: TelegramResponse<T>;
  try {
    body = (await res.json()) as TelegramResponse<T>;
  } catch {
    throw new TelegramApiError(
      `Telegram API returned an unexpected response (HTTP ${res.status})`,
    );
  }
  if (!body.ok) {
    throw new TelegramApiError(body.description || "Telegram API error");
  }
  return body.result;
}

export type TelegramBotInfo = {
  id: number;
  username: string;
  first_name: string;
};

// Whether the token is actually valid and which bot it belongs to — the
// first verification step when establishing the connection.
export function telegramGetMe(token: string): Promise<TelegramBotInfo> {
  return request<TelegramBotInfo>(token, "getMe");
}

export type TelegramChatInfo = {
  id: number;
  title?: string;
  username?: string;
  type: string;
};

// Whether the bot can actually see this chat (whether it's been added to
// the channel/group) — chatId can be either a numeric id
// (`-1001234567890`) or a public channel username (`@channelname`);
// Telegram's own API accepts both.
export function telegramGetChat(
  token: string,
  chatId: string,
): Promise<TelegramChatInfo> {
  const qs = new URLSearchParams({ chat_id: chatId });
  return request<TelegramChatInfo>(token, `getChat?${qs.toString()}`);
}

export type TelegramInlineKeyboardButton =
  | { text: string; callback_data: string }
  // Uygulamaya açılan bağlantı düğmesi (ör. L4 onayı için "Review in
  // Agentelse"); geri çağrı üretmez.
  | { text: string; url: string };
export type TelegramReplyMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export function telegramSendMessage(
  token: string,
  chatId: string,
  text: string,
  options?: { replyMarkup?: TelegramReplyMarkup },
): Promise<{ message_id: number }> {
  return request<{ message_id: number }>(token, "sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: options?.replyMarkup,
    }),
  });
}

// For showing the image (the Creative asset) in approval requests — the
// caller already has the file as bytes (via asset-storage.ts's readAsset,
// disk or R2), not a URL, so we upload it as byte content via
// multipart/form-data.
export function telegramSendPhoto(
  token: string,
  chatId: string,
  photo: Buffer,
  filename: string,
  options?: { caption?: string; replyMarkup?: TelegramReplyMarkup },
): Promise<{ message_id: number }> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (options?.caption) form.append("caption", options.caption);
  if (options?.replyMarkup) {
    form.append("reply_markup", JSON.stringify(options.replyMarkup));
  }
  form.append("photo", new Blob([new Uint8Array(photo)]), filename);
  return request<{ message_id: number }>(token, "sendPhoto", {
    method: "POST",
    body: form,
  });
}

export function telegramEditMessageReplyMarkup(
  token: string,
  chatId: string,
  messageId: number,
  replyMarkup: TelegramReplyMarkup | null,
): Promise<unknown> {
  return request(token, "editMessageReplyMarkup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    }),
  });
}

export type TelegramCallbackQuery = {
  id: string;
  data?: string;
  from: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number } };
};

export type TelegramUpdate = {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
};

// Long-polling: we don't have infrastructure for a publicly reachable prod
// URL/signature verification for a webhook, so we listen for approval
// button presses via `getUpdates` (as a new step on the existing 3s tick
// in agency-wiring.ts). `timeoutSeconds=0` = a short/non-blocking poll, so
// it doesn't block the tick chain.
export function telegramGetUpdates(
  token: string,
  offset?: number,
  timeoutSeconds = 0,
): Promise<TelegramUpdate[]> {
  const qs = new URLSearchParams({
    timeout: String(timeoutSeconds),
    allowed_updates: JSON.stringify(["callback_query"]),
  });
  if (offset !== undefined) qs.set("offset", String(offset));
  return request<TelegramUpdate[]>(
    token,
    `getUpdates?${qs.toString()}`,
    undefined,
    (timeoutSeconds + 5) * 1000,
  );
}

export function telegramAnswerCallbackQuery(
  token: string,
  callbackQueryId: string,
  options?: { text?: string; showAlert?: boolean },
): Promise<true> {
  return request<true>(token, "answerCallbackQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: options?.text,
      show_alert: options?.showAlert ?? false,
    }),
  });
}

// Called once when establishing the connection — a leftover old webhook,
// if any, would cause `getUpdates` to fail with "Conflict: can't use
// getUpdates while webhook is active", so we proactively clear it.
export function telegramDeleteWebhook(token: string): Promise<true> {
  return request<true>(token, "deleteWebhook");
}
