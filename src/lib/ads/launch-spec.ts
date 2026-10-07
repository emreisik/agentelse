import { z } from "zod";

import { formatMoney } from "./money";
import {
  isValidCombination,
  recipeByKey,
  type LaunchObjective,
} from "./objectives";
import { policyLint, type PolicyFlag } from "./policy-lint";
import { shortHash, stableStringify } from "./mirror";

// Güvenli lansmanın spec'i (docs/meta-ads-plan.md §3.4, F3). Onay bu spec'e
// verilir: bütçe, hedefleme, amaç ya da kimlik değişirse özeti (specHash)
// değişir ve onay geçersiz olur. Saf: kart, eylemler ve yürütücü kullanır.

export const LAUNCH_SPEC_VERSION = 1;

// Meta AI dönüşümleri (K14): içerik üreten ya da metni değiştirenler kapalı,
// yerleşime uyarlama açık. Kreatif kurulunca geri okunur.
export const CREATIVE_FEATURES_OPT_OUT = [
  "image_templates",
  "image_uncrop",
  "image_background_gen",
  "image_animation",
  "video_uncrop",
  "text_optimizations",
  "enhance_cta",
  "creative_stickers",
  "text_translation",
  "image_text_translation",
  "translate_voiceover",
] as const;
export const CREATIVE_FEATURES_OPT_IN = ["adapt_to_placement"] as const;

export const DEFAULT_URL_TAGS =
  "utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.id}}&utm_term={{placement}}";

// Bölgesel kimlik isteyen ülkeler (P5): v1'de desteklenmez.
export const REGIONAL_IDENTITY_COUNTRIES: readonly string[] = [
  "BR",
  "TW",
  "TH",
  "SG",
];

const TargetingSchema = z.object({
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .min(1)
    .max(25),
  cities: z
    .array(
      z.object({
        key: z.string(),
        name: z.string().optional(),
        radiusKm: z.number().optional(),
      }),
    )
    .optional(),
  ageMin: z.number().int().min(13).max(65).optional(),
  ageMax: z.number().int().min(13).max(65).optional(),
  genders: z.array(z.union([z.literal(1), z.literal(2)])).optional(),
  locales: z
    .array(z.object({ id: z.number(), label: z.string().optional() }))
    .optional(),
});

export const AdsLaunchSpecSchema = z.object({
  version: z.literal(LAUNCH_SPEC_VERSION),
  adAccountId: z.string().regex(/^act_\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1),
  pageId: z.string().min(1),
  instagramUserId: z.string().optional(),
  objective: z.enum([
    "OUTCOME_TRAFFIC",
    "OUTCOME_AWARENESS",
    "OUTCOME_ENGAGEMENT",
    "OUTCOME_LEADS",
    "OUTCOME_SALES",
  ]),
  recipe: z.string(),
  specialAdCategories: z.array(z.string()).max(4),
  campaignName: z.string().min(1).max(400),
  budget: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("DAILY"),
      dailyMinor: z.number().int().positive(),
      // Bitiş, kurulum anında hesap saatiyle hesaplanır: start + gün, 23:59.
      durationDays: z.number().int().min(1).max(31),
    }),
    // F5b: toplam tutar günlere esnek dağılır (lifetime_budget).
    z.object({
      mode: z.literal("FIXED"),
      lifetimeMinor: z.number().int().positive(),
      durationDays: z.number().int().min(1).max(31),
    }),
  ]),
  // F5b: mevcut ad set'e reklam ekleme (kampanya ve ad set kurulmaz).
  existingAdSetId: z.string().regex(/^\d+$/).optional(),
  // F5b: anında form (Leads); Sayfa token'ıyla kurulur.
  leadForm: z
    .object({
      privacyUrl: z.string().url(),
      higherIntent: z.boolean(),
      name: z.string().min(1).max(200),
    })
    .optional(),
  adSets: z
    .array(
      z.object({
        name: z.string().min(1).max(400),
        optimizationGoal: z.string(),
        billingEvent: z.string(),
        destinationType: z.string().optional(),
        promotedObject: z.record(z.string(), z.string()).optional(),
        targeting: TargetingSchema,
        advantageAudience: z.union([z.literal(0), z.literal(1)]),
        dsa: z
          .object({
            beneficiary: z.string().max(512),
            payor: z.string().max(512),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(5),
  ads: z
    .array(
      z.object({
        name: z.string().min(1).max(400),
        adSetIndex: z.number().int().min(0),
        creative: z.object({
          imageAssetId: z.string().min(1),
          message: z.string().min(1).max(2200),
          link: z.string().url(),
          callToAction: z.string(),
          headline: z.string().max(255).optional(),
          // F5a: mesaj reklamı (CTA sohbeti açar; bağlantı uygulamanın kendi
          // adresidir).
          messaging: z.enum(["WHATSAPP", "MESSENGER", "INSTAGRAM_DIRECT"]).optional(),
          // F8+: carousel. 2-10 kart; ilk kartın görseli `imageAssetId` ile
          // aynıdır (önizleme ve eski yollar için). Mesaj ve anında formla
          // birlikte olmaz.
          cards: z
            .array(
              z.object({
                imageAssetId: z.string().min(1),
                headline: z.string().max(255).optional(),
                description: z.string().max(255).optional(),
                link: z.string().url(),
              }),
            )
            .min(2)
            .max(10)
            .optional(),
        }),
        urlTags: z.string().max(1000),
      }),
    )
    .min(1)
    .max(6),
  guards: z.object({
    // max(hesabın asgari kampanya tavanı, zarf × 1,1); null: asgari bilinmiyor.
    campaignSpendCapMinor: z.number().int().positive().nullable(),
  }),
  creativeFeatures: z.object({
    send: z.boolean(),
    multiAdvertiser: z.enum(["OPT_IN", "OPT_OUT"]),
  }),
  // false = "Create paused only".
  activate: z.boolean(),
  kpi: z
    .object({
      metric: z.enum([
        "CPL",
        "CPA",
        "COST_PER_CONVERSATION",
        "COST_PER_CLICK",
        "ROAS",
      ]),
      target: z.number().positive(),
    })
    .optional(),
}).refine(
  // Carousel kartları mesaj CTA'sı ve anında formla birlikte kurulamaz.
  (spec) =>
    spec.ads.every(
      (ad) => !ad.creative.cards || (!ad.creative.messaging && !spec.leadForm),
    ),
  { path: ["ads"], message: "A carousel can't be a message or lead form ad" },
);
export type AdsLaunchSpec = z.infer<typeof AdsLaunchSpecSchema>;

export function parseLaunchSpec(value: unknown): AdsLaunchSpec | null {
  const parsed = AdsLaunchSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Onayın bağlı olduğu alanlar (metin düzeltmeleri hariç).
export function specHash(spec: AdsLaunchSpec): string {
  return shortHash(
    stableStringify({
      adAccountId: spec.adAccountId,
      currency: spec.currency,
      pageId: spec.pageId,
      instagramUserId: spec.instagramUserId ?? null,
      objective: spec.objective,
      recipe: spec.recipe,
      specialAdCategories: spec.specialAdCategories,
      budget: spec.budget,
      adSets: spec.adSets.map((adSet) => ({
        optimizationGoal: adSet.optimizationGoal,
        destinationType: adSet.destinationType ?? null,
        promotedObject: adSet.promotedObject ?? null,
        targeting: adSet.targeting,
        advantageAudience: adSet.advantageAudience,
      })),
      ads: spec.ads.map((ad) => ({
        adSetIndex: ad.adSetIndex,
        image: ad.creative.imageAssetId,
        link: ad.creative.link,
        // Yalnız carousel'de eklenir: eski spec'lerin özeti değişmez.
        ...(ad.creative.cards
          ? {
              cards: ad.creative.cards.map((card) => ({
                image: card.imageAssetId,
                link: card.link,
                headline: card.headline ?? null,
              })),
            }
          : {}),
      })),
      activate: spec.activate,
    }),
  );
}

export function envelopeMinor(spec: Pick<AdsLaunchSpec, "budget">): number {
  return spec.budget.mode === "FIXED"
    ? spec.budget.lifetimeMinor
    : spec.budget.dailyMinor * spec.budget.durationDays;
}

// Günlük ortalama (fizibilite, tahmin ve asgari bütçe için).
export function averageDailyMinor(spec: Pick<AdsLaunchSpec, "budget">): number {
  return spec.budget.mode === "FIXED"
    ? Math.floor(spec.budget.lifetimeMinor / spec.budget.durationDays)
    : spec.budget.dailyMinor;
}

// Kampanya spend_cap'i (§3.4): max(asgari, zarf × 1,1). Meta'nın kendi
// temposu (1,75 × gün) bunun altında kalır; tavan felaket frenidir.
export function campaignSpendCap(
  envelope: number,
  minCampaignSpendCapMinor: number | null,
): number {
  // Tam sayı aritmetiği: 14000 × 1,1 kayan noktada 15400,000…2 olur.
  const own = Math.ceil((envelope * 11) / 10);
  return Math.max(own, minCampaignSpendCapMinor ?? 0);
}

// Ad set bitişi: başlangıç gününden `days` gün sonra, hesap saatiyle 23:59.
// IANA adıyla hesaplanır (yaz saati uygulayan hesaplarda kayma olmasın).
export function adSetEndTime(
  start: Date,
  days: number,
  timeZone: string,
  zonedToUtc: (local: string, timeZone: string) => Date,
  dayKey: (date: Date, timeZone: string) => string,
): Date {
  const startDay = dayKey(start, timeZone);
  const [y, m, d] = startDay.split("-").map(Number);
  const end = new Date(Date.UTC(y!, m! - 1, d! + days));
  const local = `${end.toISOString().slice(0, 10)}T23:59`;
  return zonedToUtc(local, timeZone);
}

// ---- Yerel doğrulama (P kuralları) -------------------------------------------------

export type LaunchIssue = {
  rule: "P1" | "P2" | "P3" | "P5" | "P6" | "P8" | "P9" | "P12" | "META";
  field: string;
  severity: "block" | "warn";
  message: string;
};

export type LaunchAccountFacts = {
  accountStatus: number | null;
  currency: string | null;
  minDailyBudgetMinor: number | null;
  // `minimum_budgets` yanıtı (ham).
  minimumBudgets: unknown;
  dsaBeneficiary?: string | null;
  dsaPayor?: string | null;
};

const EU_EEA = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
]);

// minimum_budgets: [{ currency, min_daily_budget_imp, min_daily_budget_high_freq,
// min_daily_budget_low_freq, ... }] (alan adları fikstürle doğrulanmalı).
export function minimumDailyBudget(
  facts: Pick<
    LaunchAccountFacts,
    "minDailyBudgetMinor" | "minimumBudgets" | "currency"
  >,
  optimizationGoal: string,
): number | null {
  const rows = Array.isArray(facts.minimumBudgets) ? facts.minimumBudgets : [];
  const row = rows.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (!facts.currency ||
        (entry as { currency?: string }).currency === facts.currency),
  ) as Record<string, unknown> | undefined;
  const lowFrequency =
    optimizationGoal === "OFFSITE_CONVERSIONS" ||
    optimizationGoal === "LEAD_GENERATION" ||
    optimizationGoal === "CONVERSATIONS";
  const fromTable = row
    ? Number(
        lowFrequency
          ? row.min_daily_budget_low_freq
          : (row.min_daily_budget_high_freq ?? row.min_daily_budget_imp),
      )
    : NaN;
  if (Number.isFinite(fromTable) && fromTable > 0) return Math.round(fromTable);
  return facts.minDailyBudgetMinor;
}

export function validateLaunchSpec(
  spec: AdsLaunchSpec,
  facts: LaunchAccountFacts,
): LaunchIssue[] {
  const issues: LaunchIssue[] = [];
  const recipe = recipeByKey(spec.recipe);
  if (facts.accountStatus !== null && facts.accountStatus !== 1) {
    issues.push({
      rule: "P12",
      field: "account",
      severity: "block",
      message:
        "This ad account can't run ads right now. Check it in Meta first.",
    });
  }
  if (facts.currency && facts.currency !== spec.currency) {
    issues.push({
      rule: "P12",
      field: "budget",
      severity: "block",
      message: `The ad account now uses ${facts.currency}, not ${spec.currency}. Check the budget again.`,
    });
  }
  if (!recipe || recipe.objective !== spec.objective) {
    issues.push({
      rule: "P2",
      field: "objective",
      severity: "block",
      message: "This goal and objective don't go together in Meta.",
    });
  }
  spec.adSets.forEach((adSet, index) => {
    if (
      !isValidCombination({
        objective: spec.objective,
        optimizationGoal: adSet.optimizationGoal,
        billingEvent: adSet.billingEvent,
        destinationType: adSet.destinationType,
      })
    ) {
      issues.push({
        rule: "P2",
        field: `adSets.${index}.optimizationGoal`,
        severity: "block",
        message: "This goal and objective don't go together in Meta.",
      });
    }
    const minimum = minimumDailyBudget(facts, adSet.optimizationGoal);
    if (!spec.existingAdSetId && minimum && averageDailyMinor(spec) < minimum) {
      issues.push({
        rule: "P1",
        field: "budget.dailyMinor",
        severity: "block",
        message: `Daily budget is below Meta's minimum of ${formatMoney(minimum, spec.currency)}.`,
      });
    }
    const targeting = adSet.targeting;
    if (
      adSet.advantageAudience === 1 &&
      ((targeting.ageMin ?? 18) > 25 || (targeting.ageMax ?? 65) < 65)
    ) {
      issues.push({
        rule: "P3",
        field: `adSets.${index}.targeting`,
        severity: "block",
        message:
          "With Advantage+ audience on, the youngest age must be 25 or lower and the oldest 65+.",
      });
    }
    if ((targeting.ageMin ?? 18) > (targeting.ageMax ?? 65)) {
      issues.push({
        rule: "P3",
        field: `adSets.${index}.targeting`,
        severity: "block",
        message: "The youngest age is above the oldest.",
      });
    }
    const regional = targeting.countries.filter((code) =>
      REGIONAL_IDENTITY_COUNTRIES.includes(code),
    );
    if (regional.length > 0) {
      issues.push({
        rule: "P5",
        field: `adSets.${index}.targeting.countries`,
        severity: "block",
        message: `Ads in ${regional.join(", ")} need a verified regional identity in Meta. Agentelse doesn't support these countries yet.`,
      });
    }
    const eu = targeting.countries.some((code) => EU_EEA.has(code));
    const beneficiary = adSet.dsa?.beneficiary ?? facts.dsaBeneficiary;
    const payor = adSet.dsa?.payor ?? facts.dsaPayor;
    if (eu && (!beneficiary?.trim() || !payor?.trim())) {
      issues.push({
        rule: "P5",
        field: `adSets.${index}.dsa`,
        severity: "block",
        message:
          "Ads shown in the EU must say who benefits from the ad and who pays for it.",
      });
    }
    if (recipe && recipe.promoted !== "none" && !adSet.promotedObject) {
      issues.push({
        rule: "P2",
        field: `adSets.${index}.promotedObject`,
        severity: "block",
        message:
          recipe.promoted === "pixel"
            ? "Pick the Meta Pixel that records purchases."
            : recipe.promoted === "page_whatsapp"
              ? "Connect a WhatsApp number to your Page first."
              : "Pick the Page the conversations go to.",
      });
    }
  });
  if (!(spec.budget.durationDays >= 1)) {
    issues.push({
      rule: "P8",
      field: "budget.durationDays",
      severity: "block",
      message: "Every launch needs an end date.",
    });
  }
  spec.ads.forEach((ad, index) => {
    if (ad.adSetIndex >= spec.adSets.length) {
      issues.push({
        rule: "P2",
        field: `ads.${index}`,
        severity: "block",
        message: "An ad has no ad set.",
      });
    }
    // Carousel kart başlıkları da reklam metnidir.
    const cardText = (ad.creative.cards ?? [])
      .map((card) => card.headline ?? "")
      .join(" ");
    for (const flag of policyLint(
      `${ad.creative.headline ?? ""} ${ad.creative.message} ${cardText}`,
    )) {
      issues.push({
        rule: "P6",
        field: `ads.${index}.creative.message`,
        severity: "warn",
        message: flag.message,
      });
    }
    if (ad.creative.cards) {
      const assets = new Set(ad.creative.cards.map((card) => card.imageAssetId));
      if (assets.size < 2) {
        issues.push({
          rule: "P2",
          field: `ads.${index}.creative.cards`,
          severity: "block",
          message: "A carousel needs at least two different pictures.",
        });
      }
      if (ad.creative.messaging || spec.leadForm) {
        issues.push({
          rule: "P2",
          field: `ads.${index}.creative.cards`,
          severity: "block",
          message: "A carousel can't be used for messages or forms.",
        });
      }
    }
  });
  return issues;
}

export function blockingIssues(issues: readonly LaunchIssue[]): LaunchIssue[] {
  return issues.filter((issue) => issue.severity === "block");
}

export type { PolicyFlag, LaunchObjective };
