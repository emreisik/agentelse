import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// Publish/campaign-write capabilities. ExecutionPolicy is responsible for
// requiring an APPROVED Approval before ExecutionService ever calls this —
// the provider itself does not re-check approval state.
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "INSTAGRAM_PUBLISH",
  "TIKTOK_PUBLISH",
  "LINKEDIN_PUBLISH",
  "X_PUBLISH",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "GOOGLE_ADS_CAMPAIGN_CREATE",
  "EMAIL_SEND",
  // Agency OS externally-visible actions
  "WEBSITE_UPDATE",
  "PR_OUTREACH",
]);

const store = new Map<
  string,
  { capability: CapabilityKey; payload: unknown }
>();

export class MockPublishingProvider implements ExecutionProvider {
  readonly key = "mock-publishing";
  readonly type: ExecutionProviderType = "OPENCLAW";
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
        note: "MOCK Publishing provider — nothing was actually posted externally.",
        capability: record.capability,
        publishedAt: new Date().toISOString(),
        externalPostUrl: "mock://social/post/placeholder",
      },
    };
  }
}
