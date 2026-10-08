import "server-only";

import OpenAI from "openai";

import { getEnv } from "@/lib/env";
import { recordUsage } from "@/server/billing/usage-recorder";
import { toAgentelseError } from "@/server/chat/openai-chat-client";
import { priceReasoningCall } from "@/server/reasoning/reasoning-pricing";
import { AgentelseError } from "@/server/security/errors";

import type {
  OpenAIInlineAttachment,
  OpenAIStructuredResult,
} from "./openai-client";

// Structured reasoning WITH live web search. The plain structured path
// (openai-client.ts, Chat Completions) cannot search: OpenAI's hosted
// web_search tool only exists on the Responses API. This is the same contract
// as runOpenAIStructured (system + user in, schema-shaped JSON out, token
// counts back), so ReasoningService keeps ONE place for budgets, cost, audit
// and the mock switch; only the transport differs. It additionally reports how
// many searches the model ran, because each one is billed on top of tokens.
//
// Not a general research client: one bounded call, no streaming, no tool loop
// of ours. The model decides how many searches it needs, inside the request.

// The model may browse before answering, so this is generous, but it must end.
const REQUEST_TIMEOUT_MS = 100_000;
// Fewer retries than the chat client: a retried search-and-think call is
// expensive, and callers that need an answer quickly race a deadline anyway.
const MAX_RETRIES = 1;
const MAX_TOKENS_RETRY_CEILING = 65_536;

let client: OpenAI | undefined;

function getClient(): OpenAI {
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) {
    throw new AgentelseError(
      "PROVIDER_UNAVAILABLE",
      "OPENAI_API_KEY is not configured",
    );
  }
  client ??= new OpenAI({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
  return client;
}

// `reasoning` is only accepted by the reasoning model families; sending it to
// another model is a 400. Search is not available at "minimal" effort.
function supportsReasoning(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

type SearchResponse = {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  } | null;
  output: Array<{ type: string }>;
};

// Her Responses çağrısı (kesik yanıtla yeniden deneme dahil) kendi satırını
// yazar; web_search çağrıları token üstüne ayrıca faturalanır.
async function meterSearchCall(
  model: string,
  startedAt: number,
  response: SearchResponse,
): Promise<{ cachedTokens?: number; webSearchCalls: number }> {
  const inputTokens = response.usage?.input_tokens;
  const outputTokens = response.usage?.output_tokens;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;
  const webSearchCalls = response.output.filter(
    (item) => item.type === "web_search_call",
  ).length;
  const priced = priceReasoningCall({
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    webSearchCalls,
  });
  await recordUsage({
    kind: "SEARCH",
    provider: "openai",
    model,
    costUsd: priced.costUsd,
    costEstimated: priced.estimated,
    success: true,
    durationMs: Date.now() - startedAt,
    inputTokens,
    outputTokens,
    cachedTokens,
    webSearchCalls,
  });
  return { cachedTokens, webSearchCalls };
}

// Zaman aşımı/ağ/5xx'te sağlayıcı işi yapmış olabilir (kullanım bilinmez):
// 0 USD, tahmini işaretli satır. 4xx istek hatası faturalanmaz, yazılmaz.
async function meterSearchFailure(
  model: string,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status === "number" && status < 500) return;
  await recordUsage({
    kind: "SEARCH",
    provider: "openai",
    model,
    costUsd: 0,
    costEstimated: true,
    success: false,
    errorCode: typeof status === "number" ? String(status) : "NETWORK",
    durationMs: Date.now() - startedAt,
  });
}

// Free-text report WITH live web search, for the research execution
// capabilities (OpenAiAiProvider). Same transport and limits as the structured
// variant below, but no schema: the report is turned into findings later by
// ResultMaterializer, which reads rawResult.text.
export async function runOpenAITextWithSearch(
  input: {
    model: string;
    system: string;
    user: string;
    maxOutputTokens: number;
  },
  maxOutputTokens = input.maxOutputTokens,
): Promise<{
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  webSearchCalls: number;
}> {
  let response;
  const startedAt = Date.now();
  try {
    response = await getClient().responses.create({
      model: input.model,
      instructions: input.system,
      input: input.user,
      tools: [{ type: "web_search" }],
      max_output_tokens: maxOutputTokens,
      store: false,
      ...(supportsReasoning(input.model)
        ? { reasoning: { effort: "low" as const } }
        : {}),
    });
  } catch (error) {
    await meterSearchFailure(input.model, startedAt, error);
    throw toAgentelseError(error);
  }
  const metered = await meterSearchCall(input.model, startedAt, response);

  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens" &&
    maxOutputTokens < MAX_TOKENS_RETRY_CEILING
  ) {
    return runOpenAITextWithSearch(
      input,
      Math.min(maxOutputTokens * 2, MAX_TOKENS_RETRY_CEILING),
    );
  }

  const text = (response.output_text ?? "").trim();
  if (!text) {
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `OpenAI returned no text (status: ${response.status ?? "unknown"})`,
    );
  }

  return {
    text,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    cachedTokens: metered.cachedTokens,
    webSearchCalls: metered.webSearchCalls,
  };
}

export async function runOpenAIStructuredWithSearch(
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
  // The Responses input here is plain text. Refuse rather than quietly answer
  // without a file the caller believes the model can see.
  if (input.attachments?.length) {
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      "Web-search reasoning does not take attachments",
    );
  }

  let response;
  const startedAt = Date.now();
  try {
    response = await getClient().responses.create({
      model: input.model,
      instructions: input.system,
      input: input.user,
      tools: [{ type: "web_search" }],
      max_output_tokens: maxOutputTokens,
      // Stateless, like the chat agent: nothing is kept on OpenAI's side.
      store: false,
      ...(supportsReasoning(input.model)
        ? { reasoning: { effort: "low" as const } }
        : {}),
      text: {
        format: {
          type: "json_schema",
          name: "reasoning_output",
          // Same deliberate strict:false as the Chat Completions path: strict
          // mode rejects shapes z.toJSONSchema produces; the caller's zod
          // parse is the real enforcement.
          schema: input.jsonSchema as Record<string, unknown>,
          strict: false,
        },
      },
    });
  } catch (error) {
    await meterSearchFailure(input.model, startedAt, error);
    throw toAgentelseError(error);
  }
  const metered = await meterSearchCall(input.model, startedAt, response);

  // The token budget covers hidden reasoning plus the JSON. A cut-off answer is
  // unparseable, so retry once with a bigger budget (same idea as the
  // Chat Completions path).
  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens" &&
    maxOutputTokens < MAX_TOKENS_RETRY_CEILING
  ) {
    return runOpenAIStructuredWithSearch(
      input,
      Math.min(maxOutputTokens * 2, MAX_TOKENS_RETRY_CEILING),
    );
  }

  const text = (response.output_text ?? "").trim();
  if (!text) {
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `OpenAI returned no text (status: ${response.status ?? "unknown"})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      "OpenAI returned a search answer that is not valid JSON",
    );
  }

  return {
    raw,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    cachedTokens: metered.cachedTokens,
    webSearchCalls: metered.webSearchCalls,
  };
}
