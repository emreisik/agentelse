import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import {
  isXAuthError,
  parseXTokens,
  publishXPost,
  refreshXAccessToken,
  serializeXTokens,
} from "@/server/integrations/x-client";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// The real X API v2 — same pattern as meta-api-provider.ts. Text-only
// tweets for now (see the media note in x-client.ts) — every successful
// call incurs a real pay-per-use cost on X's side, which is why X_PUBLISH
// is already APPROVAL_REQUIRED in execution-policy.ts.
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "X_PUBLISH",
]);

type StoredResult = {
  status: "COMPLETED" | "FAILED";
  rawResult?: unknown;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

async function findActiveXCredential(projectId: string) {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "x" } },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return credential;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

export class XApiProvider implements ExecutionProvider {
  readonly key = "x-api";
  readonly type: ExecutionProviderType = "API";

  get isConfigured(): boolean {
    return isIntegrationConfigured("X");
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OWNED_CAPABILITIES.has(capability)) return false;
    return Boolean(await findActiveXCredential(context.projectId));
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const result = await this.runCapability(request);
    store.set(request.correlationId, result);
    return { executionReference: request.correlationId, isMock: false };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record = store.get(executionReference);
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown X API execution reference",
        isMock: false,
      };
    }
    return { ...record, isMock: false };
  }

  private async runCapability(
    request: ExecutionRequest,
  ): Promise<StoredResult> {
    const credential = await findActiveXCredential(request.context.projectId);
    if (!credential) {
      return { status: "FAILED", errorMessage: "X connection not found" };
    }
    const payload = payloadRecord(request.payload);
    const text = typeof payload.caption === "string" ? payload.caption : "";
    if (!text) {
      return {
        status: "FAILED",
        errorMessage: "X_PUBLISH requires `caption`",
      };
    }

    try {
      const tokens = parseXTokens(decryptSecret(credential.encryptedSecret));
      const { tweetId } = await this.publishWithRefresh(
        credential.id,
        tokens,
        text,
      );
      return { status: "COMPLETED", rawResult: { tweetId } };
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Only refreshes+retries on an actual expired/invalid token
  // (isXAuthError) — any other failure (bad request, rate limit, billing
  // error, network timeout, ...) is rethrown as-is instead of being masked
  // by an unrelated refresh attempt and a confusing second error.
  private async publishWithRefresh(
    credentialId: string,
    tokens: { accessToken: string; refreshToken: string },
    text: string,
  ): Promise<{ tweetId: string }> {
    try {
      return await publishXPost({ accessToken: tokens.accessToken, text });
    } catch (error) {
      if (!isXAuthError(error)) throw error;

      const refreshed = await refreshXAccessToken(tokens.refreshToken);
      await prisma.integrationCredential.update({
        where: { id: credentialId },
        data: {
          encryptedSecret: encryptSecret(
            serializeXTokens({
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
            }),
          ),
        },
      });
      return await publishXPost({ accessToken: refreshed.accessToken, text });
    }
  }
}
