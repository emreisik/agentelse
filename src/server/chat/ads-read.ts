import "server-only";

import { canShowAmount, formatMoney } from "@/lib/ads/money";
import { deliveryLabel } from "@/lib/ads/mirror";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import { AdsAccounts } from "@/server/ads/accounts";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { AdsMirror } from "@/server/ads/mirror-reads";
import {
  isDatePreset,
  MetaAdsQuery,
  type DatePreset,
} from "@/server/integrations/meta-ads-query";
import type { MetaInsightsRow } from "@/server/integrations/meta-client";

// Sohbet ajanının reklam okumaları (docs/meta-ads-plan.md §3.8, F2):
// get_ads_overview ve get_ad_performance. Ayna açıksa aynadan, değilse
// kullanıcının beklediği canlı okumayla; tutarlar yalnız para birimi
// biliniyorsa yazılır.

function money(major: number | undefined, currency: string | undefined) {
  if (major === undefined || !currency || !canShowAmount(currency)) return undefined;
  return `${major.toFixed(2)} ${currency}`;
}

function metrics(row: MetaInsightsRow | undefined, currency: string | undefined) {
  if (!row) return { delivered: false };
  return {
    delivered: row.impressions > 0,
    spend: money(row.spend, currency),
    impressions: row.impressions,
    ...(row.reach !== undefined ? { reach: row.reach } : {}),
    clicks: row.clicks,
    ctrPct: Math.round(row.ctr * 100) / 100,
    ...(row.resultCount !== undefined
      ? {
          results: row.resultCount,
          resultName: row.resultLabel,
          costPerResult: money(row.costPerResult, currency),
        }
      : { results: "unknown" }),
  };
}

export async function adsOverview(projectId: string) {
  const account = await AdsAccounts.resolve(projectId);
  if (account.status === "needs-connect") {
    return { status: "not_connected", note: "Meta Ads isn't connected. Point the client to Integrations." };
  }
  if (account.status === "needs-account") {
    return { status: "no_ad_account", note: "Meta Ads is connected but no ad account is selected." };
  }
  const [mirror, alerts] = await Promise.all([
    AdsMirror.accountFor(projectId),
    AdsAlerts.listOpen(projectId, 10).catch(() => []),
  ]);
  const conn = await MetaAdsQuery.resolveConnection(projectId);
  if (conn.status !== "READY") return { status: "not_connected" };
  const campaigns = await MetaAdsQuery.campaigns(conn, "last_7d");
  const currency = account.currency;
  const now = new Date();
  return {
    status: "ok",
    adAccount: account.adAccountName,
    currency,
    accountHealth: mirror?.healthStatus ?? account.healthStatus ?? "UNKNOWN",
    ...(mirror?.healthReason ? { accountIssue: mirror.healthReason } : {}),
    numbersUpdatedAt: mirror?.lastInsightsAt?.toISOString() ?? "live",
    accountTimezone: mirror?.timezoneName ?? undefined,
    period: "last 7 days (account time, today excluded)",
    campaigns: campaigns.slice(0, 20).map((campaign) => ({
      id: campaign.campaignId,
      name: nameWithoutTag(campaign.name),
      objective: campaign.objective,
      state:
        campaign.endTime !== undefined
          ? deliveryLabel(
              {
                configuredStatus: campaign.status,
                effectiveStatus: campaign.effectiveStatus,
                endTime: campaign.endTime ? new Date(campaign.endTime) : null,
              },
              now,
            )
          : campaign.effectiveStatus,
      ...(campaign.dailyBudgetCents !== undefined
        ? { dailyBudget: formatMoney(campaign.dailyBudgetCents, currency) }
        : {}),
      ...(campaign.createdByAgentelse ? { madeByAgentelse: true } : {}),
      last7Days: metrics(campaign.insights, currency),
    })),
    openAlerts: alerts.map((alert) => ({
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
    })),
    note: "Numbers are Meta's, in the ad account's time zone. Never invent a number that isn't here.",
  };
}

export async function adPerformance(
  projectId: string,
  args: { level: "campaign" | "adset" | "ad"; parentId?: string; period?: string },
) {
  const conn = await MetaAdsQuery.resolveConnection(projectId);
  if (conn.status !== "READY") return { status: "not_connected" };
  const account = await AdsAccounts.resolve(projectId);
  const currency = account.currency;
  const preset: DatePreset =
    args.period && isDatePreset(args.period) ? args.period : "last_7d";
  if (args.level === "campaign") {
    const rows = await MetaAdsQuery.campaigns(conn, preset);
    return {
      status: "ok",
      period: preset,
      rows: rows.slice(0, 30).map((row) => ({
        id: row.campaignId,
        name: nameWithoutTag(row.name),
        status: row.effectiveStatus,
        ...metrics(row.insights, currency),
      })),
    };
  }
  if (!args.parentId || !/^\d+$/.test(args.parentId)) {
    return {
      status: "missing_parent",
      note:
        args.level === "adset"
          ? "Give the campaign id (from get_ads_overview) as parentId."
          : "Give the ad set id (from level=adset) as parentId.",
    };
  }
  if (args.level === "adset") {
    const rows = await MetaAdsQuery.adSets(conn, args.parentId, preset);
    return {
      status: "ok",
      period: preset,
      rows: rows.slice(0, 30).map((row) => ({
        id: row.adSetId,
        name: nameWithoutTag(row.name),
        status: row.effectiveStatus,
        optimizationGoal: row.optimizationGoal,
        ...metrics(row.insights, currency),
      })),
    };
  }
  const rows = await MetaAdsQuery.ads(conn, args.parentId, preset);
  return {
    status: "ok",
    period: preset,
    rows: rows.slice(0, 30).map((row) => ({
      id: row.adId,
      name: nameWithoutTag(row.name),
      status: row.effectiveStatus,
      ...metrics(row.insights, currency),
    })),
  };
}
