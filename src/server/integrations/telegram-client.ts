import "server-only";

// İnce, gerçek Telegram Bot API sarmalayıcısı — SDK yok, düz `fetch`
// (gemini-image-client.ts ve OpenClaw client'larıyla aynı desen). Mock
// yok: her çağrı gerçek bir HTTP isteği, başarısızlıkta Telegram'ın kendi
// `description` metnini taşıyan bir hata fırlatır.

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 8_000;

export class TelegramApiError extends Error {}

type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; description: string; error_code: number };

// `getUpdates` uzun-polling'de Telegram'ı `timeoutMs` kadar açık tutmamız
// gerekebileceği için isteğe bağlı bir timeout override'ı kabul ediyoruz —
// aksi halde varsayılan 8sn, `agency-wiring.ts`'teki sıralı tick zincirini
// asılı kalmış bir ağ isteğiyle geciktirmeyi engelliyor.
async function request<T>(
  token: string,
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
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
        ? `Telegram API isteği zaman aşımına uğradı (${timeoutMs}ms)`
        : `Telegram API'ye ulaşılamadı: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: TelegramResponse<T>;
  try {
    body = (await res.json()) as TelegramResponse<T>;
  } catch {
    throw new TelegramApiError(
      `Telegram API beklenmeyen bir yanıt döndürdü (HTTP ${res.status})`,
    );
  }
  if (!body.ok) {
    throw new TelegramApiError(body.description || "Telegram API hatası");
  }
  return body.result;
}

export type TelegramBotInfo = {
  id: number;
  username: string;
  first_name: string;
};

// Token gerçekten geçerli mi, hangi bota ait — bağlantı kurulurken ilk
// doğrulama adımı.
export function telegramGetMe(token: string): Promise<TelegramBotInfo> {
  return request<TelegramBotInfo>(token, "getMe");
}

export type TelegramChatInfo = {
  id: number;
  title?: string;
  username?: string;
  type: string;
};

// Bot bu sohbeti gerçekten görebiliyor mu (kanala/gruba eklenmiş mi) —
// chatId hem sayısal id (`-1001234567890`) hem herkese açık kanal
// kullanıcı adı (`@kanaladi`) olabilir, Telegram'ın kendi API'si ikisini
// de kabul ediyor.
export function telegramGetChat(
  token: string,
  chatId: string,
): Promise<TelegramChatInfo> {
  const qs = new URLSearchParams({ chat_id: chatId });
  return request<TelegramChatInfo>(token, `getChat?${qs.toString()}`);
}

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};
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

// Onay isteklerinde görseli (Creative asset'i) göstermek için — dosya
// zaten sunucunun yerel diskinde (storage/assets/), bir URL değil, bu
// yüzden multipart/form-data ile byte içeriği olarak yüklüyoruz.
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

// Long-polling: webhook için genel erişilebilir bir prod URL/imza
// doğrulama altyapımız yok, bu yüzden onay butonlarını `getUpdates` ile
// (agency-wiring.ts'teki mevcut 3sn'lik tick'e yeni bir adım olarak)
// dinliyoruz. `timeoutSeconds=0` = kısa/non-blocking poll, tick zincirini
// bloke etmesin diye.
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

// Bağlantı kurulurken bir kez çağrılır — olası eski bir webhook varsa
// `getUpdates` ile "Conflict: can't use getUpdates while webhook is
// active" hatasına yol açar, bu yüzden proaktif olarak temizliyoruz.
export function telegramDeleteWebhook(token: string): Promise<true> {
  return request<true>(token, "deleteWebhook");
}
