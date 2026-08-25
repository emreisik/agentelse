import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  fetchMetaLevelInsights,
  listMetaAdSets,
  listMetaAds,
  listMetaCampaigns,
  type MetaAdSetSummary,
  type MetaAdSummary,
  type MetaCampaignSummary,
  type MetaCredentialMetadata,
  type MetaInsightsRow,
} from "@/server/integrations/meta-client";

// A row with its matching insights merged in — `insights` is undefined when
// the entity had no delivery in the selected date window (a brand-new or
// long-paused campaign/adset/ad), not an error.
export type WithInsights<T> = T & { insights?: MetaInsightsRow };

export const DEFAULT_DATE_PRESET = "last_30d";
export const DATE_PRESETS = [
  { value: "last_7d", label: "Last 7 days" },
  { value: "last_14d", label: "Last 14 days" },
  { value: "last_30d", label: "Last 30 days" },
  { value: "last_90d", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "maximum", label: "All time" },
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number]["value"];

export function isDatePreset(value: string): value is DatePreset {
  return DATE_PRESETS.some((p) => p.value === value);
}

// Read-only query layer behind the /ads page — always hits Meta live (no
// local Campaign/AdSet/Ad table), the same "fetch fresh every time" spirit
// as fetchMetaAdsInsights. Kept as its own module (not inline in the page)
// so that if this ever needs to move to a synced/cached model, only this
// file changes — callers keep the same shape.
export type MetaAdsConnectionState =
  | { status: "NOT_CONNECTED" }
  | { status: "NO_AD_ACCOUNT" }
  | { status: "READY"; accessToken: string; adAccountId: string };

async function resolveConnection(
  projectId: string,
): Promise<MetaAdsConnectionState> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "meta" } },
  });
  if (!credential || credential.status !== "ACTIVE") {
    return { status: "NOT_CONNECTED" };
  }
  const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
  if (!metadata.selectedAdAccountId) {
    return { status: "NO_AD_ACCOUNT" };
  }
  return {
    status: "READY",
    accessToken: decryptSecret(credential.encryptedSecret),
    adAccountId: metadata.selectedAdAccountId,
  };
}

type ReadyConnection = Extract<MetaAdsConnectionState, { status: "READY" }>;

// campaigns/adSets/ads all take an already-resolved connection rather than
// a projectId — resolveConnection() does a Prisma lookup + decryptSecret,
// and the /ads page needs all three of these in one render (to know which
// level of the drill-down to show), so resolving it once in the page and
// threading it through avoids doing that same lookup 2-3 times per request.
//
// Each also fetches insights for its level with ONE extra call (see
// fetchMetaLevelInsights — `level=campaign/adset/ad` returns every row's
// numbers in a single request) and merges them in by id, run concurrently
// with the inventory listing call since neither depends on the other.
export const MetaAdsQuery = {
  resolveConnection,

  async campaigns(
    conn: ReadyConnection,
    datePreset: DatePreset = DEFAULT_DATE_PRESET,
  ): Promise<WithInsights<MetaCampaignSummary>[]> {
    const [campaigns, insights] = await Promise.all([
      listMetaCampaigns({
        adAccountId: conn.adAccountId,
        accessToken: conn.accessToken,
      }),
      fetchMetaLevelInsights({
        adAccountId: conn.adAccountId,
        accessToken: conn.accessToken,
        level: "campaign",
        datePreset,
      }),
    ]);
    return campaigns.map((c) => ({
      ...c,
      insights: insights.get(c.campaignId),
    }));
  },

  async adSets(
    conn: ReadyConnection,
    campaignId: string,
    datePreset: DatePreset = DEFAULT_DATE_PRESET,
  ): Promise<WithInsights<MetaAdSetSummary>[]> {
    const [adSets, insights] = await Promise.all([
      listMetaAdSets({ campaignId, accessToken: conn.accessToken }),
      fetchMetaLevelInsights({
        adAccountId: conn.adAccountId,
        accessToken: conn.accessToken,
        level: "adset",
        datePreset,
        // Scoped to this one campaign's children — without it, an account
        // with thousands of ad sets would pull insights for all of them on
        // every drill-down into a single campaign.
        scopedTo: { field: "campaign.id", value: campaignId },
      }),
    ]);
    return adSets.map((a) => ({ ...a, insights: insights.get(a.adSetId) }));
  },

  async ads(
    conn: ReadyConnection,
    adSetId: string,
    datePreset: DatePreset = DEFAULT_DATE_PRESET,
  ): Promise<WithInsights<MetaAdSummary>[]> {
    const [ads, insights] = await Promise.all([
      listMetaAds({ adSetId, accessToken: conn.accessToken }),
      fetchMetaLevelInsights({
        adAccountId: conn.adAccountId,
        accessToken: conn.accessToken,
        level: "ad",
        datePreset,
        scopedTo: { field: "adset.id", value: adSetId },
      }),
    ]);
    return ads.map((a) => ({ ...a, insights: insights.get(a.adId) }));
  },
};
