import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  geminiModelForTier,
  isGeminiConfigured,
  runGeminiText,
  runGeminiWithSearchGrounding,
} from "@/server/reasoning/gemini-client";
import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// These need live web facts (brand mentions, competitor sites, SERP
// signals) a knowledge-cutoff model can't answer from parametric memory
// alone. Gemini's native Google Search grounding tool answers the same
// class of question with one HTTP call, instead of a synchronous OpenClaw
// browser session (tens of seconds to minutes, blocking the dispatch
// loop). OpenClawProvider stays registered right after this one in
// provider-registry.ts as a fallback: if GEMINI_API_KEY is unset or
// ProviderHealthService circuit-breaks Gemini, routing falls through to it
// unchanged.
const SEARCH_GROUNDED_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>([
    "BRAND_DISCOVERY",
    "WEB_RESEARCH",
    "COMPETITOR_RESEARCH",
    "SEO_RESEARCH",
  ]);

// Text/analysis capabilities — the real "AI thinks" step. Content that
// produces a visual asset is GeminiCreativeProvider's job instead (see
// gemini-creative.provider.ts — Gemini is tried first there too, OpenAI is
// its fallback).
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "MARKET_RESEARCH",
  "TREND_RESEARCH",
  "CUSTOMER_INTELLIGENCE",
  "SEO_ANALYSIS",
  "ASO_ANALYSIS",
  "CREATE_COPY",
  "CREATE_CAPTION",
  "CREATE_CAMPAIGN_BRIEF",
  "CREATE_CONTENT_PLAN",
  "CRM_ANALYSIS",
  "EMAIL_DRAFT",
  "CLAIM_VALIDATION",
  "BRAND_SAFETY",
  "REPORTING",
  ...SEARCH_GROUNDED_CAPABILITIES,
]);

type StoredResult = {
  status: "completed" | "failed";
  text?: string;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

// Best-effort durability write: by the time execute() returns, the Gemini
// call has already fully resolved (success or failure) — runGeminiText/
// runGeminiWithSearchGrounding are awaited in full, never streamed — so
// this is always the TERMINAL result, not an in-progress snapshot.
// Persisting it into ExecutionJob.rawResult lets getStatus() recover it
// (via recoverResultFromRawResult below) if the in-memory `store` is empty
// after a process restart (Railway redeploy, crash) between execute()
// returning and the next poll. Reads-then-merges instead of overwriting,
// since rawResult may already carry other fields. Mirrors
// openai-ai.provider.ts's durability pattern exactly.
async function persistResultToRawResult(
  executionJobId: string,
  result: StoredResult,
): Promise<void> {
  try {
    const existing = await prisma.executionJob.findUnique({
      where: { id: executionJobId },
      select: { rawResult: true },
    });
    const base =
      existing?.rawResult && typeof existing.rawResult === "object"
        ? (existing.rawResult as Record<string, unknown>)
        : {};
    await prisma.executionJob.update({
      where: { id: executionJobId },
      data: { rawResult: { ...base, ...result } as never },
    });
  } catch (error) {
    console.error(
      "[gemini-ai-provider] failed to persist result to rawResult:",
      error,
    );
  }
}

// Recovers a terminal result from Postgres when `store` has no entry for
// it — the normal case is a process restart between execute() and the next
// getStatus() poll. ExecutionJob.correlationId IS the executionReference
// this provider hands back from execute() (see its return value below), so
// it's the right unique key to look the job back up by. Re-populates
// `store` on a hit.
async function recoverResultFromRawResult(
  executionReference: string,
): Promise<StoredResult | undefined> {
  try {
    const job = await prisma.executionJob.findUnique({
      where: { correlationId: executionReference },
      select: { rawResult: true },
    });
    const raw = job?.rawResult;
    if (!raw || typeof raw !== "object") return undefined;
    const { status, text, errorMessage } = raw as Record<string, unknown>;
    if (status !== "completed" && status !== "failed") return undefined;
    const record: StoredResult = {
      status,
      text: typeof text === "string" ? text : undefined,
      errorMessage: typeof errorMessage === "string" ? errorMessage : undefined,
    };
    store.set(executionReference, record);
    return record;
  } catch (error) {
    console.error(
      "[gemini-ai-provider] failed to recover result from rawResult:",
      error,
    );
    return undefined;
  }
}

function localeInstruction(brandContext: unknown): string {
  const ctx = (brandContext ?? {}) as { language?: unknown; country?: unknown };
  const language =
    typeof ctx.language === "string" && ctx.language
      ? ctx.language
      : "the brand's default language";
  const country =
    typeof ctx.country === "string" && ctx.country
      ? ctx.country
      : "the brand's default market";
  return `Respond entirely in ${language}, with research/output focused on the ${country} market.`;
}

function buildSystemPrompt(
  capability: CapabilityKey,
  brandContext: unknown,
): string {
  return [
    `You are Agentelse's AI execution engine handling the ${capability} capability for a digital agency managing multiple client brands.`,
    `Respond with the production-ready deliverable only — no meta commentary about what you are doing, no "Here is..." preamble.`,
    localeInstruction(brandContext),
    `Brand context for this request (JSON, may be partial — treat any negativeBrief/approvedClaims entries as hard constraints):`,
    JSON.stringify(brandContext ?? {}),
  ].join("\n\n");
}

export class GeminiAiProvider implements ExecutionProvider {
  readonly key = "gemini-ai";
  readonly type: ExecutionProviderType = "AI";

  get isConfigured(): boolean {
    return isGeminiConfigured();
  }

  async canExecute(capability: CapabilityKey): Promise<boolean> {
    return OWNED_CAPABILITIES.has(capability);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const input = (request.payload ?? {}) as Record<string, unknown>;
    const requestText =
      typeof input.request === "string" ? input.request : JSON.stringify(input);

    let result: StoredResult;
    try {
      const call = SEARCH_GROUNDED_CAPABILITIES.has(request.capability)
        ? runGeminiWithSearchGrounding
        : runGeminiText;
      const { text } = await call({
        model: geminiModelForTier(),
        system: buildSystemPrompt(request.capability, input.brandContext),
        user: requestText,
        maxOutputTokens: 4096,
      });
      result = { status: "completed", text };
    } catch (error) {
      result = {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    store.set(request.correlationId, result);
    await persistResultToRawResult(request.executionJobId, result);

    return { executionReference: request.correlationId, isMock: false };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record =
      store.get(executionReference) ??
      (await recoverResultFromRawResult(executionReference));
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown Gemini execution reference",
        isMock: false,
      };
    }
    if (record.status === "failed") {
      return {
        status: "FAILED",
        errorMessage: record.errorMessage,
        isMock: false,
      };
    }
    return {
      status: "COMPLETED",
      rawResult: { text: record.text },
      isMock: false,
    };
  }
}
