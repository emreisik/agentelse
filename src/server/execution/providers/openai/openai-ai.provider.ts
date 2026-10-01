import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  isOpenAIConfigured,
  openaiModelForTier,
  runOpenAIText,
} from "@/server/reasoning/openai-client";
import { runOpenAITextWithSearch } from "@/server/reasoning/openai-search-client";
import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// Public-web research capabilities: they need live facts, so they run through
// OpenAI's hosted web_search tool (Responses API) instead of plain text
// generation. The report comes back as free text in rawResult.text and
// ResultMaterializer turns it into findings.
const SEARCH_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "WEB_RESEARCH",
  "BRAND_DISCOVERY",
  "COMPETITOR_RESEARCH",
  "SEO_RESEARCH",
  "PRODUCT_RESEARCH",
  "MEDIA_RESEARCH",
  "CULTURAL_RESEARCH",
  "CREATOR_RESEARCH",
  "PARTNERSHIP_RESEARCH",
  "ADVERTISING_RESEARCH",
  "REVIEW_RESEARCH",
  "TECHNOLOGY_RESEARCH",
  "SOCIAL_RESEARCH",
]);

// Text/analysis capabilities — the real "AI thinks" step. Content that
// produces a visual asset is OpenAiCreativeProvider's job instead.
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
]);

type StoredResult = {
  status: "completed" | "failed";
  text?: string;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

// Best-effort durability write: by the time execute() returns, the OpenAI
// call has already fully resolved (success or failure) — runOpenAIText is
// awaited in full, never streamed — so this is always the TERMINAL result,
// not an in-progress snapshot. Persisting it into ExecutionJob.rawResult
// lets getStatus() recover it (via recoverResultFromRawResult below) if the
// in-memory `store` is empty after a process restart (Railway redeploy,
// crash) between execute() returning and the next poll. Reads-then-merges
// instead of overwriting, since rawResult may already carry other fields.
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
      "[openai-ai-provider] failed to persist result to rawResult:",
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
      "[openai-ai-provider] failed to recover result from rawResult:",
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
  const searchInstruction = SEARCH_CAPABILITIES.has(capability)
    ? `Use the web_search tool to ground every claim in current public sources. Write a research report: concrete facts first, each with its source URL inline; mark anything you could not verify as unverified instead of guessing.`
    : undefined;
  return [
    `You are Agentelse's AI execution engine handling the ${capability} capability for a digital agency managing multiple client brands.`,
    `Respond with the production-ready deliverable only — no meta commentary about what you are doing, no "Here is..." preamble.`,
    ...(searchInstruction ? [searchInstruction] : []),
    localeInstruction(brandContext),
    `Brand context for this request (JSON, may be partial — treat any negativeBrief/approvedClaims entries as hard constraints):`,
    JSON.stringify(brandContext ?? {}),
  ].join("\n\n");
}

export class OpenAiAiProvider implements ExecutionProvider {
  readonly key = "openai-ai";
  readonly type: ExecutionProviderType = "AI";

  get isConfigured(): boolean {
    return isOpenAIConfigured();
  }

  async canExecute(capability: CapabilityKey): Promise<boolean> {
    return (
      OWNED_CAPABILITIES.has(capability) || SEARCH_CAPABILITIES.has(capability)
    );
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const input = (request.payload ?? {}) as Record<string, unknown>;
    const requestText =
      typeof input.request === "string" ? input.request : JSON.stringify(input);

    let result: StoredResult;
    try {
      const call = {
        model: openaiModelForTier(),
        system: buildSystemPrompt(request.capability, input.brandContext),
        user: requestText,
      };
      const { text } = SEARCH_CAPABILITIES.has(request.capability)
        ? await runOpenAITextWithSearch({ ...call, maxOutputTokens: 8192 })
        : await runOpenAIText({ ...call, maxOutputTokens: 4096 });
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
        errorMessage: "Unknown OpenAI execution reference",
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
