import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import {
  isOpenAIConfigured,
  openaiModelForTier,
  runOpenAIText,
} from "@/server/reasoning/openai-client";
import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// Text/analysis capabilities — the real "AI thinks" step. Content that
// produces a visual asset is OpenAiCreativeProvider's job instead.
//
// The 4 search-grounded capabilities Gemini used to own here
// (BRAND_DISCOVERY, WEB_RESEARCH, COMPETITOR_RESEARCH, SEO_RESEARCH) are
// deliberately NOT included: OpenAI's Chat Completions API (used here) has
// no built-in web-search tool — that requires OpenAI's separate Responses
// API. Rather than add a second client for four capabilities, they're left
// entirely to OpenClawProvider, which already claims all four and, as of
// this session, does real grounded browsing (tool-use directive, real
// source data, agent.wait completion detection) — the more reliable path
// for "needs live web facts" questions anyway.
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

export class OpenAiAiProvider implements ExecutionProvider {
  readonly key = "openai-ai";
  readonly type: ExecutionProviderType = "AI";

  get isConfigured(): boolean {
    return isOpenAIConfigured();
  }

  async canExecute(capability: CapabilityKey): Promise<boolean> {
    return OWNED_CAPABILITIES.has(capability);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const input = (request.payload ?? {}) as Record<string, unknown>;
    const requestText =
      typeof input.request === "string" ? input.request : JSON.stringify(input);

    try {
      const { text } = await runOpenAIText({
        model: openaiModelForTier(),
        system: buildSystemPrompt(request.capability, input.brandContext),
        user: requestText,
        maxOutputTokens: 4096,
      });
      store.set(request.correlationId, { status: "completed", text });
    } catch (error) {
      store.set(request.correlationId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { executionReference: request.correlationId, isMock: false };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record = store.get(executionReference);
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
