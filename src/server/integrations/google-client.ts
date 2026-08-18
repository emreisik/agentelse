import "server-only";

// İnce, gerçek Google REST API sarmalayıcısı — SDK yok, düz `fetch`
// (telegram-client.ts ile aynı desen). OAuth authorization-code akışı +
// GA4 (Analytics Admin/Data API) + Search Console API'nin bu entegrasyon
// için gereken minimum yüzeyi.

import { getEnv } from "@/lib/env";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const ANALYTICS_ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const ANALYTICS_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const SEARCH_CONSOLE_BASE =
  "https://searchconsole.googleapis.com/webmasters/v3";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

const DEFAULT_TIMEOUT_MS = 8_000;

// IntegrationCredential.metadata (provider: "google") şekli — callback
// route bağlantı kurarken yazar, google-actions.ts seçim/test sonuçlarını
// günceller, entegrasyonlar sayfası doğrudan okur.
export type GoogleCredentialMetadata = {
  connectedEmail?: string;
  ga4Properties: Ga4Property[];
  ga4ListError?: string;
  searchConsoleSites: SearchConsoleSite[];
  gscListError?: string;
  selectedGa4PropertyId?: string;
  selectedGa4PropertyName?: string;
  selectedSearchConsoleSite?: string;
  lastTestResult?: {
    testedAt: string;
    ga4ActiveUsers?: number;
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

// Ayrı bir GOOGLE_OAUTH_REDIRECT_URI env var'ı yok — mevcut
// NEXT_PUBLIC_APP_URL'den türetiliyor, Google Cloud Console'da bu path
// authorized redirect URI olarak kayıtlı olmalı.
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
        ? `Google API isteği zaman aşımına uğradı (${timeoutMs}ms)`
        : `Google API'ye ulaşılamadı: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // boş gövde (örn. bazı 204'ler) — sorun değil, aşağıda res.ok kontrolü var.
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
          `Google API hatası (HTTP ${res.status})`);
    throw new GoogleApiError(message, code);
  }

  return body as T;
}

export function buildGoogleAuthorizeUrl(state: string): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: SCOPES.join(" "),
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
    expires_in: number;
  }>(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresIn: result.expires_in,
  };
}

// invalid_grant → refresh token iptal edilmiş/geçersiz olmuş, çağıran taraf
// bunu kimlik bilgisini EXPIRED işaretleyip yeniden bağlanma isteğine
// çevirmeli (bkz. testGoogleConnectionAction).
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
  const result = await request<{ access_token: string; expires_in: number }>(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return { accessToken: result.access_token, expiresIn: result.expires_in };
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
    // Doğrulanmamış site'lara karşı searchAnalytics çağrıları 403 döner —
    // seçim listesine hiç koymuyoruz.
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

// Son `days` günün activeUsers/sessions toplamı — hem "Test Et" butonu
// (days=7 varsayılan) hem ANALYTICS_ANALYSIS görevini yürüten
// GoogleApiProvider (days=28) bunu kullanır.
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

// Son `days` günün clicks/impressions/ctr/position toplamı — boyutsuz, tek
// satırlık agregat sorgu. Search Console bu dört metriği aynı çağrıda
// döndürüyor, ekstra istek gerekmiyor.
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

export type GoogleLists = {
  ga4Properties: Ga4Property[];
  ga4ListError?: string;
  searchConsoleSites: SearchConsoleSite[];
  gscListError?: string;
};

// GA4 property + Search Console site listelerini paralel çeker; biri
// başarısız olsa da (örn. o API bu GCP projesinde etkin değil) diğeri
// etkilenmez — hata mesajı ilgili *ListError alanına yazılır. Hem OAuth
// callback'i (ilk bağlantı) hem refreshGoogleListsAction (manuel yenileme)
// bu fonksiyonu kullanır.
export async function fetchGoogleLists(
  accessToken: string,
): Promise<GoogleLists> {
  const [ga4, gsc] = await Promise.all([
    listGa4Properties(accessToken).then(
      (items) => ({ items, error: undefined as string | undefined }),
      (error) => ({
        items: [] as Ga4Property[],
        error:
          error instanceof Error
            ? error.message
            : "GA4 property listesi alınamadı",
      }),
    ),
    listSearchConsoleSites(accessToken).then(
      (items) => ({ items, error: undefined as string | undefined }),
      (error) => ({
        items: [] as SearchConsoleSite[],
        error:
          error instanceof Error
            ? error.message
            : "Search Console site listesi alınamadı",
      }),
    ),
  ]);
  return {
    ga4Properties: ga4.items,
    ga4ListError: ga4.error,
    searchConsoleSites: gsc.items,
    gscListError: gsc.error,
  };
}

// Yeni liste çekildiğinde önceki seçim hâlâ listede varsa korunur, yoksa
// (property/site silinmiş veya erişim kaldırılmışsa) temizlenir — kullanıcı
// artık erişemediği bir property'yi "seçili" gibi görmesin diye.
export function reconcileGoogleSelection(
  existing: GoogleCredentialMetadata,
  fresh: GoogleLists,
): Pick<
  GoogleCredentialMetadata,
  | "selectedGa4PropertyId"
  | "selectedGa4PropertyName"
  | "selectedSearchConsoleSite"
> {
  const keepGa4 =
    existing.selectedGa4PropertyId &&
    fresh.ga4Properties.some(
      (p) => p.propertyId === existing.selectedGa4PropertyId,
    );
  const keepGsc =
    existing.selectedSearchConsoleSite &&
    fresh.searchConsoleSites.some(
      (s) => s.siteUrl === existing.selectedSearchConsoleSite,
    );
  return {
    selectedGa4PropertyId: keepGa4 ? existing.selectedGa4PropertyId : undefined,
    selectedGa4PropertyName: keepGa4
      ? existing.selectedGa4PropertyName
      : undefined,
    selectedSearchConsoleSite: keepGsc
      ? existing.selectedSearchConsoleSite
      : undefined,
  };
}
