// "Sonuç" metriğinin eşlemesi (docs/meta-ads-plan.md §3.2, F0b ilk sürüm).
// Ads Manager'ın "Results" sütunu ad set'in optimizasyon hedefinden gelir;
// "en yüksek sayılı action" sezgisi ise 0 lead ile para yakan bir kampanyayı
// link tıklamalarıyla "sonuçlu" gösterebiliyordu. F2'de Meta'nın kendi
// `results` alanı birincil kaynak olur; bu tablo yedek ve çapraz kontrol kalır.

// optimization_goal -> sonuç sayılan action_type. REACH ve IMPRESSIONS
// action değil, satırın kendi alanıdır (RESULT_FIELD_BY_GOAL).
export const RESULT_ACTION_BY_GOAL: Readonly<Record<string, string>> = {
  LINK_CLICKS: "link_click",
  LANDING_PAGE_VIEWS: "landing_page_view",
  POST_ENGAGEMENT: "post_engagement",
  LEAD_GENERATION: "lead",
  QUALITY_LEAD: "lead",
  CONVERSATIONS: "onsite_conversion.messaging_conversation_started_7d",
};

export const RESULT_FIELD_BY_GOAL: Readonly<
  Record<string, "reach" | "impressions">
> = {
  REACH: "reach",
  IMPRESSIONS: "impressions",
};

export type ResultSource =
  | { kind: "action"; actionType: string }
  | { kind: "field"; field: "reach" | "impressions" };

// Hedefin sonucu nereden okunur; bilinmeyen hedefte null (tahmin yapılmaz).
export function resultSourceForGoal(
  optimizationGoal: string | null | undefined,
): ResultSource | null {
  if (!optimizationGoal) return null;
  const actionType = RESULT_ACTION_BY_GOAL[optimizationGoal];
  if (actionType) return { kind: "action", actionType };
  const field = RESULT_FIELD_BY_GOAL[optimizationGoal];
  if (field) return { kind: "field", field };
  return null;
}

// F2: Meta'nın `results` alanı ve genişletilmiş yedek eşleme.

type ActionRow = { action_type?: string; value?: string };

export type InsightResultInput = {
  results?: { indicator?: string; values?: { value?: string }[] }[];
  actions?: ActionRow[];
  video_thruplay_watched_actions?: ActionRow[];
  reach?: string;
  impressions?: string;
};

function count(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function actionCount(rows: ActionRow[] | undefined, actionType: string): number | null {
  const row = rows?.find((entry) => entry.action_type === actionType);
  return row ? count(row.value) : null;
}

// Meta `results`: [{ indicator: "actions:link_click", values: [{ value }] }].
// Gösterge "actions:" önekiyle gelebilir; boş dizi ya da değersiz gösterge
// "bilinmiyor" sayılır (yedeğe düşülür). Biçim fikstürle doğrulanmalı.
export function metaResultsOf(
  input: InsightResultInput,
): { count: number; actionType: string } | null {
  const first = input.results?.find((row) => row?.indicator);
  if (!first?.indicator) return null;
  const values = first.values ?? [];
  if (values.length === 0) return null;
  const total = values.reduce((sum, entry) => sum + count(entry?.value), 0);
  return {
    count: total,
    actionType: first.indicator.replace(/^actions:/, ""),
  };
}

// Hedefin (ve dönüşümde piksel olayının) sonuç türü. Bilinmeyen hedefte
// null; tahmin yapılmaz. Ayna bunu ad set satırına yazar (resultActionType).
export function resultActionTypeForGoal(
  goal: string | null | undefined,
  customEventType?: string | null,
): string | null {
  if (!goal) return null;
  if (goal === "THRUPLAY") return "video_thruplay_watched";
  if (goal === "OFFSITE_CONVERSIONS" || goal === "VALUE") {
    const event = (customEventType ?? (goal === "VALUE" ? "PURCHASE" : ""))
      .toLowerCase();
    return event ? `offsite_conversion.fb_pixel_${event}` : null;
  }
  if (goal === "LEAD_GENERATION" || goal === "QUALITY_LEAD") return "lead";
  const source = resultSourceForGoal(goal);
  if (!source) return null;
  return source.kind === "field" ? source.field : source.actionType;
}

// Satırda bu sonuç türünün sayısı.
export function resultCountFor(
  input: InsightResultInput,
  actionType: string,
): number {
  if (actionType === "reach" || actionType === "impressions") {
    return count(input[actionType]);
  }
  if (actionType === "video_thruplay_watched") {
    return (input.video_thruplay_watched_actions ?? []).reduce(
      (sum, row) => sum + count(row.value),
      0,
    );
  }
  if (actionType === "lead") {
    return (
      actionCount(input.actions, "lead") ??
      actionCount(input.actions, "onsite_conversion.lead_grouped") ??
      0
    );
  }
  return actionCount(input.actions, actionType) ?? 0;
}

// Yedek: ad set'in hedefinden sonuç (Meta `results` boş döndüğünde).
export function fallbackResultOf(
  input: InsightResultInput,
  goal: string | null | undefined,
  customEventType?: string | null,
): { count: number; actionType: string } | null {
  const actionType = resultActionTypeForGoal(goal, customEventType);
  return actionType
    ? { count: resultCountFor(input, actionType), actionType }
    : null;
}

// Okunur sonuç adı (UI).
export function resultLabel(actionType: string | null | undefined): string {
  switch (actionType) {
    case "link_click":
      return "Link clicks";
    case "landing_page_view":
      return "Landing page views";
    case "post_engagement":
      return "Post engagements";
    case "lead":
    case "onsite_conversion.lead_grouped":
    case "offsite_conversion.fb_pixel_lead":
      return "Leads";
    case "onsite_conversion.messaging_conversation_started_7d":
      return "Conversations started";
    case "offsite_conversion.fb_pixel_purchase":
    case "purchase":
    case "omni_purchase":
      return "Purchases";
    case "reach":
      return "People reached";
    case "impressions":
      return "Impressions";
    case "video_thruplay_watched":
      return "ThruPlays";
    default:
      return "Results";
  }
}
