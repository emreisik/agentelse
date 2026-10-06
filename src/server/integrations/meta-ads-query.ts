import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { prisma } from "@/lib/prisma";
import { AdsAccounts } from "@/server/ads/accounts";
import { AdsMirror } from "@/server/ads/mirror-reads";
import { markMetaCredentialExpiredOn } from "@/server/integrations/meta-credential-health";
import {
  fetchMetaLevelInsights,
  listMetaAdSets,
  listMetaAds,
  listMetaCampaigns,
  type MetaAdSetSummary,
  type MetaAdSummary,
  type MetaCampaignSummary,
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
  | {
      status: "READY";
      accessToken: string;
      adAccountId: string;
      // Which connection the token came from: a 190 answer marks it EXPIRED
      // (noteFailure, docs/meta-ads-plan.md F0b).
      credentialId: string;
    };

// One source for the account: src/server/ads/accounts.ts (docs/meta-ads-plan.md
// F1). The reads only need a connected account; the Page matters to the
// ad creative, not to a report.
async function resolveConnection(
  projectId: string,
): Promise<MetaAdsConnectionState> {
  const account = await AdsAccounts.resolveWithToken(projectId);
  if (account.status === "needs-connect") return { status: "NOT_CONNECTED" };
  if (account.status === "needs-account") return { status: "NO_AD_ACCOUNT" };
  if (!("accessToken" in account)) return { status: "NOT_CONNECTED" };
  return {
    status: "READY",
    accessToken: account.accessToken,
    adAccountId: account.adAccountId,
    credentialId: account.credentialId,
  };
}

// Every reader that catches a Meta error calls this: a 190 (token expired or
// revoked) marks the connection EXPIRED so the Integrations tile asks for a
// reconnect, instead of each screen failing while it still says Connected.
// Never throws.
async function noteFailure(
  conn: { credentialId: string },
  error: unknown,
): Promise<void> {
  await markMetaCredentialExpiredOn(error, conn.credentialId);
}

// The reads need only the token and the account; a 190 is noted with
// noteFailure on the full READY state.
type ReadyConnection = Pick<
  Extract<MetaAdsConnectionState, { status: "READY" }>,
  "accessToken" | "adAccountId"
> & { credentialId?: string };

// META_ADS_SYNC açıkken ve hesap en az bir kez senkronlanmışken okumalar
// aynadan yapılır (docs/meta-ads-plan.md §3.2); bayrak kapatılınca eski
// canlı yol döner.
async function mirrorAccountFor(conn: ReadyConnection) {
  if (!AdsFlags.sync()) return null;
  try {
    return await prisma.adsAccount.findFirst({
      where: {
        externalId: conn.adAccountId,
        lastStructureAt: { not: null },
        ...(conn.credentialId ? { credentialId: conn.credentialId } : {}),
      },
    });
  } catch {
    return null;
  }
}

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
  noteFailure,

  async campaigns(
    conn: ReadyConnection,
    datePreset: DatePreset = DEFAULT_DATE_PRESET,
    // Works only (the ads card refresh): list first, so a leads campaign
    // reports its leads exactly the way the scanner's digest does. Omitted,
    // the two calls run concurrently and nothing changes.
    options?: { preferLeadForLeadsCampaigns?: boolean },
  ): Promise<WithInsights<MetaCampaignSummary>[]> {
    const mirror = await mirrorAccountFor(conn);
    if (mirror) return AdsMirror.campaigns(mirror, datePreset);
    const baseInsights = {
      adAccountId: conn.adAccountId,
      accessToken: conn.accessToken,
      level: "campaign" as const,
      datePreset,
    };
    let campaigns: MetaCampaignSummary[];
    let insights: Awaited<ReturnType<typeof fetchMetaLevelInsights>>;
    if (options?.preferLeadForLeadsCampaigns) {
      campaigns = await listMetaCampaigns({
        adAccountId: conn.adAccountId,
        accessToken: conn.accessToken,
      });
      insights = await fetchMetaLevelInsights({
        ...baseInsights,
        preferLeadFor: new Set(
          campaigns
            .filter((c) => c.objective === "OUTCOME_LEADS")
            .map((c) => c.campaignId),
        ),
      });
    } else {
      [campaigns, insights] = await Promise.all([
        listMetaCampaigns({
          adAccountId: conn.adAccountId,
          accessToken: conn.accessToken,
        }),
        fetchMetaLevelInsights(baseInsights),
      ]);
    }
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
    // Envanter canlı kalır (düzenleme formu hedeflemeyi ister); rakamlar
    // ayna varsa aynadan.
    const mirror = await mirrorAccountFor(conn);
    const [adSets, insights] = await Promise.all([
      listMetaAdSets({ campaignId, accessToken: conn.accessToken }),
      mirror
        ? AdsMirror.insightsByObject(mirror, "ADSET", datePreset)
        : fetchMetaLevelInsights({
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
    const mirror = await mirrorAccountFor(conn);
    const [ads, insights] = await Promise.all([
      listMetaAds({ adSetId, accessToken: conn.accessToken }),
      mirror
        ? AdsMirror.insightsByObject(mirror, "AD", datePreset)
        : fetchMetaLevelInsights({
        adAccountId: conn.adAccountId,
        accessToken: conn.accessToken,
        level: "ad",
        datePreset,
        scopedTo: { field: "adset.id", value: adSetId },
      }),
    ]);
    return ads.map((a) => ({ ...a, insights: insights.get(a.adId) }));
  },

  // Compact snapshot for IdeaFoundry's "performance" lens (see
  // idea-foundry.ts) — best/worst campaign by cost-per-result plus an
  // objective breakdown, so a fresh idea generation for a PERFORMANCE
  // opportunity can reference real current numbers instead of guessing.
  // Returns null when there's nothing to summarize (not connected, or no
  // campaign had any delivery in the window) — the caller treats that as
  // "generate without performance context," not an error.
  async performanceSnapshotForProject(
    projectId: string,
    datePreset: DatePreset = DEFAULT_DATE_PRESET,
  ): Promise<PerformanceSnapshot | null> {
    const conn = await resolveConnection(projectId);
    if (conn.status !== "READY") return null;

    const campaigns = await MetaAdsQuery.campaigns(conn, datePreset);
    // Unlike buildAdsAnalysisText (a historical report, which must include
    // paused campaigns that still delivered in the window), this snapshot
    // feeds IdeaFoundry's "what's working right now" context for a NEW
    // campaign idea — a currently-paused campaign's strategy is a weaker
    // basis to build on, so effectiveStatus === "ACTIVE" is intentional here.
    const withDelivery = campaigns.filter(
      (c) => c.effectiveStatus === "ACTIVE" && (c.insights?.spend ?? 0) > 0,
    );
    if (withDelivery.length === 0) return null;

    const ranked = [...withDelivery].sort((a, b) => {
      const aCpr = a.insights?.costPerResult ?? Infinity;
      const bCpr = b.insights?.costPerResult ?? Infinity;
      return aCpr - bCpr;
    });
    // Non-null: ranked is a sort of withDelivery, and withDelivery.length is
    // already confirmed > 0 above.
    const best = ranked[0]!;
    const worst = ranked[ranked.length - 1]!;

    const objectiveDistribution: Record<string, number> = {};
    for (const c of withDelivery) {
      objectiveDistribution[c.objective] =
        (objectiveDistribution[c.objective] ?? 0) + 1;
    }

    return {
      activeCampaignCount: withDelivery.length,
      bestCampaign: {
        name: best.name,
        objective: best.objective,
        costPerResult: best.insights?.costPerResult,
        resultLabel: best.insights?.resultLabel,
      },
      worstCampaign:
        worst.campaignId !== best.campaignId
          ? {
              name: worst.name,
              objective: worst.objective,
              costPerResult: worst.insights?.costPerResult,
              resultLabel: worst.insights?.resultLabel,
            }
          : undefined,
      objectiveDistribution,
    };
  },
};

export type PerformanceSnapshot = {
  activeCampaignCount: number;
  bestCampaign: {
    name: string;
    objective: string;
    costPerResult?: number;
    resultLabel?: string;
  };
  worstCampaign?: {
    name: string;
    objective: string;
    costPerResult?: number;
    resultLabel?: string;
  };
  objectiveDistribution: Record<string, number>;
};
