import "server-only";

import {
  siteLabel,
  type AnalyticsPeriod,
  type FailReason,
} from "@/lib/module-flows/analytics/catalog";
import {
  MAX_QUERIES,
  failedSection,
  isMetricKey,
  okSection,
  type ReportMetric,
  type ReportQuery,
  type ReportSection,
} from "@/lib/module-flows/analytics/report";
import {
  GoogleApiError,
  fetchSearchConsoleQueryRows,
  fetchSearchConsoleReport,
} from "@/server/integrations/google-client";
import {
  averageSessionSeconds,
  engagementRate,
} from "@/lib/website-analytics/totals";
import type { ActiveGoogleConnections } from "@/server/integrations/google-connections";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import {
  readGaWindow,
  type GaWindow,
} from "@/server/website-analytics/readers";
import { readSearchConsoleWarehouse } from "@/server/seo/readers";
import { readGaModuleSections } from "./ga-sections";

// The Google sections of a report. Google Analytics reads the GA4 Data API with
// its own request (google-client.ts's fetchGa4Report only knows two metrics):
// the period's full days up to yesterday. Search Console goes through
// google-client.ts as it is: totals plus the five searches with most clicks.
// Each connection refreshes its own token. Never throws.

const ANALYTICS_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const TIMEOUT_MS = 8_000;
const QUERY_MAX = 200;

// GA4 metric name -> report metric. Rates come as fractions, durations in
// seconds.
export const GA4_METRICS = [
  ["activeUsers", "ga.activeUsers"],
  ["newUsers", "ga.newUsers"],
  ["sessions", "ga.sessions"],
  ["screenPageViews", "ga.views"],
  ["engagementRate", "ga.engagementRate"],
  ["averageSessionDuration", "ga.avgSessionDuration"],
] as const satisfies readonly (readonly [string, ReportMetric["key"]])[];

type Ga4MetricName = (typeof GA4_METRICS)[number][0];
export type Ga4Summary = Partial<Record<Ga4MetricName, number>>;

type RunReportResponse = {
  metricHeaders?: Array<{ name?: string }>;
  rows?: Array<{ metricValues?: Array<{ value?: string }> }>;
};

// A Google error as Google words it: OAuth errors carry a string code
// (invalid_grant), API errors a status (PERMISSION_DENIED).
export function googleFailReason(error: unknown): FailReason {
  if (!(error instanceof GoogleApiError)) return "error";
  const code = error.googleErrorCode;
  if (code === "invalid_grant" || code === "UNAUTHENTICATED") return "expired";
  if (code === "PERMISSION_DENIED" || /permission/i.test(error.message)) {
    return "permission";
  }
  if (
    code === "RESOURCE_EXHAUSTED" ||
    /quota|rate limit/i.test(error.message)
  ) {
    return "rate_limited";
  }
  return "error";
}

export async function fetchGa4Summary(
  accessToken: string,
  propertyId: string,
  days: number,
): Promise<Ga4Summary> {
  let response: Response;
  try {
    response = await fetch(
      `${ANALYTICS_DATA_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // `days` whole days, today (still running) left out.
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: "yesterday" }],
          metrics: GA4_METRICS.map(([name]) => ({ name })),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new GoogleApiError(
      timedOut ? "Google API request timed out" : "Could not reach Google API",
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = (
      body as { error?: { message?: string; status?: string } } | null
    )?.error;
    throw new GoogleApiError(
      failure?.message ?? `Google API error (HTTP ${response.status})`,
      failure?.status,
    );
  }
  const result = (body ?? {}) as RunReportResponse;
  const values = result.rows?.[0]?.metricValues ?? [];
  const summary: Ga4Summary = {};
  (result.metricHeaders ?? []).forEach((header, index) => {
    const metric = GA4_METRICS.find(([name]) => name === header.name);
    const value = Number(values[index]?.value);
    if (metric && Number.isFinite(value)) summary[metric[0]] = value;
  });
  return summary;
}

export function ga4Metrics(summary: Ga4Summary): ReportMetric[] {
  const metrics: ReportMetric[] = [];
  for (const [name, key] of GA4_METRICS) {
    const value = summary[name];
    if (value === undefined) {
      // GA4 sends no row for a property with no visits: the counts are zero,
      // the rates simply unknown.
      if (name === "engagementRate" || name === "averageSessionDuration") {
        continue;
      }
      metrics.push({ key, value: 0 });
      continue;
    }
    metrics.push({
      key,
      value: name === "engagementRate" ? value * 100 : value,
    });
  }
  return metrics;
}

// Ambardaki pencere (GA_SYNC): sayılar GA'nın kendi dönem tanımlarıyla aynı;
// toplanabilir metrikler günlüklerden, tekil kullanıcılar kayan pencereden,
// oranlar bileşenlerinden. Kullanıcı sayısı yoksa satır atlanır.
export function ga4MetricsFromWindow(window: GaWindow): ReportMetric[] {
  const { totals } = window;
  const metrics: ReportMetric[] = [];
  if (window.users) {
    metrics.push({ key: "ga.activeUsers", value: window.users.activeUsers });
  }
  metrics.push(
    { key: "ga.newUsers", value: totals.newUsers },
    { key: "ga.sessions", value: totals.sessions },
    { key: "ga.views", value: totals.screenPageViews },
  );
  const rate = engagementRate(totals);
  if (rate !== null) metrics.push({ key: "ga.engagementRate", value: rate });
  const duration = averageSessionSeconds(totals);
  if (duration !== null) {
    metrics.push({ key: "ga.avgSessionDuration", value: duration });
  }
  return metrics;
}

export async function collectGa4(
  connection: ActiveGoogleConnections["analytics"],
  period: AnalyticsPeriod,
  projectId?: string,
): Promise<ReportSection> {
  if (!connection) return failedSection("ga4", "not_connected");
  try {
    // Ambar pencereyi eksiksiz kapsıyorsa Google'a çağrı yapılmaz.
    const window = projectId
      ? await readGaWindow({
          projectId,
          propertyId: connection.propertyId,
          days: period,
        }).catch(() => null)
      : null;
    if (window) {
      return okSection("ga4", {
        days: period,
        metrics: ga4MetricsFromWindow(window),
        ...(await readGaModuleSections({
          projectId: projectId ?? "",
          propertyId: connection.propertyId,
          window,
        })),
      });
    }
    const token = await getFreshGoogleAccessToken(connection.credential);
    const summary = await fetchGa4Summary(token, connection.propertyId, period);
    return okSection("ga4", { days: period, metrics: ga4Metrics(summary) });
  } catch (error) {
    const reason = googleFailReason(error);
    if (reason === "error") {
      console.error(
        "[analytics] google analytics read failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return failedSection("ga4", reason);
  }
}

export async function collectSearchConsole(
  connection: ActiveGoogleConnections["searchConsole"],
  period: AnalyticsPeriod,
  projectId?: string,
): Promise<ReportSection> {
  if (!connection) return failedSection("searchConsole", "not_connected");
  try {
    // Ambar pencereyi eksiksiz kapsıyorsa (GSC_SYNC) belirteç yenilenmez,
    // Google'a çağrı yapılmaz; kesin günler PT, marka ayrımı hazırsa eklenir.
    const stored = projectId
      ? await readSearchConsoleWarehouse({
          projectId,
          siteUrl: connection.siteUrl,
          days: period,
        }).catch(() => null)
      : null;
    if (stored) {
      const metrics: ReportMetric[] = stored.metrics.flatMap((metric) =>
        isMetricKey(metric.key) ? [{ key: metric.key, value: metric.value }] : [],
      );
      return okSection("searchConsole", {
        days: period,
        account: siteLabel(connection.siteUrl) || null,
        metrics,
        queries: stored.queries.slice(0, MAX_QUERIES),
      });
    }
    const token = await getFreshGoogleAccessToken(connection.credential);
    const [totals, rows] = await Promise.all([
      fetchSearchConsoleReport(token, connection.siteUrl, period),
      fetchSearchConsoleQueryRows(
        token,
        connection.siteUrl,
        ["query"],
        period,
        MAX_QUERIES,
      ),
    ]);
    const metrics: ReportMetric[] = [
      { key: "sc.clicks", value: totals.clicks },
      { key: "sc.impressions", value: totals.impressions },
    ];
    // A rate and a position mean nothing without a single impression.
    if (totals.impressions > 0) {
      metrics.push(
        { key: "sc.ctr", value: totals.ctr * 100 },
        { key: "sc.position", value: totals.position },
      );
    }
    const queries: ReportQuery[] = [];
    for (const row of rows) {
      const query = (row.keys[0] ?? "").replace(/\s+/g, " ").trim();
      if (!query) continue;
      queries.push({
        query: query.slice(0, QUERY_MAX),
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr * 100,
        position: row.position,
      });
    }
    return okSection("searchConsole", {
      days: period,
      account: siteLabel(connection.siteUrl) || null,
      metrics,
      queries: queries.slice(0, MAX_QUERIES),
    });
  } catch (error) {
    const reason = googleFailReason(error);
    if (reason === "error") {
      console.error(
        "[analytics] search console read failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return failedSection("searchConsole", reason);
  }
}
