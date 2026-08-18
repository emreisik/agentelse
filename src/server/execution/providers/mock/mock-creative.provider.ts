import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "CREATE_SOCIAL_CREATIVE",
  "CREATE_AD_CREATIVE",
]);

const store = new Map<
  string,
  { capability: CapabilityKey; payload: unknown }
>();

export class MockCreativeProvider implements ExecutionProvider {
  readonly key = "mock-creative";
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

    const input = (record.payload ?? {}) as Record<string, unknown>;
    const brief =
      typeof input.request === "string" ? input.request : "creative brief";

    return {
      status: "COMPLETED",
      isMock: true,
      rawResult: {
        isMock: true,
        note: "MOCK Creative provider — placeholder asset, no real image was generated.",
        capability: record.capability,
        placeholderImageUrl: "mock://asset/placeholder.png",
        caption: `[MOCK CAPTION] ${brief}`,
        copy: `[MOCK COPY] Draft copy generated for: "${brief}".`,
      },
    };
  }
}
