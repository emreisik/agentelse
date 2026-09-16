import "server-only";

import { getEnv } from "@/lib/env";
import { AgentelseError } from "@/server/security/errors";

// OpenAI REST client — ReasoningService's optional second backend, mirroring
// gemini-client.ts one-to-one (same interface, same timeout/retry posture and
// the same AgentelseError taxonomy) so reasoning-service can switch between
// the two without the prompt files noticing. No SDK dependency: Chat
// Completions + `response_format: json_schema`. Validation is still done by
// the caller's zod schema.
//
// strict:false is deliberate — strict mode requires every property to be
// listed in `required` and rejects several shapes that z.toJSONSchema
// produces for the existing prompt schemas. Schema-guided (non-strict) output
// gives the same guarantee level as Gemini's responseJsonSchema, and the zod
// parse in reasoning-service remains the actual enforcement point.

const CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
// Kept in sync with gemini-client.ts's FETCH_TIMEOUT_MS — see its comment:
// a large bespoke generation (e.g. REPORTING) can legitimately take longer
// than 45s, and 2 minutes is still well inside the worker's 5-minute tick
// watchdog.
const FETCH_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type OpenAIStructuredResult = {
  raw: unknown;
  inputTokens?: number;
  outputTokens?: number;
};

export type OpenAIInlineAttachment = { mimeType: string; data: string };

export function isOpenAIConfigured(): boolean {
  return Boolean(getEnv().OPENAI_API_KEY);
}

export function openaiModelForTier(tier?: "lite" | "default" | "pro"): string {
  const env = getEnv();
  if (tier === "lite") return env.OPENAI_LITE_MODEL;
  if (tier === "pro") return env.OPENAI_PRO_MODEL;
  return env.OPENAI_MODEL;
}

type OpenAIResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

// Attachments map onto Chat Completions content parts: images as data-URI
// image_url, PDFs as file parts, text/* inlined as text. Anything else fails
// loudly — silently dropping an attachment would make the model answer
// without the context the user thinks it has.
function attachmentParts(
  attachments: OpenAIInlineAttachment[] | undefined,
): ContentPart[] {
  if (!attachments?.length) return [];
  return attachments.map((att): ContentPart => {
    if (att.mimeType.startsWith("image/")) {
      return {
        type: "image_url",
        image_url: { url: `data:${att.mimeType};base64,${att.data}` },
      };
    }
    if (att.mimeType === "application/pdf") {
      return {
        type: "file",
        file: {
          filename: "attachment.pdf",
          file_data: `data:application/pdf;base64,${att.data}`,
        },
      };
    }
    if (att.mimeType.startsWith("text/")) {
      return {
        type: "text",
        text: Buffer.from(att.data, "base64").toString("utf-8"),
      };
    }
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `OpenAI attachment type is not supported: ${att.mimeType}`,
    );
  });
}

async function callOpenAI(input: {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  attachments?: OpenAIInlineAttachment[];
  responseFormat?: unknown;
}): Promise<OpenAIResponse> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) {
    throw new AgentelseError(
      "PROVIDER_UNAVAILABLE",
      "OPENAI_API_KEY is not configured",
    );
  }

  const body = JSON.stringify({
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      {
        role: "user",
        // Attachments BEFORE the text — same ordering rationale as the
        // Gemini client: models reference attachments more reliably when
        // the instruction comes last in multi-modal input.
        content: [
          ...attachmentParts(input.attachments),
          { type: "text", text: input.user },
        ],
      },
    ],
    max_completion_tokens: input.maxOutputTokens,
    ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    let response: Response;
    try {
      response = await fetch(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
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
            `OpenAI request timed out after ${FETCH_TIMEOUT_MS}ms`,
            { retryable: true },
          );
        }
        throw error;
      }
      // A connection-level failure (timeout, DNS, reset) is exactly as
      // transient as a 429/5xx — retry it the same way instead of failing
      // the whole reasoning call on the very first network hiccup.
      await sleep(RETRY_DELAYS_MS[attempt] ?? 4_000);
      continue;
    }

    if (response.ok) {
      return (await response.json()) as OpenAIResponse;
    }

    const payload = (await response.json().catch(() => ({}))) as OpenAIResponse;
    if (!isRetryableStatus(response.status) || isLastAttempt) {
      throw new AgentelseError(
        response.status === 429 || response.status >= 500
          ? "PROVIDER_RATE_LIMITED"
          : "INVALID_PROVIDER_RESULT",
        `OpenAI ${response.status}: ${payload.error?.message ?? "unknown error"}`,
        { retryable: isRetryableStatus(response.status) },
      );
    }

    await sleep(RETRY_DELAYS_MS[attempt] ?? 4_000);
  }

  // Unreachable — the loop always returns or throws — but keeps the
  // function's return type honest without a non-null assertion.
  throw new AgentelseError(
    "PROVIDER_RATE_LIMITED",
    "OpenAI request failed after retries",
  );
}

// Mirrors gemini-client.ts's MAX_TOKENS_RETRY_CEILING — see that comment
// for the five-incident history this closes at the source instead of
// requiring a sixth prompt-specific token bump.
const MAX_TOKENS_RETRY_CEILING = 65_536;

export async function runOpenAIStructured(
  input: {
    model: string;
    system: string;
    user: string;
    jsonSchema: unknown;
    maxOutputTokens: number;
    attachments?: OpenAIInlineAttachment[];
  },
  maxOutputTokens = input.maxOutputTokens,
): Promise<OpenAIStructuredResult> {
  const payload = await callOpenAI({
    model: input.model,
    system: input.system,
    user: input.user,
    maxOutputTokens,
    attachments: input.attachments,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "reasoning_output",
        schema: input.jsonSchema,
        strict: false,
      },
    },
  });

  const choice = payload.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text) {
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `OpenAI returned no text (finish_reason: ${choice?.finish_reason ?? "none"})`,
    );
  }

  try {
    const raw: unknown = JSON.parse(text);
    return {
      raw,
      inputTokens: payload.usage?.prompt_tokens,
      outputTokens: payload.usage?.completion_tokens,
    };
  } catch {
    if (
      choice?.finish_reason === "length" &&
      maxOutputTokens < MAX_TOKENS_RETRY_CEILING
    ) {
      return runOpenAIStructured(
        input,
        Math.min(maxOutputTokens * 2, MAX_TOKENS_RETRY_CEILING),
      );
    }
    // Mirrors the Gemini client: finish_reason "length" plays the role of
    // MAX_TOKENS — the output was cut off mid-JSON and the fix is a higher
    // maxTokens on the prompt def, not a formatting change.
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `OpenAI returned non-JSON output despite response_format (finish_reason: ${
        choice?.finish_reason ?? "none"
      })`,
    );
  }
}
