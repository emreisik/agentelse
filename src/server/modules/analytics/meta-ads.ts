import "server-only";

import type { AnalyticsPeriod } from "@/lib/module-flows/analytics/catalog";
import { ANALYTICS_COPY as COPY } from "@/lib/module-flows/analytics/copy";
import { isCurrencyCode } from "@/lib/module-flows/analytics/format";
import {
  MAX_CAMPAIGNS,
  MAX_RESULTS,
  failedSection,
  okSection,
  type ReportCampaign,
  type ReportMetric,
  type ReportResult,
  type ReportSection,
} from "@/lib/module-flows/analytics/report";
import { AdsFlags } from "@/lib/ads/flags";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import { AdsMirror } from "@/server/ads/mirror-reads";
import { MetaAdsQuery } from "@/server/integrations/meta-ads-query";
import {
  MetaApiError,
  toInsightsRow,
  type MetaInsightsRow,
} from "@/server/integrations/meta-client";

import { metaFailReason } from "./instagram";

// The Meta Ads section of a report: the ad account's totals for the period's
// date preset (spend, impressions, reach, clicks, CTR, CPC) straight from
// Meta, plus what the campaigns delivered (each campaign's own result, summed
// per kind) and the three campaigns that spent most. Two Graph reads at the
// account and the campaign level: reach is unique people, so it can only come
// from the account level, never from adding campaigns up. Never throws.

// Same Graph API version as meta-client.ts.
const GRAPH_BASE = "https://graph.facebook.com/v26.0";
const TIMEOUT_MS = 8_000;
const MAX_PAGES = 5;
const NAME_MAX = 120;

export const META_DATE_PRESET: Readonly<Record<AnalyticsPeriod, string>> = {
  7: "last_7d",
  28: "last_28d",
  90: "last_90d",
};

type AccountRow = {
  account_currency?: string;
  account_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
};

type CampaignRow = {
  campaign_id?: string;
  campaign_name?: string;
  objective?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: Array<{ action_type: string; value: string }>;
};

type Page<T> = { data?: T[]; paging?: { next?: string } };

async function graphGet<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new MetaApiError(
      timedOut ? "Meta API request timed out" : "Could not reach Meta API",
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = (
      body as {
        error?: { message?: string; code?: number; error_subcode?: number };
      } | null
    )?.error;
    throw new MetaApiError(
      failure?.message ?? `Meta API error (HTTP ${response.status})`,
      failure?.code,
      failure?.error_subcode,
    );
  }
  return body as T;
}

function insightsUrl(
  adAccountId: string,
  accessToken: string,
  params: Record<string, string>,
): string {
  const query = new URLSearchParams({ ...params, access_token: accessToken });
  return `${GRAPH_BASE}/${encodeURIComponent(adAccountId)}/insights?${query.toString()}`;
}

export async function fetchMetaAccountTotals(input: {
  adAccountId: string;
  accessToken: string;
  datePreset: string;
}): Promise<AccountRow | null> {
  const page = await graphGet<Page<AccountRow>>(
    insightsUrl(input.adAccountId, input.accessToken, {
      level: "account",
      fields:
        "account_currency,account_name,spend,impressions,reach,clicks,ctr,cpc",
      date_preset: input.datePreset,
    }),
  );
  // No row: the account delivered nothing in the window.
  return page.data?.[0] ?? null;
}

// Every campaign that delivered in the window (Meta leaves out the rest),
// following the pages Meta splits a long answer into.
export async function fetchMetaCampaignRows(input: {
  adAccountId: string;
  accessToken: string;
  datePreset: string;
}): Promise<CampaignRow[]> {
  const rows: CampaignRow[] = [];
  let url: string | undefined = insightsUrl(
    input.adAccountId,
    input.accessToken,
    {
      level: "campaign",
      fields:
        "campaign_id,campaign_name,objective,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions",
      date_preset: input.datePreset,
      limit: "100",
    },
  );
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body: Page<CampaignRow> = await graphGet<Page<CampaignRow>>(url);
    rows.push(...(body.data ?? []));
    url = body.paging?.next;
  }
  return rows;
}

function amount(value: string | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function accountMetrics(row: AccountRow | null): ReportMetric[] {
  const spend = amount(row?.spend);
  const impressions = amount(row?.impressions);
  const clicks = amount(row?.clicks);
  const metrics: ReportMetric[] = [
    { key: "ads.spend", value: spend },
    { key: "ads.impressions", value: impressions },
    // Aynadan okunan çok günlük aralıkta tekil erişim bilinmez: gösterilmez.
    ...(row && row.reach === undefined
      ? []
      : [{ key: "ads.reach" as const, value: amount(row?.reach) }]),
    { key: "ads.clicks", value: clicks },
  ];
  // Rates only where there is something to divide: Meta's own figures.
  if (impressions > 0)
    metrics.push({ key: "ads.ctr", value: amount(row?.ctr) });
  if (clicks > 0) metrics.push({ key: "ads.cpc", value: amount(row?.cpc) });
  return metrics;
}

type Delivered = { name: string; insights: MetaInsightsRow };

// A campaign's result is the action it was run for (a leads campaign reports
// its leads, the rest their main action: toInsightsRow, the scanner's rule).
export function deliveredCampaigns(rows: readonly CampaignRow[]): Delivered[] {
  const out: Delivered[] = [];
  for (const row of rows) {
    const insights = toInsightsRow(row, {
      preferLead: row.objective === "OUTCOME_LEADS",
    });
    if (insights.spend <= 0) continue;
    const name = (row.campaign_name ?? "").replace(/\s+/g, " ").trim();
    out.push({ name: name.slice(0, NAME_MAX) || COPY.campaign, insights });
  }
  return out;
}

// What the money bought, per kind of result, the kinds most spent on first.
export function resultsByKind(delivered: readonly Delivered[]): ReportResult[] {
  const kinds = new Map<string, { count: number; spend: number }>();
  for (const { insights } of delivered) {
    const label = insights.resultLabel;
    const count = insights.resultCount;
    if (!label || count === undefined || !(count > 0)) continue;
    const kind = kinds.get(label) ?? { count: 0, spend: 0 };
    kind.count += count;
    kind.spend += insights.spend;
    kinds.set(label, kind);
  }
  return [...kinds.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, MAX_RESULTS)
    .map(([label, kind]) => ({
      label,
      count: kind.count,
      costPerResult: kind.count > 0 ? kind.spend / kind.count : null,
    }));
}

export function topCampaigns(
  delivered: readonly Delivered[],
): ReportCampaign[] {
  return [...delivered]
    .sort((a, b) => b.insights.spend - a.insights.spend)
    .slice(0, MAX_CAMPAIGNS)
    .map(({ name, insights }) => ({
      name,
      spend: insights.spend,
      resultLabel: insights.resultLabel ?? null,
      results: insights.resultCount ?? null,
      costPerResult: insights.costPerResult ?? null,
    }));
}

// F2: hesap ve kampanya rakamları aynadan (Meta'ya çağrı yok). Ayna kapalıysa
// ya da hesap henüz senkronlanmadıysa null: canlı yol kullanılır.
async function collectFromMirror(
  projectId: string,
  period: AnalyticsPeriod,
): Promise<ReportSection | null> {
  if (!AdsFlags.sync()) return null;
  const account = await AdsMirror.accountFor(projectId);
  if (!account?.lastStructureAt) return null;
  const preset = META_DATE_PRESET[period];
  const [totalsById, campaigns] = await Promise.all([
    AdsMirror.insightsByObject(account, "ACCOUNT", preset),
    AdsMirror.campaigns(account, preset),
  ]);
  const total = totalsById.get(account.externalId);
  const totals: AccountRow | null = total
    ? {
        account_currency: account.currency ?? undefined,
        account_name: account.name ?? undefined,
        spend: String(total.spend),
        impressions: String(total.impressions),
        ...(total.reach !== undefined ? { reach: String(total.reach) } : {}),
        clicks: String(total.clicks),
        ctr: String(total.ctr),
        cpc: String(total.cpc),
      }
    : null;
  const delivered = campaigns
    .filter((campaign) => campaign.insights && campaign.insights.spend > 0)
    .map((campaign) => ({
      name: nameWithoutTag(campaign.name).slice(0, NAME_MAX) || COPY.campaign,
      insights: campaign.insights!,
    }));
  const currency = isCurrencyCode(account.currency) ? account.currency : null;
  return okSection("metaAds", {
    days: period,
    account: account.name ? account.name.slice(0, NAME_MAX) : null,
    currency,
    metrics: accountMetrics(totals),
    results: resultsByKind(delivered),
    campaigns: topCampaigns(delivered),
  });
}

export async function collectMetaAds(
  projectId: string,
  period: AnalyticsPeriod,
): Promise<ReportSection> {
  const mirrored = await collectFromMirror(projectId, period).catch(
    (error: unknown) => {
      console.error(
        "[analytics] meta ads mirror read failed:",
        error instanceof Error ? error.message : error,
      );
      return null;
    },
  );
  if (mirrored) return mirrored;
  const connection = await MetaAdsQuery.resolveConnection(projectId);
  if (connection.status === "NOT_CONNECTED") {
    return failedSection("metaAds", "not_connected");
  }
  if (connection.status === "NO_AD_ACCOUNT") {
    return failedSection("metaAds", "setup");
  }
  const call = {
    adAccountId: connection.adAccountId,
    accessToken: connection.accessToken,
    datePreset: META_DATE_PRESET[period],
  };
  try {
    const [totals, campaigns] = await Promise.all([
      fetchMetaAccountTotals(call),
      // The campaign view is an extra: the totals stand without it.
      fetchMetaCampaignRows(call).catch((error: unknown) => {
        console.error(
          "[analytics] meta ads campaigns read failed:",
          error instanceof Error ? error.message : error,
        );
        return [] as CampaignRow[];
      }),
    ]);
    const delivered = deliveredCampaigns(campaigns);
    const currency = isCurrencyCode(totals?.account_currency)
      ? totals.account_currency
      : null;
    const account = totals?.account_name?.replace(/\s+/g, " ").trim();
    return okSection("metaAds", {
      days: period,
      account: account ? account.slice(0, NAME_MAX) : null,
      currency,
      metrics: accountMetrics(totals),
      results: resultsByKind(delivered),
      campaigns: topCampaigns(delivered),
    });
  } catch (error) {
    await MetaAdsQuery.noteFailure(connection, error);
    const reason = metaFailReason(error);
    if (reason === "error") {
      console.error(
        "[analytics] meta ads read failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return failedSection("metaAds", reason);
  }
}
