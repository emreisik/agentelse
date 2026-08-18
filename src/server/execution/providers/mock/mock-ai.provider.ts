import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

import {
  buildMockResearchFindings,
  isResearchCapability,
} from "./mock-research-results";

// Text/analysis-flavored "AI thinks" capabilities — research summaries,
// copywriting, claim/brand-safety checks, reporting. Content generation that
// produces a visual asset is MockCreativeProvider's job instead.
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

const store = new Map<
  string,
  { capability: CapabilityKey; payload: unknown }
>();

function mockText(capability: CapabilityKey, payload: unknown): string {
  const input = (payload ?? {}) as Record<string, unknown>;
  const brief =
    typeof input.request === "string" ? input.request : JSON.stringify(input);
  return `[MOCK AI OUTPUT for ${capability}] Generated placeholder text based on: "${brief}".`;
}

export class MockAiProvider implements ExecutionProvider {
  readonly key = "mock-ai";
  readonly type: ExecutionProviderType = "AI";
  readonly isConfigured = true;

  async canExecute(capability: CapabilityKey): Promise<boolean> {
    return OWNED_CAPABILITIES.has(capability);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    store.set(request.correlationId, {
      capability: request.capability,
      payload: request.payload,
    });
    return { executionReference: request.correlationId, isMock: true };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record = store.get(executionReference);
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown mock execution reference",
        isMock: true,
      };
    }

    return {
      status: "COMPLETED",
      isMock: true,
      rawResult: {
        isMock: true,
        note: "MOCK AI provider — no real model call was made.",
        text: mockText(record.capability, record.payload),
        // Research-flavored capabilities also emit structured findings so
        // ResultMaterializer can promote them regardless of provider.
        ...(isResearchCapability(record.capability)
          ? {
              findings: buildMockResearchFindings(
                record.capability,
                record.payload,
              ),
            }
          : {}),
      },
    };
  }
}
