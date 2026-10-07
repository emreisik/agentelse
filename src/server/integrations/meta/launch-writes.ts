import "server-only";

import { adsetScheduleParam, type DayPart } from "@/lib/ads/day-parting";
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
  // Günlük ya da toplam (FIXED) bütçe: Meta ikisini birden almaz.
  dailyBudgetMinor?: number;
  lifetimeBudgetMinor?: number;
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
  // Mesai saatleri: yalnız toplam bütçeyle (Meta kuralı).
  schedule?: DayPart;
  status: "ACTIVE" | "PAUSED";
  validateOnly?: boolean;
}): Promise<Created> {
  return post(`${input.adAccountId}/adsets`, {
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget:
      input.dailyBudgetMinor !== undefined ? String(input.dailyBudgetMinor) : undefined,
    lifetime_budget:
      input.lifetimeBudgetMinor !== undefined ? String(input.lifetimeBudgetMinor) : undefined,
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
    pacing_type:
      input.schedule && input.lifetimeBudgetMinor !== undefined
        ? JSON.stringify(["day_parting"])
        : undefined,
    adset_schedule:
      input.schedule && input.lifetimeBudgetMinor !== undefined
        ? JSON.stringify(adsetScheduleParam(input.schedule))
        : undefined,
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
  messaging?: "WHATSAPP" | "MESSENGER" | "INSTAGRAM_DIRECT";
  // F5b: anında formun kimliği (CTA formu açar).
  leadFormId?: string;
  // Video reklam: işlenmiş Meta video kimliği ve kapak görselinin herkese
  // açık adresi (video_data hash kabul etmez).
  video?: { videoId: string; thumbnailUrl: string };
  // Carousel (F8+): 2-10 kart. Her kartın kendi görsel özeti ve bağlantısı
  // vardır; üst düzey `imageHash` ilk karttır.
  cards?: { imageHash: string; link: string; headline?: string; description?: string }[];
  // K14: Meta AI dönüşümleri açıkça; reddedilirse gönderilmeden denenir.
  features?: { send: boolean; multiAdvertiser: "OPT_IN" | "OPT_OUT" };
  validateOnly?: boolean;
};

// Mesaj reklamının CTA'sı ve bağlantısı (F5a; test hesabında doğrulanmalı):
// kişi uygulamadaki sohbete gider.
export const MESSAGING_CTA: Readonly<
  Record<"WHATSAPP" | "MESSENGER" | "INSTAGRAM_DIRECT", { type: string; link: string }>
> = {
  WHATSAPP: { type: "WHATSAPP_MESSAGE", link: "https://api.whatsapp.com/send" },
  MESSENGER: { type: "MESSAGE_PAGE", link: "https://fb.com/messenger_doc/" },
  INSTAGRAM_DIRECT: { type: "INSTAGRAM_MESSAGE", link: "https://www.instagram.com/" },
};

type StoryLinkData = {
  link: string;
  message: string;
  call_to_action: { type: string; value?: Record<string, unknown> };
  [key: string]: unknown;
};

export type ObjectStorySpec = {
  page_id: string;
  instagram_user_id?: string;
  link_data?: StoryLinkData;
  video_data?: {
    video_id: string;
    image_url: string;
    message: string;
    call_to_action: { type: string; value: { link: string } };
  };
};

export function objectStorySpec(input: Pick<
  CreativeInput,
  | "pageId"
  | "instagramUserId"
  | "imageHash"
  | "message"
  | "link"
  | "callToAction"
  | "headline"
  | "messaging"
  | "leadFormId"
  | "cards"
  | "video"
>): ObjectStorySpec {
  // Video: eski sihirbazda canlıda kanıtlanmış biçim (createMetaVideoAdCreative):
  // video_data'nın üst `link`i yoktur, adres CTA içindedir.
  if (input.video) {
    return {
      page_id: input.pageId,
      ...(input.instagramUserId ? { instagram_user_id: input.instagramUserId } : {}),
      video_data: {
        video_id: input.video.videoId,
        image_url: input.video.thumbnailUrl,
        message: input.message,
        call_to_action: { type: input.callToAction, value: { link: input.link } },
      },
    };
  }
  // Carousel: eski sihirbazda canlıda kanıtlanmış biçim (createMetaCarouselAdCreative):
  // link_data üst `link` (ilk kartın bağlantısı), `message` ve her kart için
  // child_attachments; CTA üst düzeyde.
  if (input.cards && input.cards.length >= 2) {
    return {
      page_id: input.pageId,
      ...(input.instagramUserId ? { instagram_user_id: input.instagramUserId } : {}),
      link_data: {
        link: input.cards[0]!.link,
        message: input.message,
        child_attachments: input.cards.map((card) => ({
          link: card.link,
          image_hash: card.imageHash,
          ...(card.headline ? { name: card.headline } : {}),
          ...(card.description ? { description: card.description } : {}),
        })),
        call_to_action: { type: input.callToAction },
      },
    };
  }
  const messaging = input.messaging ? MESSAGING_CTA[input.messaging] : null;
  const link = messaging?.link ?? input.link;
  if (input.leadFormId) {
    return {
      page_id: input.pageId,
      ...(input.instagramUserId ? { instagram_user_id: input.instagramUserId } : {}),
      link_data: {
        image_hash: input.imageHash,
        link,
        message: input.message,
        ...(input.headline ? { name: input.headline } : {}),
        call_to_action: {
          type: "SIGN_UP",
          value: { lead_gen_form_id: input.leadFormId },
        },
      },
    };
  }
  return {
    page_id: input.pageId,
    ...(input.instagramUserId ? { instagram_user_id: input.instagramUserId } : {}),
    link_data: {
      image_hash: input.imageHash,
      link,
      message: input.message,
      ...(input.headline ? { name: input.headline } : {}),
      call_to_action: messaging
        ? { type: messaging.type, value: { app_destination: input.messaging } }
        : { type: input.callToAction, value: { link } },
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

// Anında form (F5b, Leads): Sayfa token'ıyla `/{page_id}/leadgen_forms`.
// `pages_manage_ads` izni gerekir (App Review, plan §7). "Higher intent":
// gönderimden önce bir inceleme ekranı (alan adı doğrulanmalı).
export async function postLeadForm(input: {
  pageId: string;
  pageAccessToken: string;
  name: string;
  privacyUrl: string;
  higherIntent: boolean;
  followUpUrl?: string;
}): Promise<Created> {
  return post(`${input.pageId}/leadgen_forms`, {
    name: input.name,
    questions: JSON.stringify([{ type: "FULL_NAME" }, { type: "PHONE" }, { type: "EMAIL" }]),
    privacy_policy: JSON.stringify({ url: input.privacyUrl, link_text: "Privacy policy" }),
    follow_up_action_url: input.followUpUrl ?? input.privacyUrl,
    is_optimized_for_quality: input.higherIntent ? "true" : "false",
    access_token: input.pageAccessToken,
  });
}

// Kitle aralığı (`reachestimate`): `-1` Meta'nın tahmin vermediği anlamına
// gelir.
export async function reachEstimate(input: {
  adAccountId: string;
  accessToken: string;
  targetingSpec: Record<string, unknown>;
}): Promise<{ lower: number; upper: number } | null> {
  const params = new URLSearchParams({
    targeting_spec: JSON.stringify(input.targetingSpec),
    access_token: input.accessToken,
  });
  const body = await metaFetch<{
    data?: { users_lower_bound?: number; users_upper_bound?: number };
  }>(`${GRAPH_BASE}/${input.adAccountId}/reachestimate?${params.toString()}`);
  const lower = body.data?.users_lower_bound;
  const upper = body.data?.users_upper_bound;
  if (typeof lower !== "number" || typeof upper !== "number" || lower < 0 || upper < 0) {
    return null;
  }
  return { lower, upper };
}
