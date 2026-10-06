import "server-only";

import {
  CREATIVE_FEATURES_OPT_IN,
  CREATIVE_FEATURES_OPT_OUT,
} from "@/lib/ads/launch-spec";
import {
  buildTargetingSpec,
  type MetaAdSetTargeting,
} from "@/server/integrations/meta-client";

import { metaFetch } from "./graph";
import { GRAPH_BASE } from "./version";

// Güvenli lansmanın Meta yazmaları (docs/meta-ads-plan.md §3.4 "Gönderilecek
// alanlar"). Her oluşturma `validateOnly` ile de çağrılabilir: Meta isteği
// doğrular, nesne kurmaz (`execution_options=["validate_only"]`).

type Created = { id?: string; success?: boolean };

function form(fields: Record<string, string | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  return body.toString();
}

async function post(path: string, fields: Record<string, string | undefined>): Promise<Created> {
  return metaFetch<Created>(`${GRAPH_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(fields),
  });
}

const VALIDATE = JSON.stringify(["validate_only"]);

export async function postCampaign(input: {
  adAccountId: string;
  accessToken: string;
  name: string;
  objective: string;
  specialAdCategories: string[];
  specialAdCategoryCountries?: string[];
  spendCapMinor?: number | null;
  validateOnly?: boolean;
}): Promise<Created> {
  return post(`${input.adAccountId}/campaigns`, {
    name: input.name,
    objective: input.objective,
    status: "PAUSED",
    buying_type: "AUCTION",
    special_ad_categories: JSON.stringify(input.specialAdCategories),
    special_ad_category_country: input.specialAdCategoryCountries?.length
      ? JSON.stringify(input.specialAdCategoryCountries)
      : undefined,
    // ABO: bütçe ad set'te; Meta ikisini birden almaz.
    is_adset_budget_sharing_enabled: "false",
    spend_cap:
      input.spendCapMinor && input.spendCapMinor > 0
        ? String(input.spendCapMinor)
        : undefined,
    execution_options: input.validateOnly ? VALIDATE : undefined,
    access_token: input.accessToken,
  });
}

export async function postAdSet(input: {
  adAccountId: string;
  accessToken: string;
  campaignId: string;
  name: string;
  dailyBudgetMinor: number;
  startTime: number;
  endTime: number;
  optimizationGoal: string;
  billingEvent: string;
  destinationType?: string;
  promotedObject?: Record<string, string>;
  targeting: MetaAdSetTargeting;
  advantageAudience: 0 | 1;
  dsa?: { beneficiary: string; payor: string };
  frequencyControl?: { maxImpressions: number; days: number };
  status: "ACTIVE" | "PAUSED";
  validateOnly?: boolean;
}): Promise<Created> {
  return post(`${input.adAccountId}/adsets`, {
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: String(input.dailyBudgetMinor),
    start_time: String(input.startTime),
    end_time: String(input.endTime),
    billing_event: input.billingEvent,
    optimization_goal: input.optimizationGoal,
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: input.destinationType,
    promoted_object: input.promotedObject
      ? JSON.stringify(input.promotedObject)
      : undefined,
    targeting: JSON.stringify(
      buildTargetingSpec(input.targeting, {
        advantageAudience: input.advantageAudience,
      }),
    ),
    dsa_beneficiary: input.dsa?.beneficiary.slice(0, 512),
    dsa_payor: input.dsa?.payor.slice(0, 512),
    frequency_control_specs: input.frequencyControl
      ? JSON.stringify([
          {
            event: "IMPRESSIONS",
            interval_days: input.frequencyControl.days,
            max_frequency: input.frequencyControl.maxImpressions,
          },
        ])
      : undefined,
    status: input.status,
    execution_options: input.validateOnly ? VALIDATE : undefined,
    access_token: input.accessToken,
  });
}

export type CreativeInput = {
  adAccountId: string;
  accessToken: string;
  name: string;
  pageId: string;
  instagramUserId?: string;
  imageHash: string;
  message: string;
  link: string;
  callToAction: string;
  headline?: string;
  urlTags?: string;
  // K14: Meta AI dönüşümleri açıkça; reddedilirse gönderilmeden denenir.
  features?: { send: boolean; multiAdvertiser: "OPT_IN" | "OPT_OUT" };
  validateOnly?: boolean;
};

export function objectStorySpec(input: Pick<
  CreativeInput,
  "pageId" | "instagramUserId" | "imageHash" | "message" | "link" | "callToAction" | "headline"
>) {
  return {
    page_id: input.pageId,
    ...(input.instagramUserId ? { instagram_user_id: input.instagramUserId } : {}),
    link_data: {
      image_hash: input.imageHash,
      link: input.link,
      message: input.message,
      ...(input.headline ? { name: input.headline } : {}),
      call_to_action: { type: input.callToAction, value: { link: input.link } },
    },
  };
}

export function creativeFeaturesSpec() {
  const features: Record<string, { enroll_status: "OPT_IN" | "OPT_OUT" }> = {};
  for (const key of CREATIVE_FEATURES_OPT_OUT) features[key] = { enroll_status: "OPT_OUT" };
  for (const key of CREATIVE_FEATURES_OPT_IN) features[key] = { enroll_status: "OPT_IN" };
  return { creative_features_spec: features };
}

export async function postCreative(input: CreativeInput): Promise<Created> {
  const send = input.features?.send ?? false;
  return post(`${input.adAccountId}/adcreatives`, {
    name: input.name,
    object_story_spec: JSON.stringify(objectStorySpec(input)),
    url_tags: input.urlTags,
    degrees_of_freedom_spec: send ? JSON.stringify(creativeFeaturesSpec()) : undefined,
    contextual_multi_ads: send
      ? JSON.stringify({ enroll_status: input.features?.multiAdvertiser ?? "OPT_OUT" })
      : undefined,
    execution_options: input.validateOnly ? VALIDATE : undefined,
    access_token: input.accessToken,
  });
}

export async function postAd(input: {
  adAccountId: string;
  accessToken: string;
  name: string;
  adSetId: string;
  creativeId: string;
  status: "ACTIVE" | "PAUSED";
}): Promise<Created> {
  return post(`${input.adAccountId}/ads`, {
    name: input.name,
    adset_id: input.adSetId,
    creative: JSON.stringify({ creative_id: input.creativeId }),
    status: input.status,
    access_token: input.accessToken,
  });
}

export async function setObjectStatus(
  objectId: string,
  accessToken: string,
  status: "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED",
): Promise<void> {
  await post(objectId, { status, access_token: accessToken });
}

// Kurulumdan sonra geri okuma: frenler gerçekten yazıldı mı?
export async function readBack<T extends Record<string, unknown>>(
  objectId: string,
  accessToken: string,
  fields: string,
): Promise<T> {
  const params = new URLSearchParams({ fields, access_token: accessToken });
  return metaFetch<T>(`${GRAPH_BASE}/${objectId}?${params.toString()}`);
}

export async function lifetimeImpressions(
  campaignId: string,
  accessToken: string,
): Promise<number> {
  const params = new URLSearchParams({
    fields: "impressions",
    date_preset: "maximum",
    access_token: accessToken,
  });
  const body = await metaFetch<{ data?: { impressions?: string }[] }>(
    `${GRAPH_BASE}/${campaignId}/insights?${params.toString()}`,
  );
  return Number(body.data?.[0]?.impressions ?? 0) || 0;
}

export const PREVIEW_FORMATS = [
  "MOBILE_FEED_STANDARD",
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "INSTAGRAM_REELS",
  "FACEBOOK_STORY_MOBILE",
  "FACEBOOK_REELS_MOBILE",
] as const;

// Önizleme (§3.4 adım 4): Meta'nın kendi çizimi. Yanıt bir iframe HTML'idir;
// yalnız Meta'nın önizleme adresi alınır.
export async function generatePreview(input: {
  adAccountId: string;
  accessToken: string;
  creative: Record<string, unknown>;
  format: string;
}): Promise<string | null> {
  const params = new URLSearchParams({
    creative: JSON.stringify(input.creative),
    ad_format: input.format,
    access_token: input.accessToken,
  });
  const body = await metaFetch<{ data?: { body?: string }[] }>(
    `${GRAPH_BASE}/${input.adAccountId}/generatepreviews?${params.toString()}`,
  );
  return previewSrcOf(body.data?.[0]?.body ?? "");
}

// <iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=…"> → src.
export function previewSrcOf(html: string): string | null {
  const match = /src="([^"]+)"/.exec(html);
  if (!match) return null;
  const src = match[1]!.replace(/&amp;/g, "&");
  try {
    const url = new URL(src);
    return url.protocol === "https:" &&
      (url.hostname === "www.facebook.com" || url.hostname === "facebook.com")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
