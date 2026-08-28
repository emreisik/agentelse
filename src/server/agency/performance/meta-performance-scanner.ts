import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import { PerformanceOptimizer } from "./performance-optimizer";
import {
  evaluateAdSetFinding,
  evaluateCampaignFinding,
  evaluateTrendFinding,
  type ScanSnapshot,
} from "./meta-performance-rules";
import {
  fetchMetaLevelInsights,
  listMetaAdSets,
  listMetaCampaigns,
  type MetaCredentialMetadata,
} from "@/server/integrations/meta-client";

const SCAN_INTERVAL_MS = 7 * 3600_000; // 6-8h band, see jitterMinutes below
const JITTER_MINUTES = 30;
const MAX_CREDENTIALS_PER_TICK_DEFAULT = 5;
const MAX_CAMPAIGNS_PER_SCAN = 30;
const MAX_FAILURE_BACKOFF_MS = 24 * 3600_000;

// A small, deterministic 0..2*JITTER_MINUTES offset derived from the
// credential's own id — spreads all accounts' scan times across the
// interval instead of them all landing on the exact same due-instant every
// tick (which would otherwise cause them to always compete for the same
// per-tick `limit` slots). Deterministic (not Math.random()) so the same
// credential doesn't flap between "due" and "not due" from one tick to the
// next before it's actually been scanned.
function jitterMs(credentialId: string): number {
  let hash = 0;
  for (let i = 0; i < credentialId.length; i++) {
    hash = (hash * 31 + credentialId.charCodeAt(i)) >>> 0;
  }
  return (hash % (JITTER_MINUTES * 2)) * 60_000;
}

function isDue(
  metadata: MetaCredentialMetadata,
  credentialId: string,
): boolean {
  if (!metadata.lastAdsPerformanceScanAt) return true;
  const failures = metadata.adsPerformanceScanFailureCount ?? 0;
  const backoff = Math.min(
    SCAN_INTERVAL_MS * 2 ** failures,
    MAX_FAILURE_BACKOFF_MS,
  );
  const interval =
    failures > 0 ? backoff : SCAN_INTERVAL_MS - jitterMs(credentialId);
  const last = new Date(metadata.lastAdsPerformanceScanAt).getTime();
  return Date.now() - last >= interval;
}

// Agency tick step (registered in agency-wiring.ts) — scans due Meta
// connections for performance problems. Track 1 (informational signal) and
// Track 2 (deterministic optimization proposal) both happen here; see
// meta-performance-rules.ts / performance-optimizer.ts.
export const MetaPerformanceScanner = {
  async runDueScans(limit = MAX_CREDENTIALS_PER_TICK_DEFAULT): Promise<number> {
    const candidates = await prisma.integrationCredential.findMany({
      where: { provider: "meta", status: "ACTIVE" },
      // Over-fetch a bit since not every ACTIVE credential is due — filtered
      // in memory below (metadata is unstructured JSON, can't push the due
      // check into the WHERE clause).
      take: limit * 4,
      orderBy: { updatedAt: "asc" },
    });

    let scanned = 0;
    for (const credential of candidates) {
      if (scanned >= limit) break;
      const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
      if (!metadata.selectedAdAccountId) continue;
      if (!isDue(metadata, credential.id)) continue;

      const project = await prisma.project.findUnique({
        where: { id: credential.projectId },
        select: { status: true },
      });
      if (project?.status !== "ACTIVE") continue;

      scanned += 1;
      // Per-credential isolation — one project's bad token/rate-limit must
      // never stop the rest of the tick's scans (same pattern as
      // SignalUniverse.runDueScans / OpportunityEngine.evaluatePromotedInsights).
      try {
        await scanOneCredential(credential, metadata);
      } catch (error) {
        console.error(
          `[meta-performance-scanner] scan failed for credential ${credential.id}:`,
          error instanceof Error ? error.message : error,
        );
        await prisma.integrationCredential.update({
          where: { id: credential.id },
          data: {
            metadata: {
              ...metadata,
              // lastAdsPerformanceScanAt must advance on failure too, not
              // only on success — isDue() only enters the backoff branch
              // once this is set; leaving it unset here would mean
              // isDue()'s `!metadata.lastAdsPerformanceScanAt` short-circuit
              // returns true every tick forever, and the exponential
              // backoff below is never actually consulted.
              lastAdsPerformanceScanAt: new Date().toISOString(),
              adsPerformanceScanFailureCount:
                (metadata.adsPerformanceScanFailureCount ?? 0) + 1,
            } as never,
          },
        });
      }
    }
    return scanned;
  },
};

async function scanOneCredential(
  credential: {
    id: string;
    workspaceId: string;
    projectId: string;
    brandId: string;
    encryptedSecret: string;
  },
  metadata: MetaCredentialMetadata,
): Promise<void> {
  const accessToken = decryptSecret(credential.encryptedSecret);
  const adAccountId = metadata.selectedAdAccountId!;
  const currency =
    metadata.adAccounts?.find((a) => a.adAccountId === adAccountId)?.currency ??
    "USD";
  const scope = {
    workspaceId: credential.workspaceId,
    projectId: credential.projectId,
    brandId: credential.brandId,
  };
  const previousSnapshot = metadata.previousScanSnapshot ?? {};
  const nextSnapshot: Record<string, ScanSnapshot> = {};

  const [campaigns, campaignInsights] = await Promise.all([
    listMetaCampaigns({ adAccountId, accessToken }),
    fetchMetaLevelInsights({
      adAccountId,
      accessToken,
      level: "campaign",
      datePreset: "last_7d",
    }),
  ]);

  const active = campaigns
    .filter((c) => c.effectiveStatus === "ACTIVE")
    .map((c) => ({ campaign: c, insights: campaignInsights.get(c.campaignId) }))
    .filter((row) => row.insights && row.insights.spend > 0)
    .sort((a, b) => (b.insights!.spend ?? 0) - (a.insights!.spend ?? 0))
    .slice(0, MAX_CAMPAIGNS_PER_SCAN);

  for (const { campaign, insights } of active) {
    if (!insights || !campaign.dailyBudgetCents) continue;

    const snapshotKey = `meta-campaign:${campaign.campaignId}`;
    nextSnapshot[snapshotKey] = {
      spend: insights.spend,
      costPerResult: insights.costPerResult,
      ctr: insights.ctr,
    };

    const finding = evaluateCampaignFinding({
      campaignName: campaign.name,
      insights,
      dailyBudgetCents: campaign.dailyBudgetCents,
      currency,
    });
    if (finding) {
      await SignalUniverse.ingestRaw({
        ...scope,
        source: "meta-ads-performance-scan",
        category: "PERFORMANCE",
        externalRef: `meta-campaign:${campaign.campaignId}:${finding.rule}`,
        title: finding.title,
        summary: finding.summary,
        reliability: 1,
      });
      if (finding.severity === "HIGH" && finding.suggestedAction) {
        await PerformanceOptimizer.proposeCampaignAction({
          scope,
          campaignId: campaign.campaignId,
          campaignName: campaign.name,
          currentDailyBudgetCents: campaign.dailyBudgetCents,
          finding,
        });
      }
      if (finding.rule === "AD_FATIGUE") {
        await PerformanceOptimizer.proposeCreativeRefresh({
          scope,
          subjectId: campaign.campaignId,
          finding,
        });
      }
      continue;
    }

    // No absolute-threshold finding — check for a trend regression instead
    // (e.g. CPA creeping up scan-over-scan without yet crossing an absolute
    // threshold). Informational only (Track 1), see evaluateTrendFinding.
    const trendFinding = evaluateTrendFinding({
      entityName: campaign.name,
      current: nextSnapshot[snapshotKey],
      previous: previousSnapshot[snapshotKey],
    });
    if (trendFinding) {
      await SignalUniverse.ingestRaw({
        ...scope,
        source: "meta-ads-performance-scan",
        category: "PERFORMANCE",
        externalRef: `meta-campaign:${campaign.campaignId}:${trendFinding.rule}`,
        title: trendFinding.title,
        summary: trendFinding.summary,
        reliability: 1,
      });
    }

    // Only drill into adsets for campaigns that already look suspicious
    // (spend with weak/no results) — a healthy campaign's adsets aren't
    // worth the extra API call.
    const suspicious = !insights.resultCount || insights.resultCount <= 0;
    if (!suspicious) continue;

    const [adSets, adSetInsights] = await Promise.all([
      listMetaAdSets({ campaignId: campaign.campaignId, accessToken }),
      fetchMetaLevelInsights({
        adAccountId,
        accessToken,
        level: "adset",
        datePreset: "last_7d",
        scopedTo: { field: "campaign.id", value: campaign.campaignId },
      }),
    ]);

    for (const adSet of adSets) {
      const adSetRow = adSetInsights.get(adSet.adSetId);
      if (!adSetRow || !adSet.dailyBudgetCents) continue;
      nextSnapshot[`meta-adset:${adSet.adSetId}`] = {
        spend: adSetRow.spend,
        costPerResult: adSetRow.costPerResult,
        ctr: adSetRow.ctr,
      };
      const adSetFinding = evaluateAdSetFinding({
        campaignName: campaign.name,
        adSetName: adSet.name,
        insights: adSetRow,
        dailyBudgetCents: adSet.dailyBudgetCents,
        currency,
      });
      if (adSetFinding) {
        await SignalUniverse.ingestRaw({
          ...scope,
          source: "meta-ads-performance-scan",
          category: "PERFORMANCE",
          externalRef: `meta-adset:${adSet.adSetId}:${adSetFinding.rule}`,
          title: adSetFinding.title,
          summary: adSetFinding.summary,
          reliability: 1,
        });
        if (adSetFinding.severity === "HIGH" && adSetFinding.suggestedAction) {
          await PerformanceOptimizer.proposeAdSetAction({
            scope,
            campaignId: campaign.campaignId,
            adSetId: adSet.adSetId,
            adSetName: adSet.name,
            currentDailyBudgetCents: adSet.dailyBudgetCents,
            finding: adSetFinding,
          });
        }
        if (adSetFinding.rule === "AD_FATIGUE") {
          await PerformanceOptimizer.proposeCreativeRefresh({
            scope,
            subjectId: adSet.adSetId,
            finding: adSetFinding,
          });
        }
      }
    }
  }

  await prisma.integrationCredential.update({
    where: { id: credential.id },
    data: {
      metadata: {
        ...metadata,
        lastAdsPerformanceScanAt: new Date().toISOString(),
        adsPerformanceScanFailureCount: 0,
        previousScanSnapshot: nextSnapshot,
      } as never,
    },
  });
}
