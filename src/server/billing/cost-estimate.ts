import "server-only";

import { priceReasoningCall } from "@/server/reasoning/reasoning-pricing";

import { usdToMicros } from "./usage-recorder";

// Rezervasyon büyüklüğü: bir ücretli operasyonun AZAMİ maliyet tahmini. Gerçek
// tutar sonradan mahsup edilir (settle); burası "başlamadan önce bakiyeden ne
// ayrılsın" sorusunun cevabıdır. Tahmin gerçeğin ÜSTÜNDE olmalı (az ayırmak
// paralel işlerin aynı bakiyeyi iki kez tüketmesine yol açar), ama pratik
// tavan değil: yeniden-deneme ikiye katlaması (65k token) ve sınırsız web
// araması rezervasyona DAHİL DEĞİLDİR — aşım settle'da serbest kapasiteden ya
// da dönem borcundan karşılanır (docs/billing-quota.md).

// Girdi token'ı için karakter başına token (muhafazakâr: gerçek ≈ 4 karakter/token).
const CHARS_PER_TOKEN = 3;

// Marka bağlamı (JSON) ve sistem istemi tahmin zamanında bilinmez; tipik bağlam
// 2-6k karakterdir, bu pay en kötü durumu örter.
export const PROMPT_OVERHEAD_CHARS = 24_000;

// Tahmin edilen web araması sayısı (araç çağrısı sınırı yok; bkz. üstteki not).
export const ASSUMED_SEARCH_CALLS = 3;

export function estimateTextCallCostUsd(input: {
  model: string;
  inputChars: number;
  maxOutputTokens: number;
  searchCalls?: number;
}): number {
  return priceReasoningCall({
    model: input.model,
    inputTokens: Math.ceil(Math.max(0, input.inputChars) / CHARS_PER_TOKEN),
    outputTokens: Math.max(0, Math.floor(input.maxOutputTokens)),
    webSearchCalls: input.searchCalls ?? 0,
  }).costUsd;
}

export function estimateTextCallMicros(
  input: Parameters<typeof estimateTextCallCostUsd>[0],
): bigint {
  return usdToMicros(estimateTextCallCostUsd(input));
}

// Text length of a model conversation for the estimate. A file the person attached
// travels as a base64 data URL; counting its characters as text would turn one photo
// into hundreds of thousands of "tokens" and refuse every chat that has a picture.
// A file counts as a fixed amount instead (a picture is roughly 1-2k tokens).
const FILE_CHARS = 6_000;
const MAX_DEPTH = 10;

export function conversationChars(value: unknown, depth = 0): number {
  if (typeof value === "string") {
    return value.startsWith("data:") ? FILE_CHARS : value.length;
  }
  if (!value || typeof value !== "object" || depth > MAX_DEPTH) return 0;
  let total = 0;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    total += conversationChars(item, depth + 1);
  }
  return total;
}

export function estimateChatRoundMicros(input: {
  model: string;
  instructions: string;
  conversation: unknown;
  maxOutputTokens: number;
  webSearch: boolean;
}): bigint {
  return estimateTextCallMicros({
    model: input.model,
    inputChars:
      input.instructions.length + conversationChars(input.conversation),
    maxOutputTokens: input.maxOutputTokens,
    searchCalls: input.webSearch ? ASSUMED_SEARCH_CALLS : 0,
  });
}
