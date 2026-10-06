import { z } from "zod";

import type { ChannelKey } from "@/lib/content-channels";
import { SUPPORTED_COUNTRIES, countryLabel } from "@/lib/locales";
import type { ModuleFlowStep } from "@/lib/module-flows/card";
import { minorUnitOffset, toMinorUnits } from "@/lib/ads/money";

// The Ads Manager flow's own state (docs/modules.md "Ads Manager"): what the
// one module-flow card keeps in `data` from Brief to Launch, so a reopened chat
// shows the same step. Stored JSON is never trusted: every part is parsed on
// its own and a broken part reads as not there yet. Pure and isomorphic.

// ---- Choices ---------------------------------------------------------------------

// Meta's outcome objectives the flow offers, each with the optimization goal
// its ad set runs on. Billing is IMPRESSIONS for all three: the one billing
// event Meta accepts with LINK_CLICKS, REACH and POST_ENGAGEMENT alike.
export const ADS_OBJECTIVES = [
  "OUTCOME_TRAFFIC",
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
] as const;
export type AdsObjective = (typeof ADS_OBJECTIVES)[number];

export const ADS_BILLING_EVENT = "IMPRESSIONS";

export const ADS_OBJECTIVE_META: Readonly<
  Record<
    AdsObjective,
    { label: string; hint: string; optimizationGoal: string; goalLabel: string }
  >
> = {
  OUTCOME_TRAFFIC: {
    label: "Traffic",
    hint: "More visits to your website.",
    optimizationGoal: "LINK_CLICKS",
    goalLabel: "link clicks",
  },
  OUTCOME_AWARENESS: {
    label: "Awareness",
    hint: "Seen by as many people as possible.",
    optimizationGoal: "REACH",
    goalLabel: "reach",
  },
  OUTCOME_ENGAGEMENT: {
    label: "Engagement",
    hint: "More likes, comments and shares.",
    optimizationGoal: "POST_ENGAGEMENT",
    goalLabel: "post engagement",
  },
};

export const ADS_DURATIONS = [3, 7, 14, 30] as const;
export type AdsDuration = (typeof ADS_DURATIONS)[number];
export const DEFAULT_ADS_DURATION: AdsDuration = 7;

// The buttons the existing ad wizard already sends to Meta.
export const ADS_CTAS = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "CONTACT_US",
  "GET_OFFER",
] as const;
export type AdsCallToAction = (typeof ADS_CTAS)[number];

export const ADS_CTA_LABEL: Readonly<Record<AdsCallToAction, string>> = {
  LEARN_MORE: "Learn more",
  SHOP_NOW: "Shop now",
  SIGN_UP: "Sign up",
  CONTACT_US: "Contact us",
  GET_OFFER: "Get offer",
};

// F5a: mesaj hedefi (CONVERSATIONS). Instagram Direct yalnız reklam hesabının
// kullanabildiği bir Instagram hesabı varken sunulur.
export const ADS_MESSAGE_APPS = ["WHATSAPP", "MESSENGER", "INSTAGRAM_DIRECT"] as const;
export type AdsMessageApp = (typeof ADS_MESSAGE_APPS)[number];

export const ADS_MESSAGE_APP_LABEL: Readonly<Record<AdsMessageApp, string>> = {
  WHATSAPP: "WhatsApp",
  MESSENGER: "Messenger",
  INSTAGRAM_DIRECT: "Instagram",
};

// Mesajlara ortalama yanıt süresi (kullanıcının beyanı; plan ve özet için).
export const ADS_REPLY_TIMES = ["minutes", "hour", "day"] as const;
export type AdsReplyTime = (typeof ADS_REPLY_TIMES)[number];

export const ADS_REPLY_TIME_LABEL: Readonly<Record<AdsReplyTime, string>> = {
  minutes: "Within minutes",
  hour: "Within an hour",
  day: "Within a day",
};

export const ADS_GENDERS = ["all", "men", "women"] as const;
export type AdsGender = (typeof ADS_GENDERS)[number];

export const ADS_GENDER_LABEL: Readonly<Record<AdsGender, string>> = {
  all: "All genders",
  men: "Men",
  women: "Women",
};

// GenderToggle's values (meta-ad-targeting-data.ts): "" all, "1" men, "2" women.
export function genderToggleValue(gender: AdsGender): string {
  return gender === "men" ? "1" : gender === "women" ? "2" : "";
}

export function genderFromToggle(value: string): AdsGender {
  return value === "1" ? "men" : value === "2" ? "women" : "all";
}

export const ADS_LIMITS = {
  name: 120,
  // Meta shows about 125 characters of primary text before "See more".
  primaryText: 125,
  link: 500,
  countries: 10,
  minAge: 13,
  maxAge: 65,
  maxDailyBudget: 1_000_000,
  title: 120,
  caption: 1000,
} as const;

export const DEFAULT_AGE_MIN = 18;
export const DEFAULT_AGE_MAX = ADS_LIMITS.maxAge;

// ---- Schemas ---------------------------------------------------------------------

const idField = z.string().min(1).max(64);

export function isWebLink(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

// "example.com/spring" typed without a scheme is meant as https.
export function withScheme(value: string): string {
  const text = value.trim();
  if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return `https://${text.replace(/^\/+/, "")}`;
}

// AB + AEA: buradaki ülkelerde gösterilen reklam, faydalanıcı ve ödeyici
// beyanı (DSA) ister; eksikse ad set adımı düşer ve yarım zincir kalır
// (docs/meta-ads-plan.md F0b, P5).
export const EU_EEA_COUNTRIES: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "IS", "LI", "NO",
];

export function targetsEuEea(countries: readonly string[]): boolean {
  return countries.some((code) => EU_EEA_COUNTRIES.includes(code));
}

const dsaField = z.string().trim().max(512).optional();

const briefFields = z.object({
  objective: z.enum(ADS_OBJECTIVES),
  // Major units of the ad account's currency ("20" = 20 TRY a day).
  dailyBudget: z.number().finite().positive().max(ADS_LIMITS.maxDailyBudget),
  days: z.literal(ADS_DURATIONS),
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .min(1)
    .max(ADS_LIMITS.countries),
  ageMin: z.number().int().min(ADS_LIMITS.minAge).max(ADS_LIMITS.maxAge),
  ageMax: z.number().int().min(ADS_LIMITS.minAge).max(ADS_LIMITS.maxAge),
  gender: z.enum(ADS_GENDERS),
  // Mesaj hedefinde bağlantı yoktur (kişi sohbete gider): boş olabilir.
  link: z.string().max(ADS_LIMITS.link),
  callToAction: z.enum(ADS_CTAS),
  // DSA: "Who benefits from this ad?" / "Who pays for it?" (yalnız AB/AEA).
  dsaBeneficiary: dsaField,
  dsaPayor: dsaField,
  // F5a: mesaj hedefi ve trafikte optimize edilen olay.
  messages: z
    .object({
      app: z.enum(ADS_MESSAGE_APPS),
      whatsappNumber: z
        .string()
        .trim()
        .regex(/^\+?[0-9][0-9 ()-]{5,19}$/)
        .optional(),
      replyTime: z.enum(ADS_REPLY_TIMES).optional(),
    })
    .optional(),
  trafficEvent: z.enum(["LINK_CLICKS", "LANDING_PAGE_VIEWS"]).optional(),
});

// Bağlantı mesaj hedefi dışında zorunludur; mesaj hedefi Engagement
// amacıyla kurulur, WhatsApp'ta numara istenir.
const linkWhenNeeded = (value: { link: string; messages?: unknown }) =>
  Boolean(value.messages) ? !value.link || isWebLink(value.link) : isWebLink(value.link);
const messagesOnEngagement = (value: { objective: string; messages?: unknown }) =>
  !value.messages || value.objective === "OUTCOME_ENGAGEMENT";
const whatsappNumberGiven = (value: {
  messages?: { app: string; whatsappNumber?: string };
}) => value.messages?.app !== "WHATSAPP" || Boolean(value.messages.whatsappNumber);

const agesInOrder = (value: { ageMin: number; ageMax: number }) =>
  value.ageMin <= value.ageMax;

const dsaWhenEu = (value: {
  countries: string[];
  dsaBeneficiary?: string;
  dsaPayor?: string;
}) =>
  !targetsEuEea(value.countries) ||
  (Boolean(value.dsaBeneficiary?.trim()) && Boolean(value.dsaPayor?.trim()));

// What the Brief sends: the fields plus the post picked to promote.
export const AdsBriefInputSchema = briefFields
  .extend({ creativeId: idField })
  .refine(agesInOrder, { path: ["ageMax"] })
  .refine(dsaWhenEu, { path: ["dsaBeneficiary"] })
  .refine(linkWhenNeeded, { path: ["link"] })
  .refine(messagesOnEngagement, { path: ["objective"] })
  .refine(whatsappNumberGiven, { path: ["messages"] });
export type AdsBriefInput = z.infer<typeof AdsBriefInputSchema>;

// The post the ad is made from, frozen by the server when the Brief is saved:
// its picture is the ad's picture (no new image is drawn).
const AdsSourceSchema = z.object({
  creativeId: idField,
  assetId: idField,
  title: z.string().max(ADS_LIMITS.title),
  caption: z.string().max(ADS_LIMITS.caption).optional(),
});
export type AdsSource = z.infer<typeof AdsSourceSchema>;

const AdsBriefSchema = briefFields
  .extend({
    source: AdsSourceSchema,
    // The ad account's currency and the Page the ad runs as, read from the
    // Meta Ads connection when the Brief was saved.
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    pageName: z.string().max(200).optional(),
    // The ad account the Brief was written for (its currency): the launch
    // is refused if another account is selected since.
    adAccountId: z.string().max(64).optional(),
  })
  .refine(agesInOrder, { path: ["ageMax"] })
  .refine(linkWhenNeeded, { path: ["link"] });
export type AdsBrief = z.infer<typeof AdsBriefSchema>;

const nameField = z.string().trim().min(1).max(ADS_LIMITS.name);

export const AdsPlanInputSchema = z.object({
  campaignName: nameField,
  adSetName: nameField,
  adName: nameField,
  primaryText: z.string().trim().min(1).max(ADS_LIMITS.primaryText),
});
export type AdsPlanInput = z.infer<typeof AdsPlanInputSchema>;

const AdsPlanSchema = AdsPlanInputSchema.extend({
  // Words of the AI's text that the brand rules forbid (shown, never blocked).
  flags: z.array(z.string().max(80)).max(3).optional(),
});
export type AdsPlan = z.infer<typeof AdsPlanSchema>;

// The launch: claimed first (two taps never plan two campaigns), then the
// campaign Task's id once it is planned. The chain after it is read live.
const AdsLaunchSchema = z.object({
  claimId: idField,
  startedAt: z.string().max(40),
  campaignTaskId: idField.optional(),
  completedAt: z.string().max(40).optional(),
  // Güvenli lansman v2 (docs/meta-ads-plan.md F3): lansman kaydı.
  launchId: idField.optional(),
});
export type AdsLaunch = z.infer<typeof AdsLaunchSchema>;

// Written by startModuleFlowAction: "Boost with an ad" names its post.
const AdsHintSchema = z.object({ sourceCreativeId: idField.optional() });
export type AdsHint = z.infer<typeof AdsHintSchema>;

export type AdsFlowState = {
  hint?: AdsHint;
  brief?: AdsBrief;
  plan?: AdsPlan;
  launch?: AdsLaunch;
};

function pick<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function parseAdsFlowState(data: unknown): AdsFlowState {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const state: AdsFlowState = {};
  const hint = pick(AdsHintSchema, record.hint);
  const brief = pick(AdsBriefSchema, record.brief);
  const plan = pick(AdsPlanSchema, record.plan);
  const launch = pick(AdsLaunchSchema, record.launch);
  if (hint) state.hint = hint;
  if (brief) state.brief = brief;
  if (plan) state.plan = plan;
  if (launch) state.launch = launch;
  return state;
}

// What goes back into card.data: the known parts only.
export function adsFlowData(state: AdsFlowState): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (state.hint) data.hint = state.hint;
  if (state.brief) data.brief = state.brief;
  if (state.plan) data.plan = state.plan;
  if (state.launch) data.launch = state.launch;
  return data;
}

// The step the card shows: the stored step, held back while what it needs is
// missing, and Launch for good once launched.
export function viewStepOf(
  step: ModuleFlowStep,
  state: AdsFlowState,
): ModuleFlowStep {
  if (state.launch) return "deliver";
  if (!state.brief || step === "brief") return "brief";
  if (!state.plan) return "plan";
  return step === "deliver" ? "review" : step;
}

// The Brief edits that make the written ad stale: another post or goal.
export function briefChangesPlan(
  before: AdsBrief | undefined,
  after: Pick<AdsBrief, "objective" | "source">,
): boolean {
  return (
    !before ||
    before.objective !== after.objective ||
    before.source.creativeId !== after.source.creativeId
  );
}

// ---- What the Brief loader sends -------------------------------------------------

export type AdsAccountStatus =
  "ready" | "needs-connect" | "needs-account" | "needs-page";

export type AdsAccountView = {
  status: AdsAccountStatus;
  currency?: string;
  pageName?: string;
  adAccountName?: string;
  adAccountId?: string;
};

export type AdsSourcePost = {
  creativeId: string;
  assetId: string;
  title: string;
  status: "APPROVED" | "PUBLISHED";
  channel?: ChannelKey;
};

export type AdsBriefOptions = {
  account: AdsAccountView;
  posts: AdsSourcePost[];
  defaults: { link?: string; countries: string[] };
  // F5a: sunulan hedefler (bayrak + hazır liste) ve hesabın durumu.
  goals?: {
    messages: boolean;
    messageApps: AdsMessageApp[];
    landingPageViews: boolean;
  };
  // Hesapta son 7 günde olay gönderen bir Meta Pixel var mı?
  hasPixel?: boolean;
};

// A project's markets as ad countries: the ones the targeting list knows.
export function defaultAdsCountries(
  countries: readonly string[],
  primary?: string | null,
): string[] {
  const known = new Set<string>(
    SUPPORTED_COUNTRIES.map((country) => country.code),
  );
  const ordered = [...(primary ? [primary] : []), ...countries]
    .map((code) => code.trim().toUpperCase())
    .filter((code) => known.has(code));
  return [...new Set(ordered)].slice(0, 5);
}

// ---- Validation messages ---------------------------------------------------------

export const ADS_BRIEF_ISSUE = {
  post: "Pick the post to promote.",
  budget: "Enter a daily budget above 0.",
  countries: "Pick at least one country.",
  ages: "Ages run from 13 to 65, the first not above the second.",
  link: "Enter your website link, starting with https://.",
  dsa: "Ads shown in the EU must say who benefits from the ad and who pays for it.",
  whatsapp: "Enter the WhatsApp number your Facebook Page uses.",
  other: "Check the brief.",
} as const;

const ISSUE_ORDER: readonly [string, string][] = [
  ["creativeId", ADS_BRIEF_ISSUE.post],
  ["objective", ADS_BRIEF_ISSUE.other],
  ["dailyBudget", ADS_BRIEF_ISSUE.budget],
  ["days", ADS_BRIEF_ISSUE.other],
  ["countries", ADS_BRIEF_ISSUE.countries],
  ["dsaBeneficiary", ADS_BRIEF_ISSUE.dsa],
  ["dsaPayor", ADS_BRIEF_ISSUE.dsa],
  ["messages", ADS_BRIEF_ISSUE.whatsapp],
  ["ageMin", ADS_BRIEF_ISSUE.ages],
  ["ageMax", ADS_BRIEF_ISSUE.ages],
  ["link", ADS_BRIEF_ISSUE.link],
];

// The one reason the Brief cannot go on yet, in the form's order; null when it
// can. The server parses the same schema.
export function briefIssue(input: unknown): string | null {
  const result = AdsBriefInputSchema.safeParse(input);
  if (result.success) return null;
  const fields = new Set(
    result.error.issues.map((issue) => String(issue.path[0] ?? "")),
  );
  for (const [field, message] of ISSUE_ORDER) {
    if (fields.has(field)) return message;
  }
  return ADS_BRIEF_ISSUE.other;
}

export const ADS_PLAN_ISSUE = {
  names: "Give the campaign, the ad set and the ad a name.",
  text: `Write the ad's text: up to ${ADS_LIMITS.primaryText} characters.`,
} as const;

export function planIssue(input: unknown): string | null {
  const result = AdsPlanInputSchema.safeParse(input);
  if (result.success) return null;
  return result.error.issues.some((issue) => issue.path[0] === "primaryText")
    ? ADS_PLAN_ISSUE.text
    : ADS_PLAN_ISSUE.names;
}

// ---- Money ----------------------------------------------------------------------

// Meta budgets are minor units with the currency's offset: 100 for most, 1 for
// the currencies Meta counts in whole units (JPY, KRW, HUF...). An unknown
// currency is Meta's default, 100. The one source is src/lib/ads/money.ts.
export { minorUnitOffset };

export function budgetMinorUnits(major: number, currency?: string): number {
  return toMinorUnits(major, currency);
}

// The budget as Meta will hold it, back in major units ("12.345" -> 12.35).
export function normalizeBudget(major: number, currency?: string): number {
  return budgetMinorUnits(major, currency) / minorUnitOffset(currency);
}

// "20 TRY", "12.50 EUR"; a plain number when the currency is not known.
export function formatBudget(major: number, currency?: string): string {
  const whole = minorUnitOffset(currency) === 1 || Number.isInteger(major);
  const number = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(major);
  return currency ? `${number} ${currency}` : number;
}

export function totalBudget(
  brief: Pick<AdsBrief, "dailyBudget" | "days" | "currency">,
): number {
  return normalizeBudget(brief.dailyBudget * brief.days, brief.currency);
}

// "20 TRY a day × 7 days = 140 TRY".
export function spendLine(
  brief: Pick<AdsBrief, "dailyBudget" | "days" | "currency">,
): string {
  return `${formatBudget(brief.dailyBudget, brief.currency)} a day × ${brief.days} days = ${formatBudget(totalBudget(brief), brief.currency)}`;
}

// ---- Words --------------------------------------------------------------------------

export function ageRangeText(ageMin: number, ageMax: number): string {
  return `${ageMin}–${ageMax >= ADS_LIMITS.maxAge ? `${ADS_LIMITS.maxAge}+` : ageMax}`;
}

// "Turkey, Germany · 18–65+ · All genders".
export function audienceLine(
  brief: Pick<AdsBrief, "countries" | "ageMin" | "ageMax" | "gender">,
): string {
  const places = brief.countries.map((code) => countryLabel(code));
  const where =
    places.length <= 3
      ? places.join(", ")
      : `${places.slice(0, 3).join(", ")} +${places.length - 3}`;
  return `${where} · ${ageRangeText(brief.ageMin, brief.ageMax)} · ${ADS_GENDER_LABEL[brief.gender]}`;
}

export function linkDomain(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return link;
  }
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Cut at a word boundary within `max` characters; `ellipsis` marks a cut.
export function clipWords(text: string, max: number, ellipsis = false): string {
  const flat = flatten(text);
  if (flat.length <= max) return flat;
  const room = ellipsis ? max - 1 : max;
  const cut = flat.slice(0, room);
  const space = cut.lastIndexOf(" ");
  const base = (space > room * 0.6 ? cut.slice(0, space) : cut).replace(
    /[\s,;:.\-–—]+$/,
    "",
  );
  return ellipsis ? `${base}…` : base;
}

// Ad text from a caption: no links (the ad has its own) and no hashtags.
export function adTextFrom(caption: string): string {
  return flatten(
    caption
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " "),
  );
}

// The texts the Plan starts from without the AI: the post's own words.
export function defaultAdsPlan(
  brief: Pick<
    AdsBrief,
    "source" | "objective" | "countries" | "ageMin" | "ageMax" | "gender"
  > & Partial<Pick<AdsBrief, "messages">>,
): AdsPlanInput {
  const caption = adTextFrom(brief.source.caption ?? "");
  const topic =
    clipWords(brief.source.title || caption || "Post", 60) || "Post";
  const goal = brief.messages
    ? "Messages"
    : ADS_OBJECTIVE_META[brief.objective].label;
  return {
    campaignName: clipWords(`${topic} · ${goal}`, ADS_LIMITS.name),
    adSetName: clipWords(
      `${brief.countries.join(", ")} · ${ageRangeText(brief.ageMin, brief.ageMax)} · ${ADS_GENDER_LABEL[brief.gender]}`,
      ADS_LIMITS.name,
    ),
    adName: clipWords(topic, ADS_LIMITS.name),
    primaryText: clipWords(caption || topic, ADS_LIMITS.primaryText, true),
  };
}

// ---- Launch payload -----------------------------------------------------------------

// The META_CAMPAIGN_CREATE payload. The chain relays carry the rest:
// meta-campaign-chain-relay.ts plans the ad set from `__pendingAdSet`,
// meta-adset-chain-relay.ts the ad from its `pendingAd`. Everything is PAUSED.
// The budget lives on the ad set only: Meta takes a budget on the campaign or
// on its ad sets, never both, and the ad set always gets one (the provider
// requires it). There is no end time: the provider sends none, so a launched ad
// runs until it is paused.
export function adsLaunchPayload(brief: AdsBrief, plan: AdsPlanInput) {
  const genders =
    brief.gender === "men" ? [1] : brief.gender === "women" ? [2] : undefined;
  // The account and currency the Brief was written in travel with every link
  // of the chain: a write is refused when the selection changed since
  // (docs/meta-ads-plan.md F0b).
  const account = {
    ...(brief.adAccountId ? { adAccountId: brief.adAccountId } : {}),
    ...(brief.currency ? { currency: brief.currency } : {}),
  };
  const dsa =
    targetsEuEea(brief.countries) && brief.dsaBeneficiary && brief.dsaPayor
      ? { dsa: { beneficiary: brief.dsaBeneficiary, payor: brief.dsaPayor } }
      : {};
  return {
    name: plan.campaignName,
    objective: brief.objective,
    status: "PAUSED",
    ...account,
    __pendingAdSet: {
      name: plan.adSetName,
      // Minor units of the ad account's currency (the provider's field name).
      dailyBudgetCents: budgetMinorUnits(brief.dailyBudget, brief.currency),
      // The end date is set when the ad set is created, `days` after it:
      // the chain may wait on three approvals, so a date fixed at launch
      // would cut the plan short or already be past.
      durationDays: brief.days,
      // 0: the Brief's ages and gender are hard limits, as today.
      advantageAudience: 0,
      ...account,
      ...dsa,
      billingEvent: ADS_BILLING_EVENT,
      optimizationGoal: ADS_OBJECTIVE_META[brief.objective].optimizationGoal,
      targeting: {
        countries: brief.countries,
        ageMin: brief.ageMin,
        ageMax: brief.ageMax,
        ...(genders ? { genders } : {}),
      },
      pendingAd: {
        name: plan.adName,
        message: plan.primaryText,
        link: brief.link,
        imageAssetId: brief.source.assetId,
        callToActionType: brief.callToAction,
        format: "SINGLE_IMAGE",
        status: "PAUSED",
      },
    },
  };
}
