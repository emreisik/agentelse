// The Analytics module's fixed vocabulary (docs/modules.md): the periods a
// report can cover, the sources it reads and why a source can't be read. Pure
// and isomorphic: the card, the server actions and the exports share it.

export const ANALYTICS_PERIODS = [7, 28, 90] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = 28;

export function isAnalyticsPeriod(value: unknown): value is AnalyticsPeriod {
  return (ANALYTICS_PERIODS as readonly unknown[]).includes(value);
}

// Meta answers at most this many days of Instagram account totals per call, so
// a longer period reads its last 30 days (and says so).
export const INSTAGRAM_WINDOW_DAYS = 30;

// In report order.
export const ANALYTICS_SOURCES = [
  "instagram",
  "metaAds",
  "ga4",
  "searchConsole",
] as const;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];

export function isAnalyticsSource(value: unknown): value is AnalyticsSource {
  return (ANALYTICS_SOURCES as readonly unknown[]).includes(value);
}

// Product names, not sentences: they read the same in every language.
export const SOURCE_LABEL: Readonly<Record<AnalyticsSource, string>> = {
  instagram: "Instagram",
  metaAds: "Meta Ads",
  ga4: "Google Analytics",
  searchConsole: "Search Console",
};

// The known sources among `values`, once each, in report order.
export function orderedSources(values: readonly unknown[]): AnalyticsSource[] {
  return ANALYTICS_SOURCES.filter((source) => values.includes(source));
}

// Can the report read a source right now (the brief's live state)? "setup":
// connected, but the ad account, property or site is not picked yet.
export const SOURCE_STATUSES = [
  "connected",
  "setup",
  "expired",
  "not_connected",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type SourceState = { status: SourceStatus; account: string | null };
export type AnalyticsSourceStates = Record<AnalyticsSource, SourceState>;

// Why a section of a built report holds no numbers.
export const FAIL_REASONS = [
  "not_connected",
  "setup",
  "expired",
  "permission",
  "rate_limited",
  "no_data",
  "error",
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

// The reasons the person fixes on the integrations page.
export function isConnectionReason(reason: FailReason): boolean {
  return (
    reason === "not_connected" ||
    reason === "setup" ||
    reason === "expired" ||
    reason === "permission"
  );
}

export function integrationsHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/integrations`;
}

// "sc-domain:biduniq.com" -> "biduniq.com", "https://www.biduniq.com/" ->
// "www.biduniq.com": the site as a person reads it.
export function siteLabel(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}
