import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  GOOGLE_PROVIDER,
  fetchGa4Report,
  fetchSearchConsoleReport,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
} from "@/server/integrations/google-client";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// The real GA4 Data API + Search Console API — the only provider for
// ANALYTICS_ANALYSIS. Google Analytics and Search Console are separate
// integrations (separate OAuth grants/credentials); this runs whenever at
// least one of them is connected with a selected property/site, and reports
// on whichever are available.
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

type ActiveGoogleConnections = {
  analytics: {
    credential: { id: string; encryptedSecret: string };
    propertyId: string;
  } | null;
  searchConsole: {
    credential: { id: string; encryptedSecret: string };
    siteUrl: string;
  } | null;
};

// Loads both Google integrations for the project and keeps only those that
// are ACTIVE and have a property/site selected.
async function findActiveGoogleConnections(
  projectId: string,
): Promise<ActiveGoogleConnections> {
  const credentials = await prisma.integrationCredential.findMany({
    where: {
      projectId,
      provider: {
        in: [GOOGLE_PROVIDER.analytics, GOOGLE_PROVIDER.search_console],
      },
      status: "ACTIVE",
    },
  });
  const ga = credentials.find((c) => c.provider === GOOGLE_PROVIDER.analytics);
  const gsc = credentials.find(
    (c) => c.provider === GOOGLE_PROVIDER.search_console,
  );
  const propertyId = (ga?.metadata as GoogleAnalyticsMetadata | null)
    ?.selectedGa4PropertyId;
  const siteUrl = (gsc?.metadata as GoogleSearchConsoleMetadata | null)
    ?.selectedSearchConsoleSite;
  return {
    analytics: ga && propertyId ? { credential: ga, propertyId } : null,
    searchConsole: gsc && siteUrl ? { credential: gsc, siteUrl } : null,
  };
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

    const connections = await findActiveGoogleConnections(context.projectId);
    return Boolean(connections.analytics || connections.searchConsole);
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
    const { analytics, searchConsole } = await findActiveGoogleConnections(
      request.context.projectId,
    );
    if (!analytics && !searchConsole) {
      return {
        status: "FAILED",
        errorMessage:
          "No Google Analytics property or Search Console site connected",
      };
    }

    try {
      // Each integration has its own refresh token — two separate grants,
      // possibly from different Google accounts.
      const [ga4, gsc] = await Promise.all([
        analytics
          ? getFreshGoogleAccessToken(analytics.credential).then((token) =>
              fetchGa4Report(token, analytics.propertyId, REPORT_WINDOW_DAYS),
            )
          : Promise.resolve(null),
        searchConsole
          ? getFreshGoogleAccessToken(searchConsole.credential).then((token) =>
              fetchSearchConsoleReport(
                token,
                searchConsole.siteUrl,
                REPORT_WINDOW_DAYS,
              ),
            )
          : Promise.resolve(null),
      ]);
      return summarize(ga4, gsc);
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function summarize(
  ga4: Awaited<ReturnType<typeof fetchGa4Report>> | null,
  searchConsole: Awaited<ReturnType<typeof fetchSearchConsoleReport>> | null,
): StoredResult {
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
