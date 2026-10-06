import "server-only";

// A thin, real Google REST API wrapper — no SDK, plain `fetch` (same
// pattern as telegram-client.ts): the minimum surface of the GA4 (Analytics
// Admin/Data API) + Search Console API needed for these integrations. The
// OAuth flow, the HTTP gate (timeouts, safe retries) and the error catalog
// live in the shared Google core (src/server/integrations/google/*); they are
// re-exported here so existing callers keep their imports.

import { googleFetchJson } from "@/server/integrations/google/http";

export {
  GOOGLE_PROVIDER,
  GOOGLE_SERVICES,
  GOOGLE_SERVICE_LABEL,
  parseGoogleService,
  type GoogleService,
} from "@/server/integrations/google/services";
export { GoogleApiError } from "@/server/integrations/google/errors";
export {
  buildGoogleAuthorizeUrl,
  exchangeGoogleAuthCode,
  refreshGoogleAccessToken,
} from "@/server/integrations/google/oauth";

const ANALYTICS_ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const ANALYTICS_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const SEARCH_CONSOLE_BASE =
  "https://searchconsole.googleapis.com/webmasters/v3";

// accountSummaries sayfalıdır; çok müşterili bir ajans hesabı 200'den fazla
// mülk görebilir. Sonsuz döngüye karşı en çok 10 sayfa (2.000 mülk).
const ACCOUNT_SUMMARY_PAGE_SIZE = 200;
const ACCOUNT_SUMMARY_MAX_PAGES = 10;

// Bookkeeping for GoogleAnalyticsScanner's due-scan check (see
// google-analytics-scanner.ts) — same pattern as Meta's
// lastAdsPerformanceScanAt/adsPerformanceScanFailureCount in
// meta-client.ts's MetaAdsMetadata.
type GoogleScanBookkeeping = {
  lastAnalyticsScanAt?: string;
  analyticsScanFailureCount?: number;
};

// Hangi Google hesabıyla bağlanıldığı. `googleSub` (userinfo `id`) Google'da
// iptalin güvenli olup olmadığına karar verirken kullanılır
// (google-disconnect.ts); e-posta değişse de aynı kalır.
export type GoogleAccountIdentity = {
  connectedEmail?: string;
  googleSub?: string;
};

// IntegrationCredential.metadata for provider "google_analytics".
export type GoogleAnalyticsMetadata = GoogleScanBookkeeping &
  GoogleAccountIdentity & {
    ga4Properties: Ga4Property[];
    ga4ListError?: string;
    selectedGa4PropertyId?: string;
    selectedGa4PropertyName?: string;
    lastTestResult?: {
      testedAt: string;
      ga4ActiveUsers?: number;
      error?: string;
    };
    // One-deep snapshot of the last scan's GA4 aggregate — powers
    // seo-rules.ts's evaluateTrafficFinding the same way Meta's
    // previousScanSnapshot powers evaluateTrendFinding.
    previousAnalyticsSnapshot?: {
      ga4?: { activeUsers: number; sessions: number };
    };
  };

// IntegrationCredential.metadata for provider "google_search_console".
export type GoogleSearchConsoleMetadata = GoogleScanBookkeeping &
  GoogleAccountIdentity & {
    searchConsoleSites: SearchConsoleSite[];
    gscListError?: string;
    selectedSearchConsoleSite?: string;
    lastTestResult?: {
      testedAt: string;
      gscClicks?: number;
      gscImpressions?: number;
      error?: string;
    };
  };

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

export type Ga4Property = {
  propertyId: string;
  propertyName: string;
  accountName: string;
};

export async function listGa4Properties(
  accessToken: string,
): Promise<Ga4Property[]> {
  const properties: Ga4Property[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < ACCOUNT_SUMMARY_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      pageSize: String(ACCOUNT_SUMMARY_PAGE_SIZE),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const result = await googleFetchJson<{
      accountSummaries?: Array<{
        displayName?: string;
        propertySummaries?: Array<{ property?: string; displayName?: string }>;
      }>;
      nextPageToken?: string;
    }>(
      `${ANALYTICS_ADMIN_BASE}/accountSummaries?${params.toString()}`,
      { headers: bearer(accessToken) },
      { kind: "admin" },
    );

    for (const account of result.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        if (!property.property) continue;
        properties.push({
          propertyId: property.property.replace(/^properties\//, ""),
          propertyName: property.displayName ?? property.property,
          accountName: account.displayName ?? "",
        });
      }
    }
    pageToken = result.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return properties;
}

export type SearchConsoleSite = {
  siteUrl: string;
  permissionLevel: string;
};

export async function listSearchConsoleSites(
  accessToken: string,
): Promise<SearchConsoleSite[]> {
  const result = await googleFetchJson<{
    siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
  }>(`${SEARCH_CONSOLE_BASE}/sites`, { headers: bearer(accessToken) });

  const sites: SearchConsoleSite[] = [];
  for (const site of result.siteEntry ?? []) {
    // searchAnalytics calls against unverified sites return 403 — we don't
    // put them in the selection list at all.
    if (!site.siteUrl || site.permissionLevel === "siteUnverifiedUser") {
      continue;
    }
    sites.push({
      siteUrl: site.siteUrl,
      permissionLevel: site.permissionLevel ?? "unknown",
    });
  }
  return sites;
}

// Sum of activeUsers/sessions for the last `days` days — used both by the
// "Test" button (days=7 default) and by GoogleApiProvider (days=28), which
// runs the ANALYTICS_ANALYSIS task.
export async function fetchGa4Report(
  accessToken: string,
  propertyId: string,
  days = 7,
): Promise<{ activeUsers: number; sessions: number }> {
  const result = await googleFetchJson<{
    rows?: Array<{ metricValues?: Array<{ value?: string }> }>;
  }>(
    `${ANALYTICS_DATA_BASE}/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: { ...bearer(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
        metrics: [{ name: "activeUsers" }, { name: "sessions" }],
      }),
    },
    { kind: "report" },
  );
  const values = result.rows?.[0]?.metricValues ?? [];
  return {
    activeUsers: Number(values[0]?.value ?? 0),
    sessions: Number(values[1]?.value ?? 0),
  };
}

// Sum of clicks/impressions/ctr/position for the last `days` days —
// dimensionless, single-row aggregate query. Search Console returns all
// four metrics in the same call, no extra request needed.
export async function fetchSearchConsoleReport(
  accessToken: string,
  siteUrl: string,
  days = 7,
): Promise<{
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}> {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  const format = (d: Date) => d.toISOString().slice(0, 10);

  const result = await googleFetchJson<{
    rows?: Array<{
      clicks?: number;
      impressions?: number;
      ctr?: number;
      position?: number;
    }>;
  }>(
    `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { ...bearer(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: format(start),
        endDate: format(today),
        rowLimit: 1,
      }),
    },
    { kind: "report" },
  );
  const row = result.rows?.[0];
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: row?.ctr ?? 0,
    position: row?.position ?? 0,
  };
}

export type SearchConsoleQueryRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

// Row-level Search Console data, broken out by dimension (e.g. "query") —
// unlike fetchSearchConsoleReport's dimensionless single-row aggregate above,
// this is what a content-opportunity rule needs to point at a specific query
// or page. Separate function rather than an overload so the simple aggregate
// call (used by the "Test connection" button and ANALYTICS_ANALYSIS) keeps
// its exact existing shape and behavior untouched.
export async function fetchSearchConsoleQueryRows(
  accessToken: string,
  siteUrl: string,
  dimensions: Array<"query" | "page">,
  days = 28,
  rowLimit = 25,
): Promise<SearchConsoleQueryRow[]> {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  const format = (d: Date) => d.toISOString().slice(0, 10);

  const result = await googleFetchJson<{
    rows?: Array<{
      keys?: string[];
      clicks?: number;
      impressions?: number;
      ctr?: number;
      position?: number;
    }>;
  }>(
    `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { ...bearer(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: format(start),
        endDate: format(today),
        dimensions,
        rowLimit,
      }),
    },
    { kind: "report" },
  );
  return (result.rows ?? []).map((row) => ({
    keys: row.keys ?? [],
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

// List fetches never throw — if the API isn't enabled in the GCP project
// (or access is missing), the error message goes into the *ListError field
// and the connection is still established. Used by both the OAuth callback
// (initial connection) and refreshGoogleListsAction (manual refresh).
export async function fetchGa4PropertyList(
  accessToken: string,
): Promise<Pick<GoogleAnalyticsMetadata, "ga4Properties" | "ga4ListError">> {
  try {
    return { ga4Properties: await listGa4Properties(accessToken) };
  } catch (error) {
    return {
      ga4Properties: [],
      ga4ListError:
        error instanceof Error
          ? error.message
          : "Could not fetch the GA4 property list",
    };
  }
}

export async function fetchSearchConsoleSiteList(
  accessToken: string,
): Promise<
  Pick<GoogleSearchConsoleMetadata, "searchConsoleSites" | "gscListError">
> {
  try {
    return { searchConsoleSites: await listSearchConsoleSites(accessToken) };
  } catch (error) {
    return {
      searchConsoleSites: [],
      gscListError:
        error instanceof Error
          ? error.message
          : "Could not fetch the Search Console site list",
    };
  }
}

// When a fresh list is fetched, the previous selection is kept if it's
// still in the list, otherwise (the property/site was deleted or access
// was revoked) it's cleared — so the user never sees a property as
// "selected" that they no longer have access to.
export function reconcileGa4Selection(
  existing: Partial<GoogleAnalyticsMetadata>,
  fresh: Pick<GoogleAnalyticsMetadata, "ga4Properties">,
): Pick<
  GoogleAnalyticsMetadata,
  "selectedGa4PropertyId" | "selectedGa4PropertyName"
> {
  const keep =
    existing.selectedGa4PropertyId &&
    fresh.ga4Properties.some(
      (p) => p.propertyId === existing.selectedGa4PropertyId,
    );
  return {
    selectedGa4PropertyId: keep ? existing.selectedGa4PropertyId : undefined,
    selectedGa4PropertyName: keep
      ? existing.selectedGa4PropertyName
      : undefined,
  };
}

export function reconcileSearchConsoleSelection(
  existing: Partial<GoogleSearchConsoleMetadata>,
  fresh: Pick<GoogleSearchConsoleMetadata, "searchConsoleSites">,
): Pick<GoogleSearchConsoleMetadata, "selectedSearchConsoleSite"> {
  const keep =
    existing.selectedSearchConsoleSite &&
    fresh.searchConsoleSites.some(
      (s) => s.siteUrl === existing.selectedSearchConsoleSite,
    );
  return {
    selectedSearchConsoleSite: keep
      ? existing.selectedSearchConsoleSite
      : undefined,
  };
}
