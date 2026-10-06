import {
  campaignSpendCap,
  DEFAULT_URL_TAGS,
  LAUNCH_SPEC_VERSION,
  type AdsLaunchSpec,
} from "@/lib/ads/launch-spec";
import { toMinorUnits } from "@/lib/ads/money";
import { defaultRecipeFor } from "@/lib/ads/objectives";

import {
  targetsEuEea,
  type AdsBrief,
  type AdsPlanInput,
} from "./state";

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

export function launchSpecFromFlow(input: {
  brief: AdsBrief;
  plan: AdsPlanInput;
  context: LaunchBuildContext;
  activate: boolean;
}): AdsLaunchSpec {
  const { brief, plan, context } = input;
  const recipe = defaultRecipeFor(brief.objective);
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
    budget: { mode: "DAILY", dailyMinor, durationDays: brief.days },
    adSets: [
      {
        name: plan.adSetName,
        optimizationGoal: recipe.optimizationGoal,
        billingEvent: recipe.billingEvent,
        ...(recipe.destinationType ? { destinationType: recipe.destinationType } : {}),
        targeting: {
          countries: brief.countries,
          ageMin: brief.ageMin,
          ageMax: brief.ageMax,
          ...(genders ? { genders } : {}),
        },
        // Brief'teki yaş ve cinsiyet sert sınırdır.
        advantageAudience: 0,
        ...(dsa ? { dsa } : {}),
      },
    ],
    ads: [
      {
        name: plan.adName,
        adSetIndex: 0,
        creative: {
          imageAssetId: brief.source.assetId,
          message: plan.primaryText,
          link: brief.link,
          callToAction: brief.callToAction,
        },
        urlTags: DEFAULT_URL_TAGS,
      },
    ],
    guards: {
      campaignSpendCapMinor: campaignSpendCap(
        dailyMinor * brief.days,
        context.minCampaignSpendCapMinor,
      ),
    },
    creativeFeatures: { send: true, multiAdvertiser: "OPT_OUT" },
    activate: input.activate,
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
};

export const PREVIEW_LABEL: Readonly<Record<string, string>> = {
  MOBILE_FEED_STANDARD: "Facebook feed",
  INSTAGRAM_STANDARD: "Instagram feed",
  INSTAGRAM_STORY: "Instagram story",
  INSTAGRAM_REELS: "Instagram reels",
  FACEBOOK_STORY_MOBILE: "Facebook story",
  FACEBOOK_REELS_MOBILE: "Facebook reels",
};
