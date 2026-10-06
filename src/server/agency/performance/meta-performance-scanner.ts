import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import {
  PerformanceOptimizer,
  type AccountContext,
} from "./performance-optimizer";
import { resultSourceForGoal, type ResultSource } from "@/lib/ads/results";
import { markMetaCredentialExpiredOn } from "@/server/integrations/meta-credential-health";
import {
  evaluateAdSetFinding,
  evaluateCampaignFinding,
  evaluateTrendFinding,
  type ScanSnapshot,
} from "./meta-performance-rules";
import {
  META_PROVIDER,
  fetchMetaLevelInsights,
  listMetaAdSets,
  listMetaCampaigns,
  type MetaAdsMetadata,
} from "@/server/integrations/meta-client";
import { isWorksEnabled } from "@/server/works/flag";
import { buildAdsDigest } from "@/lib/works/ads-insight";

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
  metadata: MetaAdsMetadata,
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
      where: { provider: META_PROVIDER.ads, status: "ACTIVE" },
      // Over-fetch a bit since not every ACTIVE credential is due — filtered
      // in memory below (metadata is unstructured JSON, can't push the due
      // check into the WHERE clause).
      take: limit * 4,
      orderBy: { updatedAt: "asc" },
    });

    let scanned = 0;
    for (const credential of candidates) {
      if (scanned >= limit) break;
      const metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
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
        // 190: the token expired or was revoked — the connection says so and
        // the Integrations tile asks for a reconnect (F0b).
        await markMetaCredentialExpiredOn(error, credential.id);
        // lastAdsPerformanceScanAt must advance on failure too, not only on
        // success — isDue() only enters the backoff branch once this is set.
        // Written key by key: a whole-object write would put back an ad
        // account selection the user changed during the scan, and later
        // work would go to the wrong client's account (F0b).
        await writeMetadataKeys(credential.id, {
          lastAdsPerformanceScanAt: new Date().toISOString(),
          adsPerformanceScanFailureCount:
            (metadata.adsPerformanceScanFailureCount ?? 0) + 1,
        }).catch((writeError) => {
          console.error(
            `[meta-performance-scanner] backoff for credential ${credential.id} not written:`,
            writeError instanceof Error ? writeError.message : writeError,
          );
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
  metadata: MetaAdsMetadata,
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

  const worksOn = isWorksEnabled();
  // Works only: with the lead preference on, a stored baseline that does not
  // name the same result (an older click-based scan, or a scan from before the
  // flag) is no baseline at all: no spurious regression, no "vs last check".
  const baselineFor = (
    previous: ScanSnapshot | undefined,
    currentLabel: string | undefined,
  ): ScanSnapshot | undefined => {
    if (!worksOn || !previous) return previous;
    return previous.resultLabel === currentLabel ? previous : undefined;
  };
  let campaigns: Awaited<ReturnType<typeof listMetaCampaigns>>;
  let campaignInsights: Awaited<ReturnType<typeof fetchMetaLevelInsights>>;
  if (worksOn) {
    // Works only: objectives are needed first so leads campaigns report leads.
    campaigns = await listMetaCampaigns({ adAccountId, accessToken });
    campaignInsights = await fetchMetaLevelInsights({
      adAccountId,
      accessToken,
      level: "campaign",
      datePreset: "last_7d",
      preferLeadFor: new Set(
        campaigns
          .filter((c) => c.objective === "OUTCOME_LEADS")
          .map((c) => c.campaignId),
      ),
    });
  } else {
    [campaigns, campaignInsights] = await Promise.all([
      listMetaCampaigns({ adAccountId, accessToken }),
      fetchMetaLevelInsights({
        adAccountId,
        accessToken,
        level: "campaign",
        datePreset: "last_7d",
      }),
    ]);
  }

  const active = campaigns
    .filter((c) => c.effectiveStatus === "ACTIVE")
    .map((c) => ({ campaign: c, insights: campaignInsights.get(c.campaignId) }))
    .filter((row) => row.insights && row.insights.spend > 0)
    .sort((a, b) => (b.insights!.spend ?? 0) - (a.insights!.spend ?? 0))
    .slice(0, MAX_CAMPAIGNS_PER_SCAN);

  const account = { adAccountId, currency };

  for (const { campaign, insights } of active) {
    if (!insights) continue;

    // ABO (budget on the ad sets — every campaign Agentelse builds): the
    // campaign has no budget to judge or change, so its ad sets are judged
    // and any proposal goes to the ad set (docs/meta-ads-plan.md F0b). Before
    // this, the scanner skipped exactly the campaigns Agentelse created.
    if (!campaign.dailyBudgetCents) {
      await scanAdSets({
        campaign,
        adAccountId,
        accessToken,
        currency,
        account,
        scope,
        nextSnapshot,
      });
      continue;
    }

    const snapshotKey = `meta-campaign:${campaign.campaignId}`;
    nextSnapshot[snapshotKey] = {
      spend: insights.spend,
      costPerResult: insights.costPerResult,
      ctr: insights.ctr,
      ...(worksOn && insights.resultLabel
        ? { resultLabel: insights.resultLabel }
        : {}),
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
          account,
        });
      }
      // AD_FATIGUE stays a Signal (a suggestion): no unapproved image
      // generation is started from it any more (F0b).
      continue;
    }

    // No absolute-threshold finding — check for a trend regression instead
    // (e.g. CPA creeping up scan-over-scan without yet crossing an absolute
    // threshold). Informational only (Track 1), see evaluateTrendFinding.
    const trendFinding = evaluateTrendFinding({
      entityName: campaign.name,
      current: nextSnapshot[snapshotKey],
      previous: baselineFor(
        previousSnapshot[snapshotKey],
        nextSnapshot[snapshotKey]?.resultLabel,
      ),
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

    await scanAdSets({
      campaign,
      adAccountId,
      accessToken,
      currency,
      account,
      scope,
      nextSnapshot,
    });
  }

  await writeMetadataKeys(credential.id, {
    lastAdsPerformanceScanAt: new Date().toISOString(),
    adsPerformanceScanFailureCount: 0,
    previousScanSnapshot: nextSnapshot,
  });
  if (worksOn) {
    // Works only: a separate single-key write, so the digest can never revert
    // another metadata key (e.g. a selectedAdAccountId changed meanwhile). A
    // digest failure never fails the scan.
    try {
      const digest = {
        ...buildAdsDigest({
          insights: campaignInsights,
          // A baseline that never named its result (a scan from before the
          // lead preference) is dropped, like a baseline with another name.
          previousSnapshot: Object.fromEntries(
            Object.entries(previousSnapshot).filter(
              ([, row]) => row.resultLabel !== undefined,
            ),
          ),
          campaigns,
          currency,
          now: new Date(),
        }),
        // Binds the numbers to the account they were read from.
        adAccountId,
      };
      await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{adsDigest}', ${JSON.stringify(digest)}::jsonb) WHERE id = ${credential.id} AND status = 'ACTIVE'`;
    } catch (error) {
      console.error(
        `[meta-performance-scanner] digest write failed for credential ${credential.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

// Bir kampanyanın ad set'leri: her ad set kendi optimizasyon hedefinin
// sonucuyla (src/lib/ads/results.ts) ve kendi bütçesiyle değerlendirilir;
// öneri META_ADSET_UPDATE olarak ad set'e gider.
async function scanAdSets(input: {
  campaign: { campaignId: string; name: string };
  adAccountId: string;
  accessToken: string;
  currency: string;
  account: AccountContext;
  scope: { workspaceId: string; projectId: string; brandId: string };
  nextSnapshot: Record<string, ScanSnapshot>;
}): Promise<void> {
  const { campaign, adAccountId, accessToken, currency, scope } = input;
  const adSets = await listMetaAdSets({
    campaignId: campaign.campaignId,
    accessToken,
  });
  const resultSourceFor = new Map<string, ResultSource>();
  for (const adSet of adSets) {
    const source = resultSourceForGoal(adSet.optimizationGoal);
    if (source) resultSourceFor.set(adSet.adSetId, source);
  }
  const adSetInsights = await fetchMetaLevelInsights({
    adAccountId,
    accessToken,
    level: "adset",
    datePreset: "last_7d",
    scopedTo: { field: "campaign.id", value: campaign.campaignId },
    resultSourceFor,
  });

  for (const adSet of adSets) {
    const adSetRow = adSetInsights.get(adSet.adSetId);
    if (!adSetRow || !adSet.dailyBudgetCents) continue;
    input.nextSnapshot[`meta-adset:${adSet.adSetId}`] = {
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
    if (!adSetFinding) continue;
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
        account: input.account,
      });
    }
  }
}

// IntegrationCredential.metadata anahtar anahtar yazılır (jsonb_set): bütün
// nesneyi geri yazmak, tarama sürerken yapılan hesap seçimini eski değere
// döndürüyordu (docs/meta-ads-plan.md F0b).
async function writeMetadataKeys(
  credentialId: string,
  values: Record<string, unknown>,
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), ${[key]}::text[], ${JSON.stringify(value)}::jsonb) WHERE id = ${credentialId}`;
  }
}
