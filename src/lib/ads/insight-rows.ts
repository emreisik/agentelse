import { parseMajorText } from "./money";
import {
  metaResultsOf,
  resultCountFor,
  type InsightResultInput,
} from "./results";

// Ham günlük insights satırı → AdsInsightDaily alanları (docs/meta-ads-plan.md
// §3.2, §4). Saf: senkron ve testler kullanır.

export type InsightLevel = "ACCOUNT" | "CAMPAIGN" | "ADSET" | "AD";

type ActionRow = { action_type?: string; value?: string };

export type RawDailyInsight = InsightResultInput & {
  date_start?: string;
  account_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  spend?: string;
  frequency?: string;
  clicks?: string;
  inline_link_clicks?: string;
  action_values?: ActionRow[];
  attribution_setting?: string;
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
};

export type DailyRow = {
  level: InsightLevel;
  externalId: string;
  date: string;
  spendMinor: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  clicks: number;
  linkClicks: number;
  landingPageViews: number;
  results: number | null;
  resultActionType: string | null;
  actionValuesMinor: number | null;
  actions: Record<string, number> | null;
  video3s: number | null;
  thruplays: number | null;
  rankings: Record<string, string> | null;
  attributionSetting: string | null;
};

// Saklanan action anahtarları (≤ 10): sonuç ve teşhis için gerekenler.
export const KEPT_ACTIONS: readonly string[] = [
  "link_click",
  "landing_page_view",
  "post_engagement",
  "lead",
  "onsite_conversion.lead_grouped",
  "onsite_conversion.messaging_conversation_started_7d",
  "offsite_conversion.fb_pixel_purchase",
  "offsite_conversion.fb_pixel_lead",
  "video_view",
  "omni_purchase",
];

const PURCHASE_VALUE_KEYS = [
  "offsite_conversion.fb_pixel_purchase",
  "omni_purchase",
  "purchase",
];

function int(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function idFor(raw: RawDailyInsight, level: InsightLevel): string | null {
  switch (level) {
    case "ACCOUNT":
      return raw.account_id
        ? raw.account_id.startsWith("act_")
          ? raw.account_id
          : `act_${raw.account_id}`
        : null;
    case "CAMPAIGN":
      return raw.campaign_id ?? null;
    case "ADSET":
      return raw.adset_id ?? null;
    case "AD":
      return raw.ad_id ?? null;
  }
}

export function dailyRowFrom(
  raw: RawDailyInsight,
  level: InsightLevel,
  options: {
    currency?: string | null;
    // Yedek sonuç türü (aynadaki ad set'in resultActionType'ı); kampanya /
    // hesap düzeyinde yalnız bütün ad set'ler aynı türdeyse verilir.
    resultActionType?: string | null;
    // ACCOUNT satırında account_id gelmeyebilir.
    externalId?: string;
  } = {},
): DailyRow | null {
  const externalId = options.externalId ?? idFor(raw, level);
  if (!externalId || !raw.date_start) return null;

  const actions: Record<string, number> = {};
  for (const row of raw.actions ?? []) {
    if (row.action_type && KEPT_ACTIONS.includes(row.action_type)) {
      actions[row.action_type] = int(row.value);
    }
  }
  const valueRow = PURCHASE_VALUE_KEYS.map((key) =>
    raw.action_values?.find((row) => row.action_type === key),
  ).find(Boolean);

  const result =
    metaResultsOf(raw) ??
    (options.resultActionType
      ? {
          count: resultCountFor(raw, options.resultActionType),
          actionType: options.resultActionType,
        }
      : null);

  const thruplays = raw.video_thruplay_watched_actions
    ? raw.video_thruplay_watched_actions.reduce(
        (sum, row) => sum + int(row.value),
        0,
      )
    : null;

  const rankings: Record<string, string> = {};
  if (raw.quality_ranking) rankings.quality = raw.quality_ranking;
  if (raw.engagement_rate_ranking) {
    rankings.engagement = raw.engagement_rate_ranking;
  }
  if (raw.conversion_rate_ranking) {
    rankings.conversion = raw.conversion_rate_ranking;
  }

  const frequency = Number(raw.frequency);
  return {
    level,
    externalId,
    date: raw.date_start,
    spendMinor: parseMajorText(raw.spend, options.currency),
    impressions: int(raw.impressions),
    reach: int(raw.reach),
    frequency: Number.isFinite(frequency) && raw.frequency ? frequency : null,
    clicks: int(raw.clicks),
    linkClicks: int(raw.inline_link_clicks),
    landingPageViews: actions.landing_page_view ?? 0,
    results: result ? result.count : null,
    resultActionType: result ? result.actionType : null,
    actionValuesMinor: valueRow
      ? parseMajorText(valueRow.value, options.currency)
      : null,
    actions: Object.keys(actions).length > 0 ? actions : null,
    video3s: actions.video_view ?? null,
    thruplays,
    rankings: Object.keys(rankings).length > 0 ? rankings : null,
    attributionSetting: raw.attribution_setting ?? null,
  };
}

// Kampanya ya da hesap düzeyinde yedek sonuç türü: alt ad set'lerin hepsi
// aynı türdeyse o tür, değilse null (karışık hedefte toplam sonuç anlamsız).
export function sharedResultType(
  types: (string | null | undefined)[],
): string | null {
  const unique = new Set(types.filter((type): type is string => Boolean(type)));
  return unique.size === 1 ? [...unique][0]! : null;
}

export type InsightTotals = {
  spendMinor: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  results: number | null;
  actionValuesMinor: number | null;
};

// Günlük satırların toplamı (para: yalnız hesap ve kampanya satırları için
// kullanılır, §3.2). Bir gün bile sonucu bilinmiyorsa toplam sonuç da
// bilinmiyor sayılmaz: bilinen günler toplanır, hiçbiri bilinmiyorsa null.
export function sumRows(
  rows: Pick<
    DailyRow,
    | "spendMinor"
    | "impressions"
    | "clicks"
    | "linkClicks"
    | "results"
    | "actionValuesMinor"
  >[],
): InsightTotals {
  let results: number | null = null;
  let values: number | null = null;
  const totals = rows.reduce(
    (acc, row) => {
      if (row.results !== null) results = (results ?? 0) + row.results;
      if (row.actionValuesMinor !== null) {
        values = (values ?? 0) + row.actionValuesMinor;
      }
      return {
        spendMinor: acc.spendMinor + row.spendMinor,
        impressions: acc.impressions + row.impressions,
        clicks: acc.clicks + row.clicks,
        linkClicks: acc.linkClicks + row.linkClicks,
      };
    },
    { spendMinor: 0, impressions: 0, clicks: 0, linkClicks: 0 },
  );
  return { ...totals, results, actionValuesMinor: values };
}
