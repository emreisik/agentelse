import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import {
  createLinkedInPost,
  isLinkedInAuthError,
  refreshLinkedInAccessToken,
  type LinkedInCredentialMetadata,
} from "@/server/integrations/linkedin-client";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// The real LinkedIn Community Management API — same pattern as
// meta-api-provider.ts. Image attachments aren't supported in this first
// version (text only) — uploadLinkedInImage is already available in
// linkedin-client.ts, so when needed it's enough to download
// payload.imageUrl and wire it in here.
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "LINKEDIN_PUBLISH",
]);

type StoredResult = {
  status: "COMPLETED" | "FAILED";
  rawResult?: unknown;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

async function findActiveLinkedInCredential(projectId: string) {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "linkedin" } },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return credential;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

export class LinkedInApiProvider implements ExecutionProvider {
  readonly key = "linkedin-api";
  readonly type: ExecutionProviderType = "API";

  get isConfigured(): boolean {
    return isIntegrationConfigured("LINKEDIN");
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OWNED_CAPABILITIES.has(capability)) return false;
    return Boolean(await findActiveLinkedInCredential(context.projectId));
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
        errorMessage: "Unknown LinkedIn API execution reference",
        isMock: false,
      };
    }
    return { ...record, isMock: false };
  }

  private async runCapability(
    request: ExecutionRequest,
  ): Promise<StoredResult> {
    const credential = await findActiveLinkedInCredential(
      request.context.projectId,
    );
    if (!credential) {
      return {
        status: "FAILED",
        errorMessage: "LinkedIn connection not found",
      };
    }
    const metadata = (credential.metadata ?? {}) as LinkedInCredentialMetadata;
    if (!metadata.memberUrn) {
      return {
        status: "FAILED",
        errorMessage: "LinkedIn member urn is missing",
      };
    }
    const payload = payloadRecord(request.payload);
    const commentary =
      typeof payload.caption === "string" ? payload.caption : "";
    if (!commentary) {
      return {
        status: "FAILED",
        errorMessage: "LINKEDIN_PUBLISH requires `caption`",
      };
    }

    try {
      const secret = JSON.parse(decryptSecret(credential.encryptedSecret)) as {
        accessToken: string;
        refreshToken?: string;
      };
      const { postUrn } = await this.publishWithRefresh(
        credential.id,
        secret,
        metadata.memberUrn,
        commentary,
      );
      return { status: "COMPLETED", rawResult: { postUrn } };
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Only refreshes+retries when the failure is an actual expired/invalid
  // token (isLinkedInAuthError) AND a refresh token was actually granted for
  // this connection — without app-level "Programmatic Refresh Tokens"
  // approval, LinkedIn never issues one, and refreshLinkedInAccessToken
  // would just fail again; in that case the original 401 is rethrown as-is
  // so the caller's error message tells the user to reconnect instead of a
  // confusing second error.
  private async publishWithRefresh(
    credentialId: string,
    secret: { accessToken: string; refreshToken?: string },
    memberUrn: string,
    commentary: string,
  ): Promise<{ postUrn: string }> {
    try {
      return await createLinkedInPost({
        accessToken: secret.accessToken,
        memberUrn,
        commentary,
      });
    } catch (error) {
      if (!isLinkedInAuthError(error) || !secret.refreshToken) throw error;

      const refreshed = await refreshLinkedInAccessToken(secret.refreshToken);
      await prisma.integrationCredential.update({
        where: { id: credentialId },
        data: {
          encryptedSecret: encryptSecret(
            JSON.stringify({
              accessToken: refreshed.accessToken,
              refreshToken: secret.refreshToken,
            }),
          ),
        },
      });
      return await createLinkedInPost({
        accessToken: refreshed.accessToken,
        memberUrn,
        commentary,
      });
    }
  }
}
