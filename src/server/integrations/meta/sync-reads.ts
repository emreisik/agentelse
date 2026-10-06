import "server-only";

import { MetaApiError } from "./errors";
import {
  ACCOUNT_FUNDING_FIELDS,
  ACCOUNT_HEALTH_FIELDS,
  ACCOUNT_OPTIONAL_FIELDS,
  AD_FIELDS,
  AD_RANKING_FIELDS,
  ADSET_FIELDS,
  CAMPAIGN_FIELDS,
  INSIGHT_FIELDS,
  INSIGHT_RESULT_FIELDS,
  OBJECT_STATUS_FIELDS,
  WINDOW_FIELDS,
} from "./fields";
import { metaFetch } from "./graph";
import { requestPages } from "./paging";
import { GRAPH_BASE } from "./version";

// Ayna senkronunun Meta okumaları (docs/meta-ads-plan.md §3.2). Hepsi
// çağıranın verdiği çağrı bağlamında (hesap + P2 şeridi) koşar.

function url(path: string, params: Record<string, string>): string {
  return `${GRAPH_BASE}/${path}?${new URLSearchParams(params).toString()}`;
}

export type AccountHealthRead = {
  account_status?: number;
  disable_reason?: number;
  currency?: string;
  timezone_name?: string;
  spend_cap?: string;
  amount_spent?: string;
  min_daily_budget?: number | string;
  user_tasks?: string[];
  business?: { id?: string; name?: string };
  is_personal?: number | boolean;
  funding_source_details?: unknown;
  hasFundingInfo: boolean;
  min_campaign_group_spend_cap?: number | string;
  default_dsa_payor?: string;
  default_dsa_beneficiary?: string;
  minimumBudgets?: unknown;
  pixels?: {
    id: string;
    name?: string;
    last_fired_time?: string;
    is_unavailable?: boolean;
  }[];
};

// Çekirdek alanlar zorunlu; ödeme, isteğe bağlı alanlar, asgari bütçeler ve
// pikseller ayrı ve hataya dayanıklı okunur (izin ya da alan desteği yoksa
// bütün sağlık okuması düşmesin).
export async function readAccountHealth(
  adAccountId: string,
  accessToken: string,
): Promise<AccountHealthRead> {
  const core = await metaFetch<AccountHealthRead>(
    url(adAccountId, {
      fields: ACCOUNT_HEALTH_FIELDS,
      access_token: accessToken,
    }),
  );
  const [funding, optional, minimums, pixels] = await Promise.allSettled([
    metaFetch<{ funding_source_details?: unknown }>(
      url(adAccountId, {
        fields: ACCOUNT_FUNDING_FIELDS,
        access_token: accessToken,
      }),
    ),
    metaFetch<Partial<AccountHealthRead>>(
      url(adAccountId, {
        fields: ACCOUNT_OPTIONAL_FIELDS,
        access_token: accessToken,
      }),
    ),
    metaFetch<{ data?: unknown }>(
      url(`${adAccountId}/minimum_budgets`, { access_token: accessToken }),
    ),
    metaFetch<{ data?: AccountHealthRead["pixels"] }>(
      url(`${adAccountId}/adspixels`, {
        fields: "id,name,last_fired_time,is_unavailable",
        access_token: accessToken,
      }),
    ),
  ]);
  return {
    ...core,
    hasFundingInfo: funding.status === "fulfilled",
    ...(funding.status === "fulfilled"
      ? { funding_source_details: funding.value.funding_source_details }
      : {}),
    ...(optional.status === "fulfilled" ? optional.value : {}),
    ...(minimums.status === "fulfilled"
      ? { minimumBudgets: minimums.value.data ?? minimums.value }
      : {}),
    ...(pixels.status === "fulfilled"
      ? { pixels: pixels.value.data ?? [] }
      : {}),
  };
}

export type RawCampaign = {
  id: string;
  name?: string;
  status?: string;
  configured_status?: string;
  effective_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  spend_cap?: string;
  budget_remaining?: string;
  bid_strategy?: string;
  special_ad_categories?: string[];
  issues_info?: unknown;
  created_time?: string;
  updated_time?: string;
};

export type RawAdSet = {
  id: string;
  name?: string;
  campaign_id?: string;
  status?: string;
  configured_status?: string;
  effective_status?: string;
  optimization_goal?: string;
  billing_event?: string;
  destination_type?: string;
  promoted_object?: unknown;
  targeting?: unknown;
  learning_stage_info?: {
    status?: string;
    conversions?: number;
    last_sig_edit_ts?: number;
  };
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  start_time?: string;
  end_time?: string;
  issues_info?: unknown;
  created_time?: string;
  updated_time?: string;
};

export type RawAd = {
  id: string;
  name?: string;
  adset_id?: string;
  campaign_id?: string;
  status?: string;
  configured_status?: string;
  effective_status?: string;
  creative?: { id?: string; effective_object_story_id?: string };
  ad_review_feedback?: unknown;
  failed_delivery_checks?: unknown;
  issues_info?: unknown;
  created_time?: string;
  updated_time?: string;
};

export async function listAccountStructure(
  adAccountId: string,
  accessToken: string,
): Promise<{
  campaigns: RawCampaign[];
  adSets: RawAdSet[];
  ads: RawAd[];
  truncated: boolean;
}> {
  const [campaigns, adSets, ads] = await Promise.all([
    requestPages<RawCampaign>(
      url(`${adAccountId}/campaigns`, {
        fields: CAMPAIGN_FIELDS,
        limit: "100",
        access_token: accessToken,
      }),
      { label: "campaigns" },
    ),
    requestPages<RawAdSet>(
      url(`${adAccountId}/adsets`, {
        fields: ADSET_FIELDS,
        limit: "100",
        access_token: accessToken,
      }),
      { label: "adsets" },
    ),
    requestPages<RawAd>(
      url(`${adAccountId}/ads`, {
        fields: AD_FIELDS,
        limit: "100",
        access_token: accessToken,
      }),
      { label: "ads" },
    ),
  ]);
  return {
    campaigns: campaigns.items,
    adSets: adSets.items,
    ads: ads.items,
    truncated: campaigns.truncated || adSets.truncated || ads.truncated,
  };
}

// Listede görünmeyen nesne: arşivlenmiş mi, silinmiş mi, yoksa erişim mi yok?
export async function readObjectStatus(
  objectId: string,
  accessToken: string,
): Promise<{ effective_status?: string; configured_status?: string } | null> {
  try {
    return await metaFetch(
      url(objectId, {
        fields: OBJECT_STATUS_FIELDS,
        access_token: accessToken,
      }),
    );
  } catch (error) {
    if (
      error instanceof MetaApiError &&
      error.metaErrorCode === 100 &&
      error.metaErrorSubcode === 33
    ) {
      return null;
    }
    throw error;
  }
}

export type RawInsight = {
  date_start?: string;
  date_stop?: string;
  account_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
  video_thruplay_watched_actions?: { action_type: string; value: string }[];
  attribution_setting?: string;
  results?: { indicator?: string; values?: { value?: string }[] }[];
  cost_per_result?: unknown;
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
};

// Meta `results` alanını kabul ediyor mu? Süreç başına bir kez öğrenilir.
let resultsFieldSupported = true;

export type InsightsLevel = "account" | "campaign" | "adset" | "ad";

// Günlük satırlar (time_increment=1). `objectId` verilirse kimlikle okunur:
// silinen / arşivlenen alt nesneler ebeveynin toplamında kalır (§3.2).
export async function readDailyInsights(input: {
  adAccountId: string;
  accessToken: string;
  level: InsightsLevel;
  since: string;
  until: string;
  objectId?: string;
  includeArchived?: boolean;
}): Promise<RawInsight[]> {
  const base = input.objectId ?? input.adAccountId;
  const fields = [
    INSIGHT_FIELDS,
    ...(input.level === "ad" ? [AD_RANKING_FIELDS] : []),
  ];
  const build = (withResults: boolean) => {
    const params: Record<string, string> = {
      level: input.level,
      fields: [...fields, ...(withResults ? [INSIGHT_RESULT_FIELDS] : [])].join(
        ",",
      ),
      time_range: JSON.stringify({ since: input.since, until: input.until }),
      time_increment: "1",
      limit: "500",
      access_token: input.accessToken,
    };
    if (
      input.includeArchived &&
      (input.level === "adset" || input.level === "ad")
    ) {
      params.filtering = JSON.stringify([
        {
          field: `${input.level === "adset" ? "adset" : "ad"}.effective_status`,
          operator: "IN",
          value: [
            "ACTIVE",
            "PAUSED",
            "ARCHIVED",
            "CAMPAIGN_PAUSED",
            "ADSET_PAUSED",
            "IN_PROCESS",
            "WITH_ISSUES",
            "DISAPPROVED",
            "PENDING_REVIEW",
            "PREAPPROVED",
            "PENDING_BILLING_INFO",
          ],
        },
      ]);
    }
    return url(`${base}/insights`, params);
  };
  if (resultsFieldSupported) {
    try {
      return (
        await requestPages<RawInsight>(build(true), { label: "insights" })
      ).items;
    } catch (error) {
      if (!(error instanceof MetaApiError) || error.metaErrorCode !== 100) {
        throw error;
      }
      // `results` desteklenmiyor: yedek eşlemeye düş, bir daha isteme.
      resultsFieldSupported = false;
    }
  }
  return (await requestPages<RawInsight>(build(false), { label: "insights" }))
    .items;
}

// 7 ve 28 günlük pencere metrikleri (tekil kişi: günlük satırlardan
// toplanamaz).
export async function readWindowStats(input: {
  adAccountId: string;
  accessToken: string;
  level: "adset" | "ad";
  preset: "last_7d" | "last_28d";
}): Promise<
  {
    adset_id?: string;
    ad_id?: string;
    reach?: string;
    frequency?: string;
    impressions?: string;
  }[]
> {
  return (
    await requestPages(
      url(`${input.adAccountId}/insights`, {
        level: input.level,
        fields: [`${input.level}_id`, WINDOW_FIELDS].join(","),
        date_preset: input.preset,
        limit: "500",
        access_token: input.accessToken,
      }),
      { label: "window-stats" },
    )
  ).items as never;
}

// Reklam hesabının kullanabildiği Instagram hesapları (P9: reklamın IG
// kimliği; boşsa IG yerleşimleri Sayfa kimliğiyle çalışır).
export async function readAdAccountInstagram(
  adAccountId: string,
  accessToken: string,
): Promise<{ id: string; username?: string }[]> {
  const body = await metaFetch<{ data?: { id: string; username?: string }[] }>(
    url(`${adAccountId}/instagram_accounts`, {
      fields: "id,username",
      limit: "25",
      access_token: accessToken,
    }),
  );
  return body.data ?? [];
}

// Hesabın pikselleri ve son 7 günde olay gelip gelmediği (açılış sayfası
// görüntüleme optimizasyonu ancak piksel varken anlamlıdır).
export async function readPixelSummary(
  adAccountId: string,
  accessToken: string,
  now: Date = new Date(),
): Promise<{ pixels: number; firedLast7d: boolean }> {
  const body = await metaFetch<{
    data?: { id: string; last_fired_time?: string; is_unavailable?: boolean }[];
  }>(
    url(`${adAccountId}/adspixels`, {
      fields: "id,last_fired_time,is_unavailable",
      access_token: accessToken,
    }),
  );
  const pixels = (body.data ?? []).filter((pixel) => !pixel.is_unavailable);
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60_000;
  return {
    pixels: pixels.length,
    firedLast7d: pixels.some(
      (pixel) =>
        Boolean(pixel.last_fired_time) && Date.parse(pixel.last_fired_time!) >= weekAgo,
    ),
  };
}
