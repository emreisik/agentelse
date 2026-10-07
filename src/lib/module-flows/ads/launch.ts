import {
  campaignSpendCap,
  DEFAULT_URL_TAGS,
  LAUNCH_SPEC_VERSION,
  type AdsLaunchSpec,
} from "@/lib/ads/launch-spec";
import { kpiMetricFor, targetCost } from "@/lib/ads/kpi";
import { toMinorUnits } from "@/lib/ads/money";
import { adTextFrom, clipWords } from "./state";
import {
  defaultRecipeFor,
  recipeByKey,
  type AdsRecipe,
} from "@/lib/ads/objectives";

import {
  ADS_LIMITS,
  targetsEuEea,
  type AdsBrief,
  type AdsPlanInput,
} from "./state";

// Carousel kartının başlığı: Meta kart başlığını yaklaşık 32 karakterde keser.
const CARD_HEADLINE_MAX = 40;

// Kart akışından (Brief + Plan) güvenli lansman spec'i (docs/meta-ads-plan.md
// F3). Saf: Review'ın ön kontrolü ve "Approve & launch" aynı spec'i kurar.

export type LaunchBuildContext = {
  adAccountId: string;
  currency: string;
  timezone: string;
  pageId: string;
  instagramUserId?: string;
  minCampaignSpendCapMinor: number | null;
  dsaBeneficiary: string | null;
  dsaPayor: string | null;
};

// Brief'in hedefi → tarif (F5a: mesaj ve açılış sayfası görüntüleme).
export function recipeForBrief(
  brief: Pick<AdsBrief, "objective" | "messages" | "trafficEvent">,
): AdsRecipe {
  if (brief.messages) {
    const key =
      brief.messages.app === "WHATSAPP"
        ? "messages_whatsapp"
        : brief.messages.app === "INSTAGRAM_DIRECT"
          ? "messages_instagram"
          : "messages_messenger";
    return recipeByKey(key)!;
  }
  if (brief.objective === "OUTCOME_TRAFFIC" && brief.trafficEvent === "LANDING_PAGE_VIEWS") {
    return recipeByKey("traffic_landing_page_views")!;
  }
  return defaultRecipeFor(brief.objective);
}

// WhatsApp numarası Meta'ya yalnız rakam olarak gider (ülke koduyla).
export function whatsappDigits(number: string | undefined): string | undefined {
  const digits = number?.replace(/[^0-9]/g, "");
  return digits && digits.length >= 6 ? digits : undefined;
}

export function launchSpecFromFlow(input: {
  brief: AdsBrief;
  plan: AdsPlanInput;
  context: LaunchBuildContext;
  activate: boolean;
}): AdsLaunchSpec {
  const { brief, plan, context } = input;
  const recipe = recipeForBrief(brief);
  // F5b: "Suggest" (varsayılan, Advantage+ audience açık) ya da "Limit to".
  const advantageAudience: 0 | 1 = brief.audienceMode === "suggest" ? 1 : 0;
  const target = targetCost(brief.kpi);
  const metric = kpiMetricFor(recipe.resultActionType);
  const messaging = brief.messages?.app;
  // Carousel: bütün postlar tek reklamın kartları (mesaj ve formla olmaz).
  const carousel =
    brief.adFormat === "carousel" &&
    !brief.messages &&
    brief.objective !== "OUTCOME_LEADS" &&
    (brief.extraSources?.length ?? 0) >= 1;
  const promotedObject: Record<string, string> | undefined =
    recipe.promoted === "page" || recipe.promoted === "page_whatsapp"
      ? {
          page_id: context.pageId,
          ...(messaging === "WHATSAPP" && whatsappDigits(brief.messages?.whatsappNumber)
            ? { whatsapp_phone_number: whatsappDigits(brief.messages?.whatsappNumber)! }
            : {}),
        }
      : undefined;
  const dailyMinor = toMinorUnits(brief.dailyBudget, context.currency);
  const genders: (1 | 2)[] | undefined =
    brief.gender === "men" ? [1] : brief.gender === "women" ? [2] : undefined;
  const beneficiary = brief.dsaBeneficiary ?? context.dsaBeneficiary ?? undefined;
  const payor = brief.dsaPayor ?? context.dsaPayor ?? undefined;
  const dsa =
    targetsEuEea(brief.countries) && beneficiary && payor
      ? { beneficiary, payor }
      : undefined;
  return {
    version: LAUNCH_SPEC_VERSION,
    adAccountId: context.adAccountId,
    currency: context.currency,
    timezone: context.timezone,
    pageId: context.pageId,
    ...(context.instagramUserId ? { instagramUserId: context.instagramUserId } : {}),
    objective: brief.objective,
    recipe: recipe.key,
    specialAdCategories: [],
    campaignName: plan.campaignName,
    budget:
      brief.budgetMode === "fixed"
        ? { mode: "FIXED", lifetimeMinor: dailyMinor * brief.days, durationDays: brief.days }
        : { mode: "DAILY", dailyMinor, durationDays: brief.days },
    ...(brief.existingAdSetId ? { existingAdSetId: brief.existingAdSetId } : {}),
    ...(brief.objective === "OUTCOME_LEADS" && brief.leadForm
      ? {
          leadForm: {
            privacyUrl: brief.leadForm.privacyUrl,
            higherIntent: brief.leadForm.higherIntent,
            name: clipWords(`${plan.campaignName} form`, 200),
          },
        }
      : {}),
    adSets: [
      {
        name: plan.adSetName,
        optimizationGoal: recipe.optimizationGoal,
        billingEvent: recipe.billingEvent,
        ...(recipe.destinationType ? { destinationType: recipe.destinationType } : {}),
        ...(promotedObject ? { promotedObject } : {}),
        targeting: {
          countries: brief.countries,
          ageMin: brief.ageMin,
          ageMax: brief.ageMax,
          ...(genders ? { genders } : {}),
          // Advantage+ audience açıkken en küçük yaş ≤ 25 ve en büyük 65 (P3):
          // Brief'in yaşları burada öneridir, sert sınır değil.
          ...(advantageAudience === 1
            ? { ageMin: Math.min(brief.ageMin, 25), ageMax: 65 }
            : {}),
        },
        advantageAudience,
        ...(dsa ? { dsa } : {}),
      },
    ],
    ads: carousel
      ? [
          {
            name: plan.adName,
            adSetIndex: 0,
            creative: {
              imageAssetId: brief.source.assetId,
              message: plan.primaryText,
              link: brief.link,
              callToAction: brief.callToAction,
              // Her kart bir post: görseli ve (kısaltılmış) başlığıyla.
              cards: [brief.source, ...(brief.extraSources ?? [])].map((card) => ({
                imageAssetId: card.assetId,
                ...(card.title
                  ? { headline: clipWords(card.title, CARD_HEADLINE_MAX, true) }
                  : {}),
                link: brief.link,
              })),
            },
            urlTags: DEFAULT_URL_TAGS,
          },
        ]
      : [
      {
        name: plan.adName,
        adSetIndex: 0,
        creative: {
          imageAssetId: brief.source.assetId,
          message: plan.primaryText,
          // Mesaj reklamında bağlantıyı uygulamanın adresi belirler.
          link: brief.link || brief.leadForm?.privacyUrl || "https://www.facebook.com/",
          callToAction: brief.callToAction,
          ...(messaging ? { messaging } : {}),
        },
        urlTags: DEFAULT_URL_TAGS,
      },
      // F5b: ek postlar aynı ad set'te ayrı reklamlar (kreatif çeşitliliği);
      // metinleri kendi açıklamalarından.
      ...(brief.extraSources ?? []).slice(0, ADS_LIMITS.maxExtraSeparate).map((source, index) => ({
        name: clipWords(`${source.title || plan.adName} ${index + 2}`, 400),
        adSetIndex: 0,
        creative: {
          imageAssetId: source.assetId,
          message:
            clipWords(adTextFrom(source.caption ?? ""), 125, true) || plan.primaryText,
          link: brief.link || brief.leadForm?.privacyUrl || "https://www.facebook.com/",
          callToAction: brief.callToAction,
          ...(messaging ? { messaging } : {}),
        },
        urlTags: DEFAULT_URL_TAGS,
      })),
    ],
    guards: {
      campaignSpendCapMinor: campaignSpendCap(
        dailyMinor * brief.days,
        context.minCampaignSpendCapMinor,
      ),
    },
    creativeFeatures: { send: true, multiAdvertiser: "OPT_OUT" },
    activate: input.activate,
    ...(target ? { kpi: { metric: metric.metric, target } } : {}),
  };
}

// Review'daki ön kontrolün kart görünümü (sunucu doldurur).
export type AdsLaunchCheck = {
  launchId: string;
  // Engelleyici sorun yok: "Approve & launch" açık.
  ready: boolean;
  issues: { severity: "block" | "warn"; message: string; field: string }[];
  // Meta'nın önizleme adresleri (www.facebook.com).
  previews: { format: string; src: string }[];
  envelope: string;
  spendCap: string | null;
  endsOn: string;
  timezone: string;
  featuresFallback: boolean;
  notes: string[];
  // F5b: "About 120,000–150,000 people", "Expected: 25–40 conversations a
  // week (directional)", brüt fatura (konum ücretiyle, KDV hariç).
  reach: string | null;
  expected: string | null;
  gross: string | null;
  // F5b: mevcut ad set'e ekleme (yeni bütçe onaylanmaz).
  adding: boolean;
};

const COUNT = new Intl.NumberFormat("en-US");

export function reachText(reach: { lower: number; upper: number } | null): string | null {
  return reach ? `About ${COUNT.format(reach.lower)}–${COUNT.format(reach.upper)} people` : null;
}

export function expectedText(range: [number, number] | null, label: string): string | null {
  if (!range) return null;
  return `Expected: ${COUNT.format(range[0])}–${COUNT.format(range[1])} ${label.toLowerCase()} a week (directional)`;
}

export const PREVIEW_LABEL: Readonly<Record<string, string>> = {
  MOBILE_FEED_STANDARD: "Facebook feed",
  INSTAGRAM_STANDARD: "Instagram feed",
  INSTAGRAM_STORY: "Instagram story",
  INSTAGRAM_REELS: "Instagram reels",
  FACEBOOK_STORY_MOBILE: "Facebook story",
  FACEBOOK_REELS_MOBILE: "Facebook reels",
};
