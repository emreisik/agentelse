import "server-only";

import { getEnv } from "@/lib/env";
import { AgentelseError } from "@/server/security/errors";

// Google Gemini REST client — for ReasoningService's structured-output
// calls. No SDK dependency: schema-enforced JSON generation via the
// generateContent REST endpoint + `responseJsonSchema` (Gemini 2.5+
// accepts standard JSON Schema). Validation is still done by the caller's
// zod schema.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiStructuredResult = {
  raw: unknown;
  inputTokens?: number;
  outputTokens?: number;
};

// A file attached to the user's prompt (image, PDF, plain text). Sent as a
// Gemini `inlineData` part; since the base64 body is subject to the 20 MB
// request limit, the caller is responsible for trimming the size.
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

// Plain-text generation — for the task execution provider (GeminiAiProvider).
// The only difference from the structured call is generationConfig: no
// schema, returns free-form text.
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
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `Gemini returned no text (finishReason: ${candidate?.finishReason ?? "none"})`,
    );
  }

  return {
    text,
    inputTokens: payload.usageMetadata?.promptTokenCount,
    outputTokens: payload.usageMetadata?.candidatesTokenCount,
  };
}

// runGeminiText called with the `urlContext` tool enabled — the model
// fetches and reads the given URL on its own side, no separate
// fetch/scrape step is needed (the Gemini equivalent of Anthropic's
// web_fetch tool).
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
    throw new AgentelseError(
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
          // Attachments BEFORE the text: models reference attachments more
          // reliably when they see the instruction last in multi-modal
          // input (the same ordering is used for image editing too).
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
    throw new AgentelseError(
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
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `Gemini returned no text (finishReason: ${candidate?.finishReason ?? "none"})`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Include the finishReason in the message: if it's MAX_TOKENS, the
    // problem isn't the model's formatting but the response being cut off,
    // and the fix is to increase the prompt's maxTokens. Without
    // distinguishing the two, this used to get debugged in the wrong place.
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `Gemini returned non-JSON output despite responseMimeType (finishReason: ${
        candidate?.finishReason ?? "none"
      })`,
    );
  }

  return {
    raw,
    inputTokens: payload.usageMetadata?.promptTokenCount,
    outputTokens: payload.usageMetadata?.candidatesTokenCount,
  };
}
