import "server-only";

// İnce, gerçek Meta Graph API + Marketing API sarmalayıcısı — SDK yok, düz
// `fetch` (google-client.ts ile aynı desen). OAuth authorization-code akışı +
// Instagram Content Publishing + Marketing API'nin bu entegrasyon için
// gereken minimum yüzeyi.

import { getEnv } from "@/lib/env";

const GRAPH_API_VERSION = "v26.0";
const AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
  "ads_management",
  "ads_read",
  "business_management",
];

const DEFAULT_TIMEOUT_MS = 8_000;

// IntegrationCredential.metadata (provider: "meta") şekli — callback route
// bağlantı kurarken yazar, meta-actions.ts seçim/test sonuçlarını günceller,
// entegrasyonlar sayfası ve MetaApiProvider doğrudan okur.
//
// NOT: Page Access Token'ı burada BİLEREK saklamıyoruz — o da user token
// kadar hassas bir secret ve metadata şifrelenmemiş bir JSON alanı.
// Yayınlama/kampanya işlemleri sırasında `fetchPageAccessToken` ile
// `encryptedSecret`teki long-lived user token'dan anlık türetiliyor.
export type MetaPage = {
  pageId: string;
  pageName: string;
  instagramBusinessAccountId?: string;
  instagramUsername?: string;
};

export type MetaAdAccount = {
  adAccountId: string;
  adAccountName: string;
  currency: string;
};

export type MetaCredentialMetadata = {
  connectedName?: string;
  longLivedTokenExpiresAt?: string;
  pages: MetaPage[];
  pagesListError?: string;
  adAccounts: MetaAdAccount[];
  adAccountsListError?: string;
  selectedPageId?: string;
  selectedPageName?: string;
  selectedAdAccountId?: string;
  selectedAdAccountName?: string;
  lastTestResult?: {
    testedAt: string;
    adAccountSpend?: number;
    igUsername?: string;
    error?: string;
  };
};

export class MetaApiError extends Error {
  readonly metaErrorCode?: number;
  readonly metaErrorSubcode?: number;
  constructor(
    message: string,
    metaErrorCode?: number,
    metaErrorSubcode?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
    this.metaErrorCode = metaErrorCode;
    this.metaErrorSubcode = metaErrorSubcode;
  }
}

// Ayrı bir META_OAUTH_REDIRECT_URI env var'ı yok — mevcut
// NEXT_PUBLIC_APP_URL'den türetiliyor, Meta App Dashboard'da bu path
// "Valid OAuth Redirect URI" olarak kayıtlı olmalı.
function redirectUri(): string {
  return `${getEnv().NEXT_PUBLIC_APP_URL}/api/integrations/meta/callback`;
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
    throw new MetaApiError(
      isAbort
        ? `Meta API isteği zaman aşımına uğradı (${timeoutMs}ms)`
        : `Meta API'ye ulaşılamadı: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // boş gövde — sorun değil, aşağıda res.ok kontrolü var.
  }

  if (!res.ok) {
    const errorBody = body as {
      error?: { message?: string; code?: number; error_subcode?: number };
    } | null;
    const message =
      errorBody?.error?.message ?? `Meta API hatası (HTTP ${res.status})`;
    throw new MetaApiError(
      message,
      errorBody?.error?.code,
      errorBody?.error?.error_subcode,
    );
  }

  return body as T;
}

export function buildMetaAuthorizeUrl(state: string): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeMetaAuthCode(
  code: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: redirectUri(),
    code,
  });
  const result = await request<{ access_token: string; expires_in: number }>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
  );
  return { accessToken: result.access_token, expiresIn: result.expires_in };
}

// Kısa ömürlü (1-2 saat) user access token'ı ~60 günlük long-lived token'a
// çevirir. Meta'da Google'daki gibi ayrı bir refresh token yok — bu token
// süresi dolmadan önce yeniden değiştirilmesi gerekiyor (bkz. plan notu:
// otomatik yenileme sonraki iterasyona bırakıldı).
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const env = getEnv();
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });
  const result = await request<{ access_token: string; expires_in: number }>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
  );
  return { accessToken: result.access_token, expiresIn: result.expires_in };
}

export async function fetchMetaAccountName(
  accessToken: string,
): Promise<string | null> {
  try {
    const result = await request<{ name?: string }>(
      `${GRAPH_BASE}/me?fields=name&access_token=${encodeURIComponent(accessToken)}`,
    );
    return result.name ?? null;
  } catch {
    return null;
  }
}

export async function listManagedPages(
  accessToken: string,
): Promise<MetaPage[]> {
  const result = await request<{
    data?: Array<{
      id: string;
      name: string;
      instagram_business_account?: { id: string; username?: string };
    }>;
  }>(
    `${GRAPH_BASE}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(accessToken)}`,
  );

  return (result.data ?? []).map((page) => ({
    pageId: page.id,
    pageName: page.name,
    instagramBusinessAccountId: page.instagram_business_account?.id,
    instagramUsername: page.instagram_business_account?.username,
  }));
}

// Page Access Token'ı kalıcı olarak hiçbir yerde saklamıyoruz (bkz.
// MetaPage yorumu) — yayınlama/kampanya işleminden hemen önce, o anki
// long-lived user token'dan anlık türetilir.
export async function fetchPageAccessToken(
  pageId: string,
  userAccessToken: string,
): Promise<string> {
  const result = await request<{ access_token: string }>(
    `${GRAPH_BASE}/${pageId}?fields=access_token&access_token=${encodeURIComponent(userAccessToken)}`,
  );
  return result.access_token;
}

export async function listAdAccounts(
  accessToken: string,
): Promise<MetaAdAccount[]> {
  const result = await request<{
    data?: Array<{ id: string; name?: string; currency?: string }>;
  }>(
    `${GRAPH_BASE}/me/adaccounts?fields=id,name,currency&access_token=${encodeURIComponent(accessToken)}`,
  );

  return (result.data ?? []).map((account) => ({
    adAccountId: account.id,
    adAccountName: account.name ?? account.id,
    currency: account.currency ?? "USD",
  }));
}

// Yayınlama/kampanya yapmadan bağlantının gerçekten çalıştığını kanıtlayan
// tek seferlik test çağrısı (google-client.ts'teki runGa4TestReport ile aynı
// amaç) — Page token'ın hâlâ geçerli olduğunu ve IG hesabına eriştiğini
// doğrular.
export async function verifyInstagramAccess(
  instagramBusinessAccountId: string,
  pageAccessToken: string,
): Promise<string> {
  const result = await request<{ username?: string }>(
    `${GRAPH_BASE}/${instagramBusinessAccountId}?fields=username&access_token=${encodeURIComponent(pageAccessToken)}`,
  );
  return result.username ?? instagramBusinessAccountId;
}

const CONTAINER_POLL_INTERVAL_MS = 2_000;
const CONTAINER_POLL_MAX_ATTEMPTS = 15; // ~30sn — tek görsel için fazlasıyla yeterli.

// Medya konteyneri oluşturulduktan sonra Instagram, verilen image_url'i
// arka planda indirip işliyor — status_code IN_PROGRESS'ten FINISHED'a
// geçmeden media_publish çağrılırsa "media ID does not exist" gibi bir
// hatayla düşer. Bu yüzden publish'ten önce FINISHED'ı bekliyoruz.
async function waitForContainerReady(
  creationId: string,
  accessToken: string,
): Promise<void> {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const status = await request<{ status_code?: string }>(
      `${GRAPH_BASE}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new MetaApiError(
        `Instagram medya konteyneri işlenemedi (status_code: ${status.status_code})`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS),
    );
  }
  throw new MetaApiError(
    "Instagram medya konteyneri zaman aşımına uğradı (status_code hiç FINISHED olmadı)",
  );
}

// İki adımlı Instagram Content Publishing akışı: önce medya konteyneri
// oluşturulur, işlenmesi beklenir, sonra yayınlanır. imageUrl herkese açık
// olarak erişilebilir olmalı (R2/asset storage URL'i — bkz. src/server/media).
// mediaType "STORIES" ise Story olarak yayınlanır — Story'lerin caption alanı
// YOK (Meta API kısıtı, metin görselin içine önceden gömülü olmalı), bu
// yüzden caption yalnızca normal gönderi (FEED) modunda gönderiliyor.
export async function publishInstagramPost(input: {
  instagramBusinessAccountId: string;
  pageAccessToken: string;
  imageUrl: string;
  caption: string;
  mediaType?: "STORIES";
}): Promise<{ postId: string }> {
  const body: Record<string, string> = {
    image_url: input.imageUrl,
    access_token: input.pageAccessToken,
  };
  if (input.mediaType === "STORIES") {
    body.media_type = "STORIES";
  } else {
    body.caption = input.caption;
  }

  const creation = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.instagramBusinessAccountId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    },
  );

  await waitForContainerReady(creation.id, input.pageAccessToken);

  const published = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.instagramBusinessAccountId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        creation_id: creation.id,
        access_token: input.pageAccessToken,
      }).toString(),
    },
  );

  return { postId: published.id };
}

export type MetaAdsInsights = {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
};

// `date_preset` Marketing API'nin standart aralıklarından biri — analiz
// göreviyle aynı payload şekliyle çağrılır (bkz. meta-api-provider.ts).
export async function fetchMetaAdsInsights(input: {
  adAccountId: string;
  accessToken: string;
  datePreset?: string;
}): Promise<MetaAdsInsights> {
  const params = new URLSearchParams({
    fields: "spend,impressions,clicks,ctr,cpm",
    date_preset: input.datePreset ?? "last_7d",
    access_token: input.accessToken,
  });
  const result = await request<{
    data?: Array<{
      spend?: string;
      impressions?: string;
      clicks?: string;
      ctr?: string;
      cpm?: string;
    }>;
  }>(`${GRAPH_BASE}/${input.adAccountId}/insights?${params.toString()}`);

  const row = result.data?.[0];
  return {
    spend: Number(row?.spend ?? 0),
    impressions: Number(row?.impressions ?? 0),
    clicks: Number(row?.clicks ?? 0),
    ctr: Number(row?.ctr ?? 0),
    cpm: Number(row?.cpm ?? 0),
  };
}

// Minimal zorunlu alan seti — tam bir kampanya sihirbazı değil, AI'ın taslak
// bir kampanya oluşturması senaryosuna yetecek yüzey. `special_ad_categories`
// boş dizi olarak gönderilmesi Marketing API'de zorunlu.
export async function createMetaCampaign(input: {
  adAccountId: string;
  accessToken: string;
  name: string;
  objective: string;
  status: "ACTIVE" | "PAUSED";
  dailyBudgetCents?: number;
}): Promise<{ campaignId: string }> {
  const body = new URLSearchParams({
    name: input.name,
    objective: input.objective,
    status: input.status,
    special_ad_categories: JSON.stringify([]),
    access_token: input.accessToken,
  });
  if (input.dailyBudgetCents !== undefined) {
    body.set("daily_budget", String(input.dailyBudgetCents));
  }

  const result = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/campaigns`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return { campaignId: result.id };
}

export async function updateMetaCampaign(input: {
  campaignId: string;
  accessToken: string;
  status?: "ACTIVE" | "PAUSED";
  dailyBudgetCents?: number;
}): Promise<void> {
  const body = new URLSearchParams({ access_token: input.accessToken });
  if (input.status) body.set("status", input.status);
  if (input.dailyBudgetCents !== undefined) {
    body.set("daily_budget", String(input.dailyBudgetCents));
  }

  await request<{ success: boolean }>(`${GRAPH_BASE}/${input.campaignId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
