import "server-only";

// A thin, real Google REST API wrapper — no SDK, plain `fetch` (same
// pattern as telegram-client.ts). The OAuth authorization-code flow + the
// minimum surface of the GA4 (Analytics Admin/Data API) + Search Console
// API needed for these integrations.

import { getEnv } from "@/lib/env";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const ANALYTICS_ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const ANALYTICS_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const SEARCH_CONSOLE_BASE =
  "https://searchconsole.googleapis.com/webmasters/v3";

const DEFAULT_TIMEOUT_MS = 8_000;

// Google Analytics and Search Console are two independent integrations:
// each has its own OAuth grant (only its own scope), its own refresh token
// and its own IntegrationCredential row — so they can be connected from
// different Google accounts and disconnected separately. Both share the
// same GCP OAuth client and the same registered redirect URI; the service
// travels in the signed OAuth state.
export const GOOGLE_SERVICES = ["analytics", "search_console"] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

export const GOOGLE_PROVIDER = {
  analytics: "google_analytics",
  search_console: "google_search_console",
} as const satisfies Record<GoogleService, string>;

export const GOOGLE_SERVICE_LABEL: Record<GoogleService, string> = {
  analytics: "Google Analytics",
  search_console: "Google Search Console",
};

const SCOPES: Record<GoogleService, string[]> = {
  analytics: [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  search_console: [
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
};

export function parseGoogleService(value: unknown): GoogleService | null {
  return GOOGLE_SERVICES.includes(value as GoogleService)
    ? (value as GoogleService)
    : null;
}

// Bookkeeping for GoogleAnalyticsScanner's due-scan check (see
// google-analytics-scanner.ts) — same pattern as Meta's
// lastAdsPerformanceScanAt/adsPerformanceScanFailureCount in
// meta-client.ts's MetaAdsMetadata.
type GoogleScanBookkeeping = {
  lastAnalyticsScanAt?: string;
  analyticsScanFailureCount?: number;
};

// IntegrationCredential.metadata for provider "google_analytics".
export type GoogleAnalyticsMetadata = GoogleScanBookkeeping & {
  connectedEmail?: string;
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
export type GoogleSearchConsoleMetadata = GoogleScanBookkeeping & {
  connectedEmail?: string;
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

export class GoogleApiError extends Error {
  readonly googleErrorCode?: string;
  constructor(message: string, googleErrorCode?: string) {
    super(message);
    this.name = "GoogleApiError";
    this.googleErrorCode = googleErrorCode;
  }
}

// There is no separate GOOGLE_OAUTH_REDIRECT_URI env var — it's derived
// from the existing NEXT_PUBLIC_APP_URL, and this path must be registered
// as the authorized redirect URI in Google Cloud Console.
function redirectUri(): string {
  return `${getEnv().NEXT_PUBLIC_APP_URL}/api/integrations/google/callback`;
}

async function request<T>(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new GoogleApiError(
      isAbort
        ? `Google API request timed out (${timeoutMs}ms)`
        : `Could not reach Google API: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Empty body (e.g. some 204s) — not a problem, res.ok is checked below.
  }

  if (!res.ok) {
    const errorBody = body as {
      error?: string | { message?: string };
      error_description?: string;
    } | null;
    const code =
      typeof errorBody?.error === "string" ? errorBody.error : undefined;
    const message =
      typeof errorBody?.error === "object" && errorBody?.error?.message
        ? errorBody.error.message
        : (errorBody?.error_description ??
          `Google API error (HTTP ${res.status})`);
    throw new GoogleApiError(message, code);
  }

  return body as T;
}

export function buildGoogleAuthorizeUrl(
  state: string,
  service: GoogleService,
): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    // No include_granted_scopes: each service's token must carry only its
    // own scope, otherwise the two integrations would silently merge again.
    scope: SCOPES[service].join(" "),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeGoogleAuthCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}> {
  const env = getEnv();
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const result = await request<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }>(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    // expires_in eksik gelirse NaN tarih -> RangeError zinciri oluşmasın
    // (meta-client'ta yaşandı); Google'ın standart 1 saatini varsay.
    expiresIn: result.expires_in ?? 3600,
  };
}

// invalid_grant -> the refresh token has been revoked/is invalid; the
// caller should turn this into marking the credential EXPIRED and
// requesting a reconnect (see testGoogleConnectionAction).
export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const env = getEnv();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const result = await request<{ access_token: string; expires_in?: number }>(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in ?? 3600,
  };
}

export async function fetchGoogleAccountEmail(
  accessToken: string,
): Promise<string | null> {
  try {
    const result = await request<{ email?: string }>(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return result.email ?? null;
  } catch {
    return null;
  }
}

export type Ga4Property = {
  propertyId: string;
  propertyName: string;
  accountName: string;
};

export async function listGa4Properties(
  accessToken: string,
): Promise<Ga4Property[]> {
  const result = await request<{
    accountSummaries?: Array<{
      displayName?: string;
      propertySummaries?: Array<{ property?: string; displayName?: string }>;
    }>;
  }>(`${ANALYTICS_ADMIN_BASE}/accountSummaries?pageSize=200`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const properties: Ga4Property[] = [];
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
  return properties;
}

export type SearchConsoleSite = {
  siteUrl: string;
  permissionLevel: string;
};

export async function listSearchConsoleSites(
  accessToken: string,
): Promise<SearchConsoleSite[]> {
  const result = await request<{
    siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
  }>(`${SEARCH_CONSOLE_BASE}/sites`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

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
  const result = await request<{
    rows?: Array<{ metricValues?: Array<{ value?: string }> }>;
  }>(`${ANALYTICS_DATA_BASE}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
    }),
  });
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

  const result = await request<{
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
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: format(start),
        endDate: format(today),
        rowLimit: 1,
      }),
    },
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

  const result = await request<{
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
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: format(start),
        endDate: format(today),
        dimensions,
        rowLimit,
      }),
    },
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
