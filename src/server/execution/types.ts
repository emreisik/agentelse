import type {
  CapabilityKey,
  ExecutionProviderType,
  RiskLevel,
} from "@prisma/client";

export type ExecutionPolicyContext = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  taskId: string;
  capability: CapabilityKey;
  riskLevel: RiskLevel;
  browserProfileId?: string;
  skillId?: string;
};

export type ExecutionRequest = {
  executionJobId: string;
  correlationId: string;
  idempotencyKey: string;
  capability: CapabilityKey;
  context: ExecutionPolicyContext;
  payload?: unknown;
};

export type ExecutionAcceptedResult = {
  // Opaque handle the provider uses to look up async status later. For
  // synchronous mock providers this can just echo executionJobId.
  executionReference: string;
  isMock: boolean;
};

export type ProviderExecutionStatusValue =
  "PENDING" | "RUNNING" | "WAITING_HUMAN" | "COMPLETED" | "FAILED";

export type ProviderExecutionStatus = {
  status: ProviderExecutionStatusValue;
  rawResult?: unknown;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  isMock: boolean;
};

// Every execution provider (OpenClaw, AI, direct API integrations, human
// task queues, ...) implements this. Domain services never import a
// concrete provider — only ProviderRegistry/CapabilityRouter do, so swapping
// or adding a provider never touches ExecutionService or callers.
export interface ExecutionProvider {
  // Stable identifier persisted on ExecutionJob.providerId so a later poll
  // can look the same provider instance back up via ProviderRegistry.
  readonly key: string;
  readonly type: ExecutionProviderType;
  readonly isConfigured: boolean;

  canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean>;
  execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult>;
  getStatus(executionReference: string): Promise<ProviderExecutionStatus>;
  cancel?(executionReference: string): Promise<void>;
  // Sends a human-provided continuation value (OTP code, confirmation,
  // chosen option, ...) back to a WAITING_HUMAN execution so it can resume.
  resume?(executionReference: string, input: { value: string }): Promise<void>;
}
