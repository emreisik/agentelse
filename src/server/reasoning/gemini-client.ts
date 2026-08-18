import "server-only";

import { getEnv } from "@/lib/env";
import { HubConnectError } from "@/server/security/errors";

// Google Gemini REST istemcisi — ReasoningService'in yapılandırılmış çıktı
// çağrıları için. SDK bağımlılığı yok: generateContent REST ucu +
// `responseJsonSchema` (Gemini 2.5+ standart JSON Schema kabul eder) ile
// şema-zorlamalı JSON üretimi. Doğrulama yine çağıran taraftaki zod
// şemasıyla yapılır.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiStructuredResult = {
  raw: unknown;
  inputTokens?: number;
  outputTokens?: number;
};

// Kullanıcının prompt'una eklediği dosya (görsel, PDF, düz metin). Gemini
// `inlineData` part'ı olarak gönderilir; base64 gövde 20 MB'lık istek
// sınırına tabi olduğu için çağıran taraf boyutu kırpmakla yükümlüdür.
export type GeminiInlineAttachment = { mimeType: string; data: string };

export function isGeminiConfigured(): boolean {
  return Boolean(getEnv().GEMINI_API_KEY);
}

export function geminiModel(): string {
  return getEnv().GEMINI_MODEL;
}

export function geminiModelForTier(tier?: "lite" | "default" | "pro"): string {
  const env = getEnv();
  if (tier === "lite") return env.GEMINI_LITE_MODEL;
  if (tier === "pro") return env.GEMINI_PRO_MODEL;
  return env.GEMINI_MODEL;
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
};

// Düz metin üretimi — görev yürütme sağlayıcısı (GeminiAiProvider) için.
// Yapılandırılmış çağrıdan farkı yalnızca generationConfig: şema yok,
// serbest metin döner.
export async function runGeminiText(input: {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  tools?: Record<string, unknown>[];
}): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  const payload = await callGemini({
    model: input.model,
    system: input.system,
    user: input.user,
    generationConfig: { maxOutputTokens: input.maxOutputTokens },
    tools: input.tools,
  });

  const candidate = payload.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new HubConnectError(
      "INVALID_PROVIDER_RESULT",
      `Gemini returned no text (finishReason: ${candidate?.finishReason ?? "yok"})`,
    );
  }

  return {
    text,
    inputTokens: payload.usageMetadata?.promptTokenCount,
    outputTokens: payload.usageMetadata?.candidatesTokenCount,
  };
}

// `urlContext` tool'u etkinken çağrılan runGeminiText — model verilen
// URL'yi kendi tarafında getirip okur, ayrı bir fetch/scrape adımına gerek
// kalmaz (Anthropic'in web_fetch tool'unun Gemini eşdeğeri).
export async function runGeminiWithUrlContext(input: {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  return runGeminiText({
    ...input,
    tools: [{ urlContext: {} }],
  });
}

async function callGemini(input: {
  model: string;
  system: string;
  user: string;
  generationConfig: Record<string, unknown>;
  tools?: Record<string, unknown>[];
  attachments?: GeminiInlineAttachment[];
}): Promise<GeminiResponse> {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) {
    throw new HubConnectError(
      "PROVIDER_UNAVAILABLE",
      "GEMINI_API_KEY is not configured",
    );
  }

  const response = await fetch(`${BASE_URL}/${input.model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [
        {
          role: "user",
          // Ekler metinden ÖNCE: modeller çok modlu girdide talimatı en
          // sonda gördüklerinde eklere daha güvenilir atıfta bulunuyor
          // (görsel düzenlemede de aynı sıra kullanılıyor).
          parts: [
            ...(input.attachments ?? []).map((attachment) => ({
              inlineData: {
                mimeType: attachment.mimeType,
                data: attachment.data,
              },
            })),
            { text: input.user },
          ],
        },
      ],
      generationConfig: input.generationConfig,
      ...(input.tools ? { tools: input.tools } : {}),
    }),
  });

  const payload = (await response.json()) as GeminiResponse;
  if (!response.ok) {
    throw new HubConnectError(
      "INVALID_PROVIDER_RESULT",
      `Gemini ${response.status}: ${payload.error?.message ?? "unknown error"}`,
    );
  }
  return payload;
}

export async function runGeminiStructured(input: {
  model: string;
  system: string;
  user: string;
  jsonSchema: unknown;
  maxOutputTokens: number;
  attachments?: GeminiInlineAttachment[];
}): Promise<GeminiStructuredResult> {
  const payload = await callGemini({
    model: input.model,
    system: input.system,
    user: input.user,
    attachments: input.attachments,
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: input.jsonSchema,
      maxOutputTokens: input.maxOutputTokens,
    },
  });

  const candidate = payload.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (!text) {
    throw new HubConnectError(
      "INVALID_PROVIDER_RESULT",
      `Gemini returned no text (finishReason: ${candidate?.finishReason ?? "yok"})`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // finishReason'ı mesaja koy: MAX_TOKENS ise sorun modelin biçimi değil,
    // yanıtın ortadan kesilmesidir ve çözümü prompt'un maxTokens'ını
    // artırmaktır. İkisi ayırt edilemeyince yanlış yerde aranıyordu.
    throw new HubConnectError(
      "INVALID_PROVIDER_RESULT",
      `Gemini returned non-JSON output despite responseMimeType (finishReason: ${
        candidate?.finishReason ?? "yok"
      })`,
    );
  }

  return {
    raw,
    inputTokens: payload.usageMetadata?.promptTokenCount,
    outputTokens: payload.usageMetadata?.candidatesTokenCount,
  };
}
