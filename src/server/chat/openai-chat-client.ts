import "server-only";

import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";

import { getEnv } from "@/lib/env";
import { AgentelseError } from "@/server/security/errors";

import type { ChatModel, ChatModelEvent, ChatModelRequest } from "./types";

// Streaming OpenAI Responses API backend of the chat agent. Deliberately
// separate from the reasoning openai-client.ts (raw fetch, Chat Completions,
// structured JSON): the chat needs token streaming and function calling, both
// of which the official SDK gives us without hand-written SSE parsing.
//
// Stateless on purpose (store:false): the database is the conversation's
// source of truth, so nothing is kept on OpenAI's side and history is rebuilt
// from Command rows on every turn (history.ts).

// A turn can legitimately think for a while before the first token, but the
// stream must never hang forever.
const REQUEST_TIMEOUT_MS = 120_000;
// The SDK retries connection-level failures and 429/5xx with backoff BEFORE
// the stream starts. Once tokens flow we never retry: a replay would
// duplicate text the client already saw.
const MAX_RETRIES = 3;

export function isChatModelConfigured(): boolean {
  return Boolean(getEnv().OPENAI_API_KEY);
}

// A real model id is a single token like "gpt-5.6-luna" or "o4-mini". A value
// with spaces/commas/equals signs is a broken .env line (e.g. two variables
// glued together), which would otherwise only surface as a confusing OpenAI
// 404 "model does not exist" — fall back to the default model and say why.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function chatModelName(): string {
  const env = getEnv();
  const configured = env.CHAT_MODEL.trim();
  if (!configured) return env.OPENAI_MODEL;
  if (!MODEL_ID.test(configured)) {
    console.warn(
      `[chat] CHAT_MODEL ${JSON.stringify(configured)} is not a valid model id (check .env for a line broken/merged with another); using OPENAI_MODEL.`,
    );
    return env.OPENAI_MODEL;
  }
  return configured;
}

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

// `reasoning` is only accepted by the reasoning model families (gpt-5.x,
// o-series); sending it to e.g. gpt-4.1 is a 400.
function supportsReasoning(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

// Maps SDK failures onto the AgentelseError codes the rest of the app (and
// limitNoticeFromError) already understands, so a chat failure renders the
// same limit-notice cards as a reasoning failure does.
export function toAgentelseError(error: unknown): unknown {
  if (error instanceof AgentelseError) return error;
  if (error instanceof OpenAI.APIUserAbortError) {
    return new AgentelseError("CANCELLED", "Chat request was aborted");
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AgentelseError(
      "TIMEOUT",
      `OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms`,
      { retryable: true },
    );
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    // An exhausted quota is a billing problem to fix on the deployment, not
    // a transient rate limit worth telling the user to retry.
    if (error.code === "insufficient_quota") {
      return new AgentelseError(
        "PROVIDER_UNAVAILABLE",
        `OpenAI quota exhausted: ${error.message}`,
      );
    }
    if (status === 401 || status === 403) {
      return new AgentelseError(
        "PROVIDER_UNAVAILABLE",
        `OpenAI ${status}: ${error.message}`,
      );
    }
    if (status === 429 || (status !== undefined && status >= 500)) {
      return new AgentelseError(
        "PROVIDER_RATE_LIMITED",
        `OpenAI ${status}: ${error.message}`,
        { retryable: true },
      );
    }
    return new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `OpenAI ${status ?? "error"}: ${error.message}`,
    );
  }
  return error;
}

export const openaiChatModel: ChatModel = {
  async *stream(request: ChatModelRequest): AsyncGenerator<ChatModelEvent> {
    try {
      const stream = await getClient().responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input: request.input,
          tools: request.tools,
          tool_choice: "auto",
          // One tool call per model turn: keeps the "at most one side-effect
          // per chat turn" invariant enforceable and the tool.start/end
          // events strictly sequential.
          parallel_tool_calls: false,
          store: false,
          stream: true,
          max_output_tokens: request.maxOutputTokens,
          ...(supportsReasoning(request.model)
            ? {
                reasoning: { effort: request.effort },
                // Stateless reasoning models need their encrypted reasoning
                // items handed back after a tool call.
                include: ["reasoning.encrypted_content" as const],
              }
            : {}),
        },
        { signal: request.signal },
      );

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text.delta", text: event.delta };
        } else if (event.type === "response.failed") {
          const message = event.response.error?.message ?? "unknown error";
          throw new AgentelseError(
            "PROVIDER_RATE_LIMITED",
            `OpenAI response failed: ${message}`,
            { retryable: true },
          );
        } else if (event.type === "error") {
          throw new AgentelseError(
            "PROVIDER_RATE_LIMITED",
            `OpenAI stream error: ${event.message}`,
            { retryable: true },
          );
        } else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete"
        ) {
          const response = event.response;
          if (
            event.type === "response.incomplete" &&
            response.output.length === 0
          ) {
            throw new AgentelseError(
              "INVALID_PROVIDER_RESULT",
              `OpenAI returned nothing (incomplete: ${response.incomplete_details?.reason ?? "unknown"})`,
            );
          }
          yield {
            type: "completed",
            output: response.output as unknown as ResponseInputItem[],
            functionCalls: response.output.flatMap((item) =>
              item.type === "function_call"
                ? [
                    {
                      callId: item.call_id,
                      name: item.name,
                      arguments: item.arguments,
                    },
                  ]
                : [],
            ),
            inputTokens: response.usage?.input_tokens,
            cachedInputTokens:
              response.usage?.input_tokens_details?.cached_tokens,
            outputTokens: response.usage?.output_tokens,
            webSearchCalls: response.output.filter(
              (item) => item.type === "web_search_call",
            ).length,
          };
        }
      }
    } catch (error) {
      throw toAgentelseError(error);
    }
  },
};
