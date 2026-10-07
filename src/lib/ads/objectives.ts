// Amaç tablosu (docs/meta-ads-plan.md §6 P2, ODAX). Bir kampanya amacının
// hangi optimizasyon hedefi, faturalama türü, varış yeri ve tanıtılan nesneyle
// kurulabileceğini tek yerde tutar; yerel doğrulama ve lansman spec'i buradan
// okur. Meta'nın kabul etmediği bir kombinasyon onaya hiç ulaşmaz.

export type LaunchObjective =
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_LEADS"
  | "OUTCOME_SALES";

// Tanıtılan nesnede ne gerekir.
export type PromotedNeed = "none" | "page" | "page_whatsapp" | "pixel";

export type AdsRecipe = {
  key: string;
  objective: LaunchObjective;
  optimizationGoal: string;
  billingEvent: string;
  destinationType?: string;
  promoted: PromotedNeed;
  // Sonuç olarak sayılan olay (src/lib/ads/results.ts ile aynı adlar).
  resultActionType: string;
  label: string;
  // Hangi fazdan beri sunuluyor (F5a mesaj ve açılış sayfası, F5b form ve
  // satış).
  since: "F3" | "F5a" | "F5b" | "F8";
};

export const ADS_RECIPES: readonly AdsRecipe[] = [
  {
    key: "traffic_link_clicks",
    objective: "OUTCOME_TRAFFIC",
    optimizationGoal: "LINK_CLICKS",
    billingEvent: "IMPRESSIONS",
    promoted: "none",
    resultActionType: "link_click",
    label: "Link clicks",
    since: "F3",
  },
  {
    key: "traffic_landing_page_views",
    objective: "OUTCOME_TRAFFIC",
    optimizationGoal: "LANDING_PAGE_VIEWS",
    billingEvent: "IMPRESSIONS",
    destinationType: "WEBSITE",
    promoted: "none",
    resultActionType: "landing_page_view",
    label: "Landing page views",
    since: "F5a",
  },
  {
    // Instagram profil ziyareti (Meta: destination_type INSTAGRAM_PROFILE +
    // optimization_goal PROFILE_VISIT). Kapalı gelir; test hesabında
    // doğrulanınca META_ADS_READY_RECIPES=traffic_instagram_profile ile açılır.
    key: "traffic_instagram_profile",
    objective: "OUTCOME_TRAFFIC",
    optimizationGoal: "PROFILE_VISIT",
    billingEvent: "IMPRESSIONS",
    destinationType: "INSTAGRAM_PROFILE",
    promoted: "none",
    resultActionType: "instagram_profile_visit",
    label: "Instagram profile visits",
    since: "F8",
  },
  {
    key: "awareness_reach",
    objective: "OUTCOME_AWARENESS",
    optimizationGoal: "REACH",
    billingEvent: "IMPRESSIONS",
    promoted: "none",
    resultActionType: "reach",
    label: "Reach",
    since: "F3",
  },
  {
    key: "engagement_post",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "POST_ENGAGEMENT",
    billingEvent: "IMPRESSIONS",
    destinationType: "ON_POST",
    promoted: "none",
    resultActionType: "post_engagement",
    label: "Post engagement",
    since: "F3",
  },
  {
    key: "messages_messenger",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "CONVERSATIONS",
    billingEvent: "IMPRESSIONS",
    destinationType: "MESSENGER",
    promoted: "page",
    resultActionType: "onsite_conversion.messaging_conversation_started_7d",
    label: "Messenger conversations",
    since: "F5a",
  },
  {
    key: "messages_instagram",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "CONVERSATIONS",
    billingEvent: "IMPRESSIONS",
    destinationType: "INSTAGRAM_DIRECT",
    promoted: "page",
    resultActionType: "onsite_conversion.messaging_conversation_started_7d",
    label: "Instagram conversations",
    since: "F5a",
  },
  {
    key: "messages_whatsapp",
    objective: "OUTCOME_ENGAGEMENT",
    optimizationGoal: "CONVERSATIONS",
    billingEvent: "IMPRESSIONS",
    destinationType: "WHATSAPP",
    promoted: "page_whatsapp",
    resultActionType: "onsite_conversion.messaging_conversation_started_7d",
    label: "WhatsApp conversations",
    since: "F5a",
  },
  {
    key: "leads_instant_form",
    objective: "OUTCOME_LEADS",
    optimizationGoal: "LEAD_GENERATION",
    billingEvent: "IMPRESSIONS",
    destinationType: "ON_AD",
    promoted: "page",
    resultActionType: "lead",
    label: "Leads (instant form)",
    since: "F5b",
  },
  {
    key: "sales_purchase",
    objective: "OUTCOME_SALES",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    destinationType: "WEBSITE",
    promoted: "pixel",
    resultActionType: "offsite_conversion.fb_pixel_purchase",
    label: "Purchases",
    since: "F5b",
  },
];

export function recipeByKey(key: string | null | undefined): AdsRecipe | null {
  return ADS_RECIPES.find((recipe) => recipe.key === key) ?? null;
}

// Eski akışın üç amacı → tarif.
export function defaultRecipeFor(objective: LaunchObjective): AdsRecipe {
  const key =
    objective === "OUTCOME_AWARENESS"
      ? "awareness_reach"
      : objective === "OUTCOME_ENGAGEMENT"
        ? "engagement_post"
        : objective === "OUTCOME_LEADS"
          ? "leads_instant_form"
          : objective === "OUTCOME_SALES"
            ? "sales_purchase"
            : "traffic_link_clicks";
  return recipeByKey(key)!;
}

// P2: kombinasyon tabloda var mı?
export function isValidCombination(input: {
  objective: string;
  optimizationGoal: string;
  billingEvent: string;
  destinationType?: string | null;
}): boolean {
  return ADS_RECIPES.some(
    (recipe) =>
      recipe.objective === input.objective &&
      recipe.optimizationGoal === input.optimizationGoal &&
      recipe.billingEvent === input.billingEvent &&
      (recipe.destinationType ?? null) === (input.destinationType ?? null),
  );
}

// Kod düzeyindeki hazır listesi (F5a/F5b bayrağı açıkken bile her amaç ayrı
// açılır): anında form `pages_manage_ads` (App Review) gelene, satış amacı
// piksel olayları test hesabında doğrulanana kadar kapalı.
export const READY_RECIPES: Readonly<Record<string, boolean>> = {
  traffic_link_clicks: true,
  traffic_landing_page_views: true,
  awareness_reach: true,
  engagement_post: true,
  messages_messenger: true,
  messages_instagram: true,
  messages_whatsapp: true,
  leads_instant_form: false,
  sales_purchase: false,
  traffic_instagram_profile: false,
};

// Kapalı bir amaç, kod değişikliği ve push beklemeden Railway'de açılabilir:
// META_ADS_READY_RECIPES="leads_instant_form,sales_purchase" (virgülle ayrılmış
// anahtarlar; büyük / küçük harf ve boşluk fark etmez). Yalnız bilinen anahtarlar
// sayılır. Anında form için önkoşul: Meta'dan `pages_manage_ads` onayı.
function extraReadyRecipes(): Set<string> {
  return new Set(
    (process.env.META_ADS_READY_RECIPES ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part in READY_RECIPES),
  );
}

export function recipeReady(key: string): boolean {
  return READY_RECIPES[key] === true || extraReadyRecipes().has(key);
}

// Önerilen hedef (docs/meta-ads-plan.md §3.3 amaç karar ağacı, sade sürüm):
// site ve piksel varsa trafik (açılış sayfası); yoksa yerel işletme için mesaj.
export function recommendedGoal(input: {
  hasPixel: boolean;
  messagesOffered: boolean;
}): { goal: "TRAFFIC" | "MESSAGES"; reason: string } {
  if (input.hasPixel) {
    return {
      goal: "TRAFFIC",
      reason: "Your site has the Meta Pixel, so Meta can find people who actually read your page.",
    };
  }
  if (input.messagesOffered) {
    return {
      goal: "MESSAGES",
      reason: "Without the Pixel on your site, chats are the result Meta can count best.",
    };
  }
  return { goal: "TRAFFIC", reason: "Sends people to your website." };
}
