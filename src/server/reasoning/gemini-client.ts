import "server-only";

import { getEnv } from "@/lib/env";
import { AgentelseError } from "@/server/security/errors";

// Google Gemini REST client — for ReasoningService's structured-output
// calls. No SDK dependency: schema-enforced JSON generation via the
// generateContent REST endpoint + `responseJsonSchema` (Gemini 2.5+
// accepts standard JSON Schema). Validation is still done by the caller's
// zod schema.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// fetch() has no default timeout in Node — a stalled connection (dead peer,
// network partition) hangs this call forever. Since the worker's tick loop
// awaits this synchronously with no timeout of its own further up the
// chain, one hung Gemini call used to be able to wedge the entire
// background worker permanently (every subsequent tick just re-awaits the
// same stuck promise). Bounding the request here is the fix.
const FETCH_TIMEOUT_MS = 45_000;

// Gemini returns 429/5xx during transient capacity spikes ("model is
// currently experiencing high demand") that normally clear within seconds.
// Without an in-process retry, every one of these blips surfaced as a full
// ReasoningService failure — which still charged the project's daily
// reasoningCalls budget (checkAndIncrement runs before the call even
// starts) and left the setup wizard stage FAILED until the orchestrator's
// next tick retried it from scratch. Retrying here resolves most blips
// inside the original call instead of burning a budget slot + a tick.
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// runGeminiText called with Gemini's native "Grounding with Google Search"
// tool enabled — the model runs its own web search and cites sources in
// groundingMetadata, no separate research step or browser automation is
// needed. This replaces a synchronous CLI browser session (tens of seconds
// to minutes per call) for public-web research capabilities with a single
// HTTP call.
export async function runGeminiWithSearchGrounding(input: {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  return runGeminiText({
    ...input,
    tools: [{ googleSearch: {} }],
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

  const body = JSON.stringify({
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
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/${input.model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      if (isLastAttempt) {
        if (isTimeout) {
          throw new AgentelseError(
            "TIMEOUT",
            `Gemini request timed out after ${FETCH_TIMEOUT_MS}ms`,
            { retryable: true },
          );
        }
        throw error;
      }
      // A connection-level failure (timeout, DNS, reset) is exactly as
      // transient as a 429/5xx — retry it the same way instead of failing
      // the whole reasoning call (and the setup stage it's part of) on the
      // very first network hiccup.
      await sleep(RETRY_DELAYS_MS[attempt] ?? 4_000);
      continue;
    }

    if (response.ok) {
      return (await response.json()) as GeminiResponse;
    }

    const payload = (await response.json().catch(() => ({}))) as GeminiResponse;
    if (!isRetryableStatus(response.status) || isLastAttempt) {
      throw new AgentelseError(
        response.status === 429 || response.status >= 500
          ? "PROVIDER_RATE_LIMITED"
          : "INVALID_PROVIDER_RESULT",
        `Gemini ${response.status}: ${payload.error?.message ?? "unknown error"}`,
        { retryable: isRetryableStatus(response.status) },
      );
    }

    await sleep(RETRY_DELAYS_MS[attempt] ?? 4_000);
  }

  // Unreachable — the loop always returns or throws — but keeps the
  // function's return type honest without a non-null assertion.
  throw new AgentelseError(
    "PROVIDER_RATE_LIMITED",
    "Gemini request failed after retries",
    { retryable: true },
  );
}

// MAX_TOKENS truncation mid-JSON has independently hit council-evaluation.ts
// (37% of prod calls), baseline-audit.ts (27%), constitution-synthesis.ts,
// department-recommendation.ts, signal-profile-recommendation.ts, and
// gemini-creative.provider.ts — five separate prompts, each fixed reactively
// by hand-raising that one prompt's maxTokens after the fact. Gemini's
// thinking tokens are deducted from the same budget, so even a small
// visible-output schema can get cut off on a "thinking" model — no prompt
// is safe from this by construction. Retrying once with double the budget
// closes the whole class at the source instead of waiting for the sixth
// incident to add another one-off token bump.
const MAX_TOKENS_RETRY_CEILING = 65_536;

export async function runGeminiStructured(
  input: {
    model: string;
    system: string;
    user: string;
    jsonSchema: unknown;
    maxOutputTokens: number;
    attachments?: GeminiInlineAttachment[];
  },
  maxOutputTokens = input.maxOutputTokens,
): Promise<GeminiStructuredResult> {
  const payload = await callGemini({
    model: input.model,
    system: input.system,
    user: input.user,
    attachments: input.attachments,
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: input.jsonSchema,
      maxOutputTokens,
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

  try {
    const raw: unknown = JSON.parse(text);
    return {
      raw,
      inputTokens: payload.usageMetadata?.promptTokenCount,
      outputTokens: payload.usageMetadata?.candidatesTokenCount,
    };
  } catch {
    if (
      candidate?.finishReason === "MAX_TOKENS" &&
      maxOutputTokens < MAX_TOKENS_RETRY_CEILING
    ) {
      return runGeminiStructured(
        input,
        Math.min(maxOutputTokens * 2, MAX_TOKENS_RETRY_CEILING),
      );
    }
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
}
