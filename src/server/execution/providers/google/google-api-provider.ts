import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  fetchGa4Report,
  fetchSearchConsoleReport,
  type GoogleCredentialMetadata,
} from "@/server/integrations/google-client";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// The real GA4 Data API + Search Console API — used instead of
// OpenClawProvider's browser automation whenever the project has a Google
// account connected via OAuth with a selected property/site. Registered
// before OpenClawProvider in provider-registry.ts: the real API is always
// preferred over screen scraping (same pattern as meta-api-provider.ts).
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "ANALYTICS_ANALYSIS",
]);

// Report window: the one-off "Test" uses 7 days, the real analysis task
// here uses 28 — enough to see a trend, without extra query cost.
const REPORT_WINDOW_DAYS = 28;

type StoredResult = {
  status: "COMPLETED" | "FAILED";
  rawResult?: unknown;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

async function findActiveGoogleCredential(projectId: string) {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "google" } },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return credential;
}

export class GoogleApiProvider implements ExecutionProvider {
  readonly key = "google-api";
  readonly type: ExecutionProviderType = "API";

  get isConfigured(): boolean {
    return isIntegrationConfigured("GOOGLE");
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OWNED_CAPABILITIES.has(capability)) return false;

    const credential = await findActiveGoogleCredential(context.projectId);
    if (!credential) return false;

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    return Boolean(
      metadata.selectedGa4PropertyId || metadata.selectedSearchConsoleSite,
    );
  }

  // Google API calls are synchronous and return within seconds — we follow
  // OpenClawProvider/MetaApiProvider's "run synchronously, cache the
  // result" pattern.
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
        errorMessage: "Unknown Google API execution reference",
        isMock: false,
      };
    }
    return { ...record, isMock: false };
  }

  private async runCapability(
    request: ExecutionRequest,
  ): Promise<StoredResult> {
    const credential = await findActiveGoogleCredential(
      request.context.projectId,
    );
    if (!credential) {
      return { status: "FAILED", errorMessage: "Google connection not found" };
    }
    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;

    try {
      const accessToken = await getFreshGoogleAccessToken(credential);
      return await this.analyzeAnalytics(accessToken, metadata);
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async analyzeAnalytics(
    accessToken: string,
    metadata: GoogleCredentialMetadata,
  ): Promise<StoredResult> {
    const [ga4, searchConsole] = await Promise.all([
      metadata.selectedGa4PropertyId
        ? fetchGa4Report(
            accessToken,
            metadata.selectedGa4PropertyId,
            REPORT_WINDOW_DAYS,
          )
        : Promise.resolve(null),
      metadata.selectedSearchConsoleSite
        ? fetchSearchConsoleReport(
            accessToken,
            metadata.selectedSearchConsoleSite,
            REPORT_WINDOW_DAYS,
          )
        : Promise.resolve(null),
    ]);

    if (!ga4 && !searchConsole) {
      return {
        status: "FAILED",
        errorMessage: "No GA4 property or Search Console site selected",
      };
    }

    const parts: string[] = [];
    if (ga4) {
      parts.push(
        `GA4: ${ga4.activeUsers} users, ${ga4.sessions} sessions (${REPORT_WINDOW_DAYS}d)`,
      );
    }
    if (searchConsole) {
      parts.push(
        `Search Console: ${searchConsole.clicks} clicks / ${searchConsole.impressions} impressions, ` +
          `avg. position ${searchConsole.position.toFixed(1)} (${REPORT_WINDOW_DAYS}d)`,
      );
    }

    return {
      status: "COMPLETED",
      rawResult: {
        text: parts.join(" · "),
        windowDays: REPORT_WINDOW_DAYS,
        ga4,
        searchConsole,
      },
    };
  }
}
