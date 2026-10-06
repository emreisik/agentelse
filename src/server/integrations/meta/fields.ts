// Seviye başına alan listeleri (docs/meta-ads-plan.md §3.2). Düğümde olmayan
// bir alan bütün çağrıyı kod 100 ile düşürür; listeler bu yüzden ayrı ve tek
// yerdedir, sözleşme testleri fikstürle doğrular.

export const ACCOUNT_HEALTH_FIELDS = [
  "account_status",
  "disable_reason",
  "currency",
  "timezone_name",
  "spend_cap",
  "amount_spent",
  "min_daily_budget",
  "user_tasks",
  "business",
  "is_personal",
].join(",");

// MANAGE/ADVERTISE görevi ister: ayrı ve hataya dayanıklı okunur.
export const ACCOUNT_FUNDING_FIELDS = "funding_source_details";
// Varlığı doğrulanmalı: ayrı okunur, yoksa yok sayılır.
export const ACCOUNT_OPTIONAL_FIELDS = [
  "min_campaign_group_spend_cap",
  "default_dsa_payor",
  "default_dsa_beneficiary",
].join(",");

export const CAMPAIGN_FIELDS = [
  "id",
  "name",
  "status",
  "configured_status",
  "effective_status",
  "objective",
  "daily_budget",
  "lifetime_budget",
  "spend_cap",
  "budget_remaining",
  "bid_strategy",
  "special_ad_categories",
  "issues_info",
  "created_time",
  "updated_time",
].join(",");

export const ADSET_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "status",
  "configured_status",
  "effective_status",
  "optimization_goal",
  "billing_event",
  "destination_type",
  "promoted_object",
  "targeting",
  "learning_stage_info",
  "daily_budget",
  "lifetime_budget",
  "budget_remaining",
  "start_time",
  "end_time",
  "issues_info",
  "created_time",
  "updated_time",
].join(",");

export const AD_FIELDS = [
  "id",
  "name",
  "adset_id",
  "campaign_id",
  "status",
  "configured_status",
  "effective_status",
  "creative{id,effective_object_story_id}",
  "ad_review_feedback",
  "failed_delivery_checks",
  "issues_info",
  "created_time",
  "updated_time",
].join(",");

// Günlük insights. Kaldırılan pencereler (7d_view, 28d_view) ve opt-in
// isteyen kırılımlar istenmez.
export const INSIGHT_FIELDS = [
  "date_start",
  "date_stop",
  "account_id",
  "campaign_id",
  "adset_id",
  "ad_id",
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "actions",
  "action_values",
  "video_thruplay_watched_actions",
  "attribution_setting",
].join(",");

// Meta'nın kendi "Results" sütunu (doğrulanmalı): reddedilirse alanlar
// atılıp hedefe göre yedek eşlemeye düşülür (src/lib/ads/results.ts).
export const INSIGHT_RESULT_FIELDS = ["results", "cost_per_result"].join(",");

export const AD_RANKING_FIELDS = [
  "quality_ranking",
  "engagement_rate_ranking",
  "conversion_rate_ranking",
].join(",");

export const WINDOW_FIELDS = ["reach", "frequency", "impressions"].join(",");

// Listelenmeyen bir nesnenin durumu.
export const OBJECT_STATUS_FIELDS = "effective_status,configured_status";
