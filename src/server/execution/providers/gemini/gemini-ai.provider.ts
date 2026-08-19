import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import {
  geminiModel,
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
// alone. Previously OpenClaw-only (a synchronous CLI browser session, tens
// of seconds to minutes, blocking the dispatch loop) — Gemini's native
// Google Search grounding tool answers the same class of question with one
// HTTP call. OpenClaw stays registered right after in provider-registry.ts
// as a fallback: if GEMINI_API_KEY is unset or ProviderHealthService
// circuit-breaks Gemini, routing falls through to it unchanged.
const SEARCH_GROUNDED_CAPABILITIES: ReadonlySet<CapabilityKey> =
  new Set<CapabilityKey>([
    "BRAND_DISCOVERY",
    "WEB_RESEARCH",
    "COMPETITOR_RESEARCH",
    "SEO_RESEARCH",
  ]);

// Text/analysis capabilities — the real "AI thinks" step. Content that
// produces a visual asset is GeminiCreativeProvider's job instead.
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

// Real Gemini-backed provider. Inactive (isConfigured: false) until
// GEMINI_API_KEY is set — CapabilityRouter falls through to MockAiProvider
// automatically until then, no other code changes needed.
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

    try {
      const call = SEARCH_GROUNDED_CAPABILITIES.has(request.capability)
        ? runGeminiWithSearchGrounding
        : runGeminiText;
      const { text } = await call({
        model: geminiModel(),
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
