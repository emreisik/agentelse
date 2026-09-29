import "server-only";

import { prisma } from "@/lib/prisma";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import { evaluateSeoFindings } from "./seo-rules";
import {
  GOOGLE_PROVIDER,
  fetchGa4Report,
  fetchSearchConsoleQueryRows,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
} from "@/server/integrations/google-client";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";

type ScanMetadata = GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata;

// Mirrors meta-performance-scanner.ts's structure exactly (isDue/jitter/
// backoff, per-credential isolation, snapshot-on-metadata). SEO signals move
// far slower than ad performance, so the cadence is daily rather than ~7h.
const SCAN_INTERVAL_MS = 24 * 3600_000; // ~daily, ± jitter below
const JITTER_MINUTES = 60;
const MAX_CREDENTIALS_PER_TICK_DEFAULT = 5;
const MAX_FAILURE_BACKOFF_MS = 7 * 24 * 3600_000;

function jitterMs(credentialId: string): number {
  let hash = 0;
  for (let i = 0; i < credentialId.length; i++) {
    hash = (hash * 31 + credentialId.charCodeAt(i)) >>> 0;
  }
  return (hash % (JITTER_MINUTES * 2)) * 60_000;
}

function isDue(
  metadata: ScanMetadata,
  credentialId: string,
): boolean {
  if (!metadata.lastAnalyticsScanAt) return true;
  const failures = metadata.analyticsScanFailureCount ?? 0;
  const backoff = Math.min(
    SCAN_INTERVAL_MS * 2 ** failures,
    MAX_FAILURE_BACKOFF_MS,
  );
  const interval =
    failures > 0 ? backoff : SCAN_INTERVAL_MS - jitterMs(credentialId);
  const last = new Date(metadata.lastAnalyticsScanAt).getTime();
  return Date.now() - last >= interval;
}

// Agency tick step (registered in agency-wiring.ts) — scans due Google
// Analytics and Search Console connections (two separate integrations, each
// scanned on its own credential/schedule) and feeds SEO findings into the same
// Signal -> Insight -> Opportunity -> Idea funnel every other signal source
// uses. Unlike Meta's scanner, there's no Track 2 bypass here: content ideas
// aren't urgent the way "pause a burning campaign" is, so they go through
// the normal council/director quality gate instead of an automatic task.
export const GoogleAnalyticsScanner = {
  async runDueScans(limit = MAX_CREDENTIALS_PER_TICK_DEFAULT): Promise<number> {
    const candidates = await prisma.integrationCredential.findMany({
      where: {
        provider: {
          in: [GOOGLE_PROVIDER.analytics, GOOGLE_PROVIDER.search_console],
        },
        status: "ACTIVE",
      },
      take: limit * 4,
      orderBy: { updatedAt: "asc" },
    });

    let scanned = 0;
    for (const credential of candidates) {
      if (scanned >= limit) break;
      const metadata = (credential.metadata ?? {}) as ScanMetadata;
      if (!hasSelection(credential.provider, metadata)) continue;
      if (!isDue(metadata, credential.id)) continue;

      const project = await prisma.project.findUnique({
        where: { id: credential.projectId },
        select: { status: true },
      });
      if (project?.status !== "ACTIVE") continue;

      scanned += 1;
      try {
        await scanOneCredential(credential, metadata);
      } catch (error) {
        console.error(
          `[google-analytics-scanner] scan failed for credential ${credential.id}:`,
          error instanceof Error ? error.message : error,
        );
        await prisma.integrationCredential.update({
          where: { id: credential.id },
          data: {
            metadata: {
              ...metadata,
              lastAnalyticsScanAt: new Date().toISOString(),
              analyticsScanFailureCount:
                (metadata.analyticsScanFailureCount ?? 0) + 1,
            } as never,
          },
        });
      }
    }
    return scanned;
  },
};

function hasSelection(provider: string, metadata: ScanMetadata): boolean {
  return provider === GOOGLE_PROVIDER.analytics
    ? Boolean((metadata as GoogleAnalyticsMetadata).selectedGa4PropertyId)
    : Boolean(
        (metadata as GoogleSearchConsoleMetadata).selectedSearchConsoleSite,
      );
}

async function scanOneCredential(
  credential: {
    id: string;
    provider: string;
    workspaceId: string;
    projectId: string;
    brandId: string;
    encryptedSecret: string;
  },
  metadata: ScanMetadata,
): Promise<void> {
  // The stored secret is the refresh token — it must be exchanged for an
  // access token before any API call (using it directly returns 401).
  const accessToken = await getFreshGoogleAccessToken(credential);
  const scope = {
    workspaceId: credential.workspaceId,
    projectId: credential.projectId,
    brandId: credential.brandId,
  };

  const isAnalytics = credential.provider === GOOGLE_PROVIDER.analytics;
  const gaMetadata = metadata as GoogleAnalyticsMetadata;
  const gscMetadata = metadata as GoogleSearchConsoleMetadata;

  const ga4Current =
    isAnalytics && gaMetadata.selectedGa4PropertyId
      ? await fetchGa4Report(accessToken, gaMetadata.selectedGa4PropertyId, 7)
      : undefined;

  const gscRows =
    !isAnalytics && gscMetadata.selectedSearchConsoleSite
      ? await fetchSearchConsoleQueryRows(
          accessToken,
          gscMetadata.selectedSearchConsoleSite,
          ["query"],
          28,
          25,
        )
      : [];

  const findings = evaluateSeoFindings({
    ga4: ga4Current
      ? {
          current: ga4Current,
          previous: gaMetadata.previousAnalyticsSnapshot?.ga4,
        }
      : undefined,
    gscRows,
  });

  for (const finding of findings) {
    await SignalUniverse.ingestRaw({
      ...scope,
      source: "google-analytics-scan",
      category: "SEO",
      externalRef: `google-analytics:${credential.id}:${finding.rule}:${finding.key ?? ""}`,
      title: finding.title,
      summary: finding.summary,
      reliability: 1,
    });
  }

  await prisma.integrationCredential.update({
    where: { id: credential.id },
    data: {
      metadata: {
        ...metadata,
        lastAnalyticsScanAt: new Date().toISOString(),
        analyticsScanFailureCount: 0,
        ...(isAnalytics
          ? { previousAnalyticsSnapshot: { ga4: ga4Current } }
          : {}),
      } as never,
    },
  });
}
