import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import {
  fetchTikTokPublishStatus,
  isTikTokAuthError,
  parseTikTokTokens,
  publishTikTokVideo,
  refreshTikTokAccessToken,
  serializeTikTokTokens,
} from "@/server/integrations/tiktok-client";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// The real TikTok Content Posting API — used instead of OpenClawProvider's
// browser automation whenever the project has a TikTok account connected
// via OAuth. Registered before OpenClawProvider in provider-registry.ts.
// Same pattern as meta-api-provider.ts: synchronous execute, caching the
// result in a Map.
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "TIKTOK_PUBLISH",
]);

type StoredResult = {
  status: "COMPLETED" | "FAILED";
  rawResult?: unknown;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

async function findActiveTikTokCredential(projectId: string) {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "tiktok" } },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return credential;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

export class TikTokApiProvider implements ExecutionProvider {
  readonly key = "tiktok-api";
  readonly type: ExecutionProviderType = "API";

  get isConfigured(): boolean {
    return isIntegrationConfigured("TIKTOK");
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OWNED_CAPABILITIES.has(capability)) return false;
    return Boolean(await findActiveTikTokCredential(context.projectId));
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
        errorMessage: "Unknown TikTok API execution reference",
        isMock: false,
      };
    }
    return { ...record, isMock: false };
  }

  private async runCapability(
    request: ExecutionRequest,
  ): Promise<StoredResult> {
    const credential = await findActiveTikTokCredential(
      request.context.projectId,
    );
    if (!credential) {
      return { status: "FAILED", errorMessage: "TikTok connection not found" };
    }
    const payload = payloadRecord(request.payload);
    const videoUrl =
      typeof payload.videoUrl === "string" ? payload.videoUrl : undefined;
    const caption = typeof payload.caption === "string" ? payload.caption : "";
    if (!videoUrl) {
      return {
        status: "FAILED",
        errorMessage: "TIKTOK_PUBLISH requires `videoUrl`",
      };
    }

    try {
      const tokens = parseTikTokTokens(
        decryptSecret(credential.encryptedSecret),
      );

      // publishWithRefresh may rotate the token pair internally (on an
      // expired-token failure) — the SAME (possibly refreshed) accessToken
      // it actually published with must be reused for every status-poll
      // call below, or a successful publish-after-refresh 401s on its very
      // first status check and gets misreported as FAILED.
      const { publishId, accessToken } = await this.publishWithRefresh(
        credential.id,
        tokens,
        videoUrl,
        caption,
      );

      // TikTok processes publishing asynchronously — we poll briefly to get
      // the first concrete result (similar to Meta's media container wait);
      // if it stays in "PROCESSING_*", the task is still counted as
      // COMPLETED (it keeps going in the background on TikTok's side), only
      // an explicit FAILED stops it.
      let status = await fetchTikTokPublishStatus(accessToken, publishId);
      for (
        let attempt = 0;
        attempt < 5 && status.status === "PROCESSING_DOWNLOAD";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        status = await fetchTikTokPublishStatus(accessToken, publishId);
      }
      if (status.status === "FAILED") {
        return {
          status: "FAILED",
          errorMessage: status.failReason ?? "TikTok publish failed",
        };
      }
      return {
        status: "COMPLETED",
        rawResult: { publishId, status: status.status },
      };
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Only refreshes+retries when the failure is actually an expired/invalid
  // token (isTikTokAuthError) — any other error (bad videoUrl, content
  // rejected, network timeout, ...) is rethrown as-is instead of being
  // masked by an unrelated refresh attempt and a confusing second error.
  // Returns the accessToken it ultimately published with so callers can
  // reuse it for follow-up calls (status polling) instead of the stale
  // pre-refresh token.
  private async publishWithRefresh(
    credentialId: string,
    tokens: { accessToken: string; refreshToken: string },
    videoUrl: string,
    caption: string,
  ): Promise<{ publishId: string; accessToken: string }> {
    try {
      const { publishId } = await publishTikTokVideo({
        accessToken: tokens.accessToken,
        videoUrl,
        caption,
      });
      return { publishId, accessToken: tokens.accessToken };
    } catch (error) {
      if (!isTikTokAuthError(error)) throw error;

      const refreshed = await refreshTikTokAccessToken(tokens.refreshToken);
      await prisma.integrationCredential.update({
        where: { id: credentialId },
        data: {
          encryptedSecret: encryptSecret(
            serializeTikTokTokens({
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
            }),
          ),
        },
      });
      const { publishId } = await publishTikTokVideo({
        accessToken: refreshed.accessToken,
        videoUrl,
        caption,
      });
      return { publishId, accessToken: refreshed.accessToken };
    }
  }
}
