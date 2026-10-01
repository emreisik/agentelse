import "server-only";

// A thin, real Meta Graph API + Marketing API wrapper — no SDK, plain
// `fetch` (same pattern as google-client.ts). The OAuth authorization-code
// flow + the minimum surface of Instagram Content Publishing + Marketing
// API needed for this integration.

import { getEnv } from "@/lib/env";

const GRAPH_API_VERSION = "v26.0";
const AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// "Instagram API with Instagram Login": the same Instagram Content Publishing,
// but the grant is made on Instagram's own consent screen and the token is the
// Instagram account's own, so there is no Facebook account, no Page and no
// Page access token. Different hosts, different scopes, and its own app ID and
// secret (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET, see env.ts).
const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_GRAPH_BASE = `https://graph.instagram.com/${GRAPH_API_VERSION}`;
const INSTAGRAM_GRAPH_ROOT = "https://graph.instagram.com";
const INSTAGRAM_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
];

// Which Graph host an Instagram call goes to: the Facebook one (Page token) or
// Instagram's own (Instagram Login token).
export type InstagramApi = "facebook" | "instagram";
function graphBaseFor(api: InstagramApi): string {
  return api === "instagram" ? INSTAGRAM_GRAPH_BASE : GRAPH_BASE;
}

const DEFAULT_TIMEOUT_MS = 8_000;

// Instagram and Meta Ads are two independent integrations: each has its own
// OAuth grant (only the scopes that service needs), its own long-lived token
// and its own IntegrationCredential row — so they can be connected from
// different Facebook accounts and disconnected separately. Both share the
// same Meta app and the same registered redirect URI; the service travels
// in the signed OAuth state.
export const META_SERVICES = ["instagram", "ads"] as const;
export type MetaService = (typeof META_SERVICES)[number];

export const META_PROVIDER = {
  instagram: "instagram",
  ads: "meta_ads",
} as const satisfies Record<MetaService, string>;

export const META_SERVICE_LABEL: Record<MetaService, string> = {
  instagram: "Instagram",
  ads: "Meta Ads",
};

// business_management is on both: Pages owned by a Business Portfolio only
// show up in /me/accounts with it, and Instagram accounts are usually linked
// through those Pages.
const SCOPES: Record<MetaService, string[]> = {
  instagram: [
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_content_publish",
    "business_management",
  ],
  ads: [
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "ads_management",
    "ads_read",
    "business_management",
  ],
};

export function parseMetaService(value: unknown): MetaService | null {
  return META_SERVICES.includes(value as MetaService)
    ? (value as MetaService)
    : null;
}

// The shapes of IntegrationCredential.metadata for provider "instagram" and
// "meta_ads" — the callback route writes them when establishing the
// connection, meta-actions.ts updates selection/test results, and the
// integrations page and MetaApiProvider read them directly.
//
// NOTE: We DELIBERATELY do not store the Page Access Token here — it's just
// as sensitive a secret as the user token, and metadata is an unencrypted
// JSON field. It's derived on the fly from the long-lived user token in
// `encryptedSecret` via `fetchPageAccessToken` right before a
// publish/campaign operation.
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

type MetaConnectionInfo = {
  connectedName?: string;
  longLivedTokenExpiresAt?: string;
};

// provider "instagram": `pages` only lists Pages that have a linked
// Instagram Business account — that is what publishing needs.
//
// Two routes land in the same row. Facebook Login (`login` absent): `pages`
// lists the Pages that have a linked Instagram account, one is selected, and
// the token is a Facebook user token a Page token is derived from. Instagram
// Login (`login: "instagram"`): there is no Page, `pages` stays empty, the
// account is `instagramAccount`, and the token is the account's own.
export type MetaInstagramMetadata = MetaConnectionInfo & {
  login?: "instagram";
  instagramAccount?: {
    id: string;
    username?: string;
    // BUSINESS or MEDIA_CREATOR as Instagram reports it.
    accountType?: string;
  };
  pages: MetaPage[];
  pagesListError?: string;
  selectedPageId?: string;
  selectedPageName?: string;
  lastTestResult?: {
    testedAt: string;
    igUsername?: string;
    error?: string;
  };
};

// provider "meta_ads": `pages` is every managed Page — the selected one is
// the identity ads run as (AdCreative object_story_spec), and it does not
// need a linked Instagram account.
export type MetaAdsMetadata = MetaConnectionInfo & {
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
    error?: string;
  };
  // Bookkeeping for MetaPerformanceScanner's due-scan check (see
  // meta-performance-scanner.ts) — same "unstructured JSON, no migration"
  // pattern as lastTestResult above. adsPerformanceScanFailureCount backs an
  // exponential backoff on repeated scan failures (bad token, rate limit).
  lastAdsPerformanceScanAt?: string;
  adsPerformanceScanFailureCount?: number;
  // A one-deep snapshot of the LAST scan's per-entity metrics — not a full
  // time series, just enough to power "CPA doubled since last scan"-style
  // trend rules (see meta-performance-rules.ts's evaluateTrendFinding).
  // Keyed "meta-campaign:<id>" / "meta-adset:<id>". A real trend store
  // (weekly charts, long-run regression) is deliberately out of scope.
  previousScanSnapshot?: Record<
    string,
    // resultLabel: written only with Works on (what costPerResult counts).
    { spend: number; costPerResult?: number; ctr: number; resultLabel?: string }
  >;
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

// There is no separate META_OAUTH_REDIRECT_URI env var — it's derived from
// the existing NEXT_PUBLIC_APP_URL, and this path must be registered as
// the "Valid OAuth Redirect URI" in the Meta App Dashboard.
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
        ? `Meta API request timed out (${timeoutMs}ms)`
        : `Could not reach Meta API: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Empty body — not a problem, res.ok is checked below.
  }

  if (!res.ok) {
    const errorBody = body as {
      error?: { message?: string; code?: number; error_subcode?: number };
      // The Instagram Login token endpoint answers in this flatter shape.
      error_message?: string;
      code?: number;
    } | null;
    const message =
      errorBody?.error?.message ??
      errorBody?.error_message ??
      `Meta API error (HTTP ${res.status})`;
    throw new MetaApiError(
      message,
      errorBody?.error?.code ?? errorBody?.code,
      errorBody?.error?.error_subcode,
    );
  }

  return body as T;
}

export function buildMetaAuthorizeUrl(
  state: string,
  service: MetaService,
): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES[service].join(","),
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
  const result = await request<{ access_token: string; expires_in?: number }>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
  );
  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in ?? 3600,
  };
}

// Converts a short-lived (1-2 hour) user access token into a ~60-day
// long-lived token. Meta doesn't have a separate refresh token like
// Google does — this token needs to be exchanged again before it expires
// (see plan note: automatic renewal was left for a later iteration).
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
  // Meta bu yanıtta expires_in alanını her zaman GÖNDERMEZ (bazı token
  // türleri süresiz döner) — undefined * 1000 = NaN, new Date(NaN)
  // .toISOString() ise RangeError fırlatıp callback'i 500'e düşürüyordu.
  // Alan yoksa dokümante edilen ~60 günlük ömrü varsayıyoruz.
  const result = await request<{ access_token: string; expires_in?: number }>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
  );
  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in ?? 60 * 24 * 60 * 60,
  };
}

export function buildInstagramLoginAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getEnv().INSTAGRAM_APP_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: INSTAGRAM_LOGIN_SCOPES.join(","),
    state,
  });
  return `${INSTAGRAM_AUTHORIZE_URL}?${params.toString()}`;
}

// Instagram's token endpoint takes a form POST and answers either with the
// flat `{access_token, user_id}` or, since the 2024 launch, with the same inside
// a `data` array — both are read.
export async function exchangeInstagramAuthCode(
  code: string,
): Promise<{ accessToken: string; userId?: string }> {
  const env = getEnv();
  const result = await request<{
    access_token?: string;
    user_id?: number | string;
    data?: Array<{ access_token?: string; user_id?: number | string }>;
  }>(INSTAGRAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(),
      // Instagram sometimes hands the code back with a trailing "#_".
      code: code.replace(/#_$/, ""),
    }).toString(),
  });
  const entry = result.data?.[0] ?? result;
  if (!entry.access_token) {
    throw new MetaApiError("Instagram did not return an access token");
  }
  return {
    accessToken: entry.access_token,
    userId: entry.user_id !== undefined ? String(entry.user_id) : undefined,
  };
}

// Short-lived (1 hour) -> long-lived (60 days) Instagram token.
export async function exchangeInstagramLongLivedToken(
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: getEnv().INSTAGRAM_APP_SECRET,
    access_token: shortLivedToken,
  });
  const result = await request<{ access_token: string; expires_in?: number }>(
    `${INSTAGRAM_GRAPH_ROOT}/access_token?${params.toString()}`,
  );
  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in ?? 60 * 24 * 60 * 60,
  };
}

// The account the token belongs to. `user_id` is the Instagram professional
// account id every publishing call is addressed to (`id` is an app-scoped id).
export async function fetchInstagramLoginProfile(
  accessToken: string,
): Promise<{ id: string; username?: string; accountType?: string }> {
  const result = await request<{
    id?: string;
    user_id?: string | number;
    username?: string;
    account_type?: string;
  }>(
    `${INSTAGRAM_GRAPH_BASE}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(accessToken)}`,
  );
  const id = result.user_id ?? result.id;
  if (id === undefined) {
    throw new MetaApiError("Instagram did not return the account id");
  }
  return {
    id: String(id),
    username: result.username,
    accountType: result.account_type,
  };
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

// We never persist the Page Access Token anywhere (see the MetaPage
// comment) — it's derived on the fly from the current long-lived user
// token right before a publish/campaign operation.
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

// List fetches never throw — if a permission wasn't granted for a Page/ad
// account, the error message goes into the *ListError field and the
// connection is still established. Used by the OAuth callback.
async function safeList<T>(
  promise: Promise<T[]>,
  fallbackMessage: string,
): Promise<{ items: T[]; error?: string }> {
  try {
    return { items: await promise };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : fallbackMessage,
    };
  }
}

// `onlyWithInstagram` is what the Instagram integration wants: publishing
// needs a Page with a linked Instagram Business account, so other Pages
// would just be selectable dead ends.
export async function fetchMetaPageList(
  accessToken: string,
  options: { onlyWithInstagram: boolean },
): Promise<Pick<MetaAdsMetadata, "pages" | "pagesListError">> {
  const result = await safeList(
    listManagedPages(accessToken),
    "Failed to fetch Page list",
  );
  const pages = options.onlyWithInstagram
    ? result.items.filter((p) => p.instagramBusinessAccountId)
    : result.items;
  return {
    pages,
    pagesListError:
      result.error ??
      (options.onlyWithInstagram && pages.length === 0
        ? "No Page with a linked Instagram Business account found"
        : undefined),
  };
}

export async function fetchMetaAdAccountList(
  accessToken: string,
): Promise<Pick<MetaAdsMetadata, "adAccounts" | "adAccountsListError">> {
  const result = await safeList(
    listAdAccounts(accessToken),
    "Failed to fetch ad account list",
  );
  return { adAccounts: result.items, adAccountsListError: result.error };
}

// When a fresh list is fetched (reconnect), the previous selection is kept
// if it's still in the list, otherwise it's cleared — so the user never sees
// a Page/ad account as "selected" that they no longer have access to.
export function reconcilePageSelection(
  existing: { selectedPageId?: string; selectedPageName?: string },
  pages: MetaPage[],
): { selectedPageId?: string; selectedPageName?: string } {
  const keep =
    existing.selectedPageId &&
    pages.some((p) => p.pageId === existing.selectedPageId);
  return {
    selectedPageId: keep ? existing.selectedPageId : undefined,
    selectedPageName: keep ? existing.selectedPageName : undefined,
  };
}

export function reconcileAdAccountSelection(
  existing: { selectedAdAccountId?: string; selectedAdAccountName?: string },
  adAccounts: MetaAdAccount[],
): { selectedAdAccountId?: string; selectedAdAccountName?: string } {
  const keep =
    existing.selectedAdAccountId &&
    adAccounts.some((a) => a.adAccountId === existing.selectedAdAccountId);
  return {
    selectedAdAccountId: keep ? existing.selectedAdAccountId : undefined,
    selectedAdAccountName: keep ? existing.selectedAdAccountName : undefined,
  };
}

// A one-off test call that proves the connection actually works, without
// publishing/running a campaign (same purpose as runGa4TestReport in
// google-client.ts) — confirms the Page token is still valid and has
// access to the IG account.
export async function verifyInstagramAccess(
  instagramBusinessAccountId: string,
  pageAccessToken: string,
  api: InstagramApi = "facebook",
): Promise<string> {
  const result = await request<{ username?: string }>(
    `${graphBaseFor(api)}/${instagramBusinessAccountId}?fields=username&access_token=${encodeURIComponent(pageAccessToken)}`,
  );
  return result.username ?? instagramBusinessAccountId;
}

const CONTAINER_POLL_INTERVAL_MS = 2_000;
const CONTAINER_POLL_MAX_ATTEMPTS = 15; // ~30s — plenty for a single image.

// After the media container is created, Instagram downloads and processes
// the given image_url in the background — if media_publish is called
// before status_code moves from IN_PROGRESS to FINISHED, it fails with an
// error like "media ID does not exist". So we wait for FINISHED before
// publishing.
async function waitForContainerReady(
  creationId: string,
  accessToken: string,
  api: InstagramApi,
): Promise<void> {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const status = await request<{ status_code?: string }>(
      `${graphBaseFor(api)}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new MetaApiError(
        `Instagram media container could not be processed (status_code: ${status.status_code})`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS),
    );
  }
  throw new MetaApiError(
    "Instagram media container timed out (status_code never reached FINISHED)",
  );
}

// Creating the media container makes Instagram synchronously fetch and
// validate `image_url` before it responds with the creation id — this can
// take noticeably longer than the default 8s under normal network
// conditions (same reasoning as IMAGE_UPLOAD_TIMEOUT_MS above), so it gets
// its own, more generous timeout instead of DEFAULT_TIMEOUT_MS.
const MEDIA_CONTAINER_CREATE_TIMEOUT_MS = 20_000;

// The two-step Instagram Content Publishing flow: first the media
// container is created, then we wait for it to be processed, then it's
// published. imageUrl must be publicly reachable (an R2/asset storage URL
// — see src/server/media). If mediaType is "STORIES", it's published as a
// Story — Stories have NO caption field (a Meta API constraint; the text
// must already be embedded in the image), so caption is only sent in
// normal post (FEED) mode. `pageAccessToken` is the Page token on the Facebook
// route and the account's own token on the Instagram Login route (`api`).
export async function publishInstagramPost(input: {
  instagramBusinessAccountId: string;
  pageAccessToken: string;
  imageUrl: string;
  caption: string;
  mediaType?: "STORIES";
  api?: InstagramApi;
}): Promise<{ postId: string }> {
  const api = input.api ?? "facebook";
  const base = graphBaseFor(api);
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
    `${base}/${input.instagramBusinessAccountId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    },
    MEDIA_CONTAINER_CREATE_TIMEOUT_MS,
  );

  await waitForContainerReady(creation.id, input.pageAccessToken, api);

  const published = await request<{ id: string }>(
    `${base}/${input.instagramBusinessAccountId}/media_publish`,
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

// `date_preset` is one of the Marketing API's standard ranges — called
// with the same payload shape as the analysis task (see meta-api-provider.ts).
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

// A minimal required field set — not a full campaign wizard, just enough
// surface for the scenario of an AI creating a draft campaign. Sending
// `special_ad_categories` as an empty array is required by the Marketing API.
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

// Same shape as updateMetaCampaign — the write path behind
// META_ADSET_UPDATE (see MetaApiProvider.updateAdSet).
export async function updateMetaAdSet(input: {
  adSetId: string;
  accessToken: string;
  status?: "ACTIVE" | "PAUSED";
  dailyBudgetCents?: number;
  targeting?: MetaAdSetTargeting;
}): Promise<void> {
  const body = new URLSearchParams({ access_token: input.accessToken });
  if (input.status) body.set("status", input.status);
  if (input.dailyBudgetCents !== undefined) {
    body.set("daily_budget", String(input.dailyBudgetCents));
  }
  if (input.targeting) {
    body.set("targeting", JSON.stringify(buildTargetingSpec(input.targeting)));
  }

  await request<{ success: boolean }>(`${GRAPH_BASE}/${input.adSetId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

// ---------------------------------------------------------------------------
// Listing — read-only inventory calls used by the /ads page (see
// meta-ads-query.ts). Deliberately NOT routed through the Task/Approval/
// ExecutionJob system: a read has no side effect worth an approval record.

const LISTING_MAX_PAGES = 10;

// The Graph API defaults to ~25 items per page — without following
// `paging.next`, an ad account with more than that would silently
// under-report (a campaign on page 2 would 404 as "not found" when the
// user drills into it, with no indication more rows exist). `paging.next`
// is a complete, ready-to-fetch URL (access_token included). Capped at
// LISTING_MAX_PAGES as a backstop against runaway pagination on a
// pathologically large account, not because we expect to hit it in
// practice with `limit=100`.
async function requestAllPages<T>(url: string): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | undefined = url;
  for (let page = 0; nextUrl && page < LISTING_MAX_PAGES; page++) {
    const body: { data?: T[]; paging?: { next?: string } } =
      await request(nextUrl);
    results.push(...(body.data ?? []));
    nextUrl = body.paging?.next;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Performance insights per row — the numbers a reporting/strategy view
// actually needs (spend, reach, results, cost per result), fetched
// alongside the inventory listing above. Uses the Marketing API's
// `level` parameter: ONE call against `/{adAccountId}/insights?level=X`
// returns a row per campaign/adset/ad instead of N calls (one per entity) —
// avoids an N+1 that would otherwise fire once per row in the table.
const RESULT_ACTION_LABELS: Record<string, string> = {
  landing_page_view: "Landing Page Views",
  link_click: "Link Clicks",
  post_engagement: "Post Engagement",
  page_engagement: "Page Engagement",
  like: "Page Likes",
  lead: "Leads",
  purchase: "Purchases",
  "offsite_conversion.fb_pixel_purchase": "Purchases",
  "offsite_conversion.fb_pixel_lead": "Leads",
  "offsite_conversion.fb_pixel_add_to_cart": "Add to Cart",
  video_view: "Video Views",
  mobile_app_install: "App Installs",
  "onsite_conversion.messaging_conversation_started_7d":
    "Conversations Started",
  comment: "Comments",
  post_reaction: "Reactions",
  post: "Post Shares",
};

function resultActionLabel(actionType: string): string {
  return (
    RESULT_ACTION_LABELS[actionType] ??
    actionType
      .replace(/^offsite_conversion\./, "")
      .replace(/^onsite_conversion\./, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export type MetaInsightsRow = {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  frequency: number;
  // The single action type with the highest count — a heuristic stand-in
  // for Meta's own "primary result" logic (which derives from the adset's
  // optimization_goal): in practice the metric being optimized for is
  // almost always the one with the highest count, so picking the max
  // avoids needing a full optimization_goal -> action_type mapping table.
  resultCount?: number;
  resultLabel?: string;
  costPerResult?: number;
};

type RawInsightsRow = {
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: Array<{ action_type: string; value: string }>;
};

// Lead-type actions, in the order they are preferred (Works ads digest).
const LEAD_ACTION_TYPES = [
  "lead",
  "offsite_conversion.fb_pixel_lead",
  "onsite_conversion.lead_grouped",
] as const;

// Exported for tests. `preferLead` picks a lead action when its count > 0 so a
// leads campaign is not reported by a higher-volume click action; otherwise
// the highest-count rule applies unchanged.
export function toInsightsRow(
  row: RawInsightsRow,
  options?: { preferLead?: boolean },
): MetaInsightsRow {
  const spend = Number(row.spend ?? 0);
  const leadAction = options?.preferLead
    ? (row.actions ?? [])
        .map((a) => ({ action_type: a.action_type, value: Number(a.value) }))
        .filter(
          (a) =>
            (LEAD_ACTION_TYPES as readonly string[]).includes(a.action_type) &&
            a.value > 0,
        )
        .sort(
          (a, b) =>
            LEAD_ACTION_TYPES.indexOf(
              a.action_type as (typeof LEAD_ACTION_TYPES)[number],
            ) -
            LEAD_ACTION_TYPES.indexOf(
              b.action_type as (typeof LEAD_ACTION_TYPES)[number],
            ),
        )[0]
    : undefined;
  const topAction = leadAction ?? (row.actions ?? []).reduce<
    { action_type: string; value: number } | undefined
  >((best, a) => {
    const value = Number(a.value);
    // Skip a non-numeric value outright — `!best` alone would let a NaN
    // become `best` on the first iteration and get stuck there forever,
    // since every `value > NaN` comparison is false (NaN never loses a
    // later round to a legitimate number).
    if (Number.isNaN(value)) return best;
    if (!best || value > best.value)
      return { action_type: a.action_type, value };
    return best;
  }, undefined);

  return {
    spend,
    impressions: Number(row.impressions ?? 0),
    reach: Number(row.reach ?? 0),
    clicks: Number(row.clicks ?? 0),
    ctr: Number(row.ctr ?? 0),
    cpc: Number(row.cpc ?? 0),
    cpm: Number(row.cpm ?? 0),
    frequency: Number(row.frequency ?? 0),
    resultCount: topAction?.value,
    resultLabel: topAction
      ? resultActionLabel(topAction.action_type)
      : undefined,
    costPerResult:
      topAction && topAction.value > 0 ? spend / topAction.value : undefined,
  };
}

const INSIGHTS_FIELDS =
  "spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions";

// Returns a Map keyed by the row's own id at that level (campaign_id for
// level=campaign, etc.) — a campaign/adset/ad with no delivery in the date
// window simply has no entry (Meta omits zero-activity rows from insights
// rather than returning zeros), callers should treat a missing key as "no
// data yet" rather than an error.
//
// `scopedTo` narrows the query to one parent's children via the Marketing
// API's `filtering` param (e.g. `{ field: "campaign.id", value: campaignId }`
// when level=adset) — without it, drilling into a single campaign on an
// account with thousands of ad sets/ads would still pull insights for the
// WHOLE account on every navigation.
export async function fetchMetaLevelInsights(input: {
  adAccountId: string;
  accessToken: string;
  level: "campaign" | "adset" | "ad";
  datePreset: string;
  scopedTo?: { field: "campaign.id" | "adset.id"; value: string };
  // Campaign ids (OUTCOME_LEADS) whose row should prefer the lead action.
  preferLeadFor?: ReadonlySet<string>;
}): Promise<Map<string, MetaInsightsRow>> {
  const params = new URLSearchParams({
    level: input.level,
    fields: `${input.level}_id,${INSIGHTS_FIELDS}`,
    date_preset: input.datePreset,
    limit: "500",
    access_token: input.accessToken,
  });
  if (input.scopedTo) {
    params.set(
      "filtering",
      JSON.stringify([
        {
          field: input.scopedTo.field,
          operator: "IN",
          value: [input.scopedTo.value],
        },
      ]),
    );
  }
  const rows = await requestAllPages<RawInsightsRow>(
    `${GRAPH_BASE}/${input.adAccountId}/insights?${params.toString()}`,
  );

  const map = new Map<string, MetaInsightsRow>();
  for (const row of rows) {
    const id =
      input.level === "campaign"
        ? row.campaign_id
        : input.level === "adset"
          ? row.adset_id
          : row.ad_id;
    if (!id) continue;
    map.set(
      id,
      input.preferLeadFor
        ? toInsightsRow(row, { preferLead: input.preferLeadFor.has(id) })
        : toInsightsRow(row),
    );
  }
  return map;
}

export type MetaCampaignSummary = {
  campaignId: string;
  name: string;
  objective: string;
  status: string;
  effectiveStatus: string;
  dailyBudgetCents?: number;
  lifetimeBudgetCents?: number;
};

export async function listMetaCampaigns(input: {
  adAccountId: string;
  accessToken: string;
}): Promise<MetaCampaignSummary[]> {
  const params = new URLSearchParams({
    fields:
      "id,name,objective,status,effective_status,daily_budget,lifetime_budget",
    limit: "100",
    access_token: input.accessToken,
  });
  const rows = await requestAllPages<{
    id: string;
    name: string;
    objective: string;
    status: string;
    effective_status: string;
    daily_budget?: string;
    lifetime_budget?: string;
  }>(`${GRAPH_BASE}/${input.adAccountId}/campaigns?${params.toString()}`);

  return rows.map((c) => ({
    campaignId: c.id,
    name: c.name,
    objective: c.objective,
    status: c.status,
    effectiveStatus: c.effective_status,
    dailyBudgetCents: c.daily_budget ? Number(c.daily_budget) : undefined,
    lifetimeBudgetCents: c.lifetime_budget
      ? Number(c.lifetime_budget)
      : undefined,
  }));
}

export type MetaAdSetSummary = {
  adSetId: string;
  name: string;
  status: string;
  effectiveStatus: string;
  dailyBudgetCents?: number;
  optimizationGoal?: string;
  billingEvent?: string;
  // Undefined only if Meta returned no targeting at all (shouldn't happen
  // for a real adset) — see parseTargeting below.
  targeting?: MetaAdSetTargeting;
};

type RawTargeting = {
  geo_locations?: {
    countries?: string[];
    cities?: {
      key: string;
      name?: string;
      radius?: number;
      distance_unit?: string;
    }[];
  };
  age_min?: number;
  age_max?: number;
  genders?: number[];
  locales?: number[];
};

// Mirrors createMetaAdSet's targeting BUILD (above) in reverse — same field
// names (geo_locations.countries/cities, age_min/age_max, genders, locales)
// confirmed against Meta's Marketing API docs. `radius` is read back as-is
// regardless of the echoed `distance_unit` (this app always creates cities
// with distance_unit "kilometer", see createMetaAdSet, but an adset created
// outside this app could theoretically use miles) — good enough for display,
// worth revisiting only if editing needs to round-trip an exact radius.
function parseTargeting(raw: RawTargeting | undefined): MetaAdSetTargeting {
  return {
    countries: raw?.geo_locations?.countries ?? [],
    cities: raw?.geo_locations?.cities?.length
      ? raw.geo_locations.cities.map((c) => ({
          key: c.key,
          name: c.name ?? c.key,
          radiusKm: c.radius,
        }))
      : undefined,
    ageMin: raw?.age_min,
    ageMax: raw?.age_max,
    genders: raw?.genders?.filter((g): g is 1 | 2 => g === 1 || g === 2),
    // Meta's targeting GET never returns a locale's human name, only its
    // numeric id — `label` stays undefined here; callers fall back to
    // showing "Locale #<id>" for an adset that already existed before this
    // session (see adset-detail-sheet.tsx). A FRESH selection (the wizard's
    // own LocaleSearchCommand, backed by searchMetaAdLocales) carries the
    // real label straight from Meta's search result instead.
    locales: raw?.locales?.length
      ? raw.locales.map((id) => ({ id }))
      : undefined,
  };
}

export async function listMetaAdSets(input: {
  campaignId: string;
  accessToken: string;
}): Promise<MetaAdSetSummary[]> {
  const params = new URLSearchParams({
    fields:
      "id,name,status,effective_status,daily_budget,optimization_goal,billing_event,targeting",
    limit: "100",
    access_token: input.accessToken,
  });
  const rows = await requestAllPages<{
    id: string;
    name: string;
    status: string;
    effective_status: string;
    daily_budget?: string;
    optimization_goal?: string;
    billing_event?: string;
    targeting?: RawTargeting;
  }>(`${GRAPH_BASE}/${input.campaignId}/adsets?${params.toString()}`);

  return rows.map((a) => ({
    adSetId: a.id,
    name: a.name,
    status: a.status,
    effectiveStatus: a.effective_status,
    dailyBudgetCents: a.daily_budget ? Number(a.daily_budget) : undefined,
    optimizationGoal: a.optimization_goal,
    billingEvent: a.billing_event,
    targeting: parseTargeting(a.targeting),
  }));
}

export type MetaAdCreativeCard = {
  link: string;
  name: string;
  description?: string;
  // Present when read back from an existing ad (see parseCreativeDetail) —
  // NOT sent by the wizard's create-side card shape, which only has a
  // local File to upload. Lets an edit that doesn't replace a given card's
  // image reuse this hash directly instead of re-uploading.
  imageHash?: string;
};

// The listing/detail-view shape of an existing ad's creative — deliberately
// NOT the same as the wizard's `pendingAd` creation payload (that one also
// carries imageAssetId/videoAssetId/thumbnailAssetId, which only make sense
// for a not-yet-uploaded local File). `imageHash`/`videoId` exist so an EDIT
// that only changes text (message/link/CTA) can rebuild the creative
// pointing at the SAME already-uploaded image/video instead of forcing the
// user to re-select a file they didn't mean to change — Meta's adimages/
// advideos library lets a new creative reference an existing hash/id
// without re-uploading. `thumbnailUrl` on MetaAdSummary (Meta's own
// one-image preview for any creative type, usually the first card for a
// carousel) remains the only fetchable per-ad IMAGE URL for display.
export type MetaAdCreativeDetail = {
  format: "SINGLE_IMAGE" | "CAROUSEL" | "VIDEO";
  message?: string;
  link?: string;
  callToActionType?: string;
  imageHash?: string;
  videoId?: string;
  cards?: MetaAdCreativeCard[];
};

type RawObjectStorySpec = {
  link_data?: {
    link?: string;
    message?: string;
    image_hash?: string;
    call_to_action?: { type?: string };
    child_attachments?: {
      link?: string;
      name?: string;
      description?: string;
      image_hash?: string;
    }[];
  };
  video_data?: {
    video_id?: string;
    message?: string;
    call_to_action?: { type?: string; value?: { link?: string } };
  };
};

// object_story_spec carries EITHER link_data (single image, or carousel
// when it has child_attachments) OR video_data — the two are mutually
// exclusive, confirmed against Meta's Marketing API docs. video_data has no
// top-level link (unlike link_data) — its destination URL is nested inside
// call_to_action.value.link, matching createMetaVideoAdCreative's write
// side above.
function parseCreativeDetail(
  spec: RawObjectStorySpec | undefined,
): MetaAdCreativeDetail | undefined {
  if (!spec) return undefined;
  if (spec.video_data) {
    return {
      format: "VIDEO",
      message: spec.video_data.message,
      link: spec.video_data.call_to_action?.value?.link,
      callToActionType: spec.video_data.call_to_action?.type,
      videoId: spec.video_data.video_id,
    };
  }
  if (spec.link_data?.child_attachments?.length) {
    return {
      format: "CAROUSEL",
      message: spec.link_data.message,
      callToActionType: spec.link_data.call_to_action?.type,
      cards: spec.link_data.child_attachments.map((c) => ({
        link: c.link ?? "",
        name: c.name ?? "",
        description: c.description,
        imageHash: c.image_hash,
      })),
    };
  }
  if (spec.link_data) {
    return {
      format: "SINGLE_IMAGE",
      message: spec.link_data.message,
      link: spec.link_data.link,
      callToActionType: spec.link_data.call_to_action?.type,
      imageHash: spec.link_data.image_hash,
    };
  }
  return undefined;
}

export type MetaAdSummary = {
  adId: string;
  name: string;
  status: string;
  effectiveStatus: string;
  creativeId?: string;
  thumbnailUrl?: string;
  creative?: MetaAdCreativeDetail;
};

export async function listMetaAds(input: {
  adSetId: string;
  accessToken: string;
}): Promise<MetaAdSummary[]> {
  const params = new URLSearchParams({
    fields:
      "id,name,status,effective_status,creative{id,thumbnail_url,object_story_spec}",
    limit: "100",
    access_token: input.accessToken,
  });
  const rows = await requestAllPages<{
    id: string;
    name: string;
    status: string;
    effective_status: string;
    creative?: {
      id: string;
      thumbnail_url?: string;
      object_story_spec?: RawObjectStorySpec;
    };
  }>(`${GRAPH_BASE}/${input.adSetId}/ads?${params.toString()}`);

  return rows.map((a) => ({
    adId: a.id,
    name: a.name,
    status: a.status,
    effectiveStatus: a.effective_status,
    creativeId: a.creative?.id,
    thumbnailUrl: a.creative?.thumbnail_url,
    creative: parseCreativeDetail(a.creative?.object_story_spec),
  }));
}

// ---------------------------------------------------------------------------
// AdSet / Ad / AdCreative creation — the write path behind META_ADSET_CREATE
// and META_AD_CREATE (see MetaApiProvider). Same spirit as createMetaCampaign:
// enough surface for an AI-assisted draft, not a full ads-manager clone —
// basic demographics + location, Meta's detailed targeting (interests/
// behaviors, custom/lookalike audiences) is out of scope here.
export type MetaAdSetTargeting = {
  countries: string[];
  // `key` is the geo location id from searchMetaAdGeoLocations — Meta
  // requires the search endpoint's own opaque key, not a city name. `name`
  // is display-only (not sent to Meta, which ignores unknown fields in the
  // request body) — the create wizard already carries it through from its
  // city chips, and parseTargeting (below) fills it in when reading an
  // existing adset back so the detail view can show a human city name
  // instead of a bare opaque key.
  cities?: { key: string; name?: string; radiusKm?: number }[];
  ageMin?: number;
  ageMax?: number;
  // Meta's numeric gender codes: 1 = male, 2 = female. Omitted/empty = all.
  genders?: (1 | 2)[];
  // Meta's numeric locale ids, resolved live via searchMetaAdLocales (see
  // LocaleSearchCommand) — NOT a hardcoded table; Meta doesn't publish a
  // static locale reference, and a former one here had at least one
  // confirmed-wrong id. `label` is display-only (not sent to Meta), same
  // reasoning as `cities.name` above — undefined when read back from an
  // existing adset, since Meta's targeting GET never returns a locale name.
  locales?: { id: number; label?: string }[];
};

// Shared between createMetaAdSet and updateMetaAdSet's targeting update —
// same geo_locations/age/gender/locale shape either way.
function buildTargetingSpec(targeting: MetaAdSetTargeting) {
  return {
    geo_locations: {
      countries: targeting.countries,
      ...(targeting.cities?.length
        ? {
            cities: targeting.cities.map((c) => ({
              key: c.key,
              radius: c.radiusKm ?? 25,
              distance_unit: "kilometer",
            })),
          }
        : {}),
    },
    ...(targeting.ageMin !== undefined ? { age_min: targeting.ageMin } : {}),
    ...(targeting.ageMax !== undefined ? { age_max: targeting.ageMax } : {}),
    ...(targeting.genders?.length ? { genders: targeting.genders } : {}),
    ...(targeting.locales?.length
      ? { locales: targeting.locales.map((l) => l.id) }
      : {}),
  };
}

export async function createMetaAdSet(input: {
  adAccountId: string;
  accessToken: string;
  campaignId: string;
  name: string;
  dailyBudgetCents: number;
  billingEvent: string;
  optimizationGoal: string;
  targeting: MetaAdSetTargeting;
  status: "ACTIVE" | "PAUSED";
}): Promise<{ adSetId: string }> {
  const body = new URLSearchParams({
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: String(input.dailyBudgetCents),
    billing_event: input.billingEvent,
    optimization_goal: input.optimizationGoal,
    targeting: JSON.stringify(buildTargetingSpec(input.targeting)),
    status: input.status,
    access_token: input.accessToken,
  });

  const result = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/adsets`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return { adSetId: result.id };
}

export type MetaAdGeoLocation = {
  key: string;
  name: string;
  countryCode?: string;
  region?: string;
};

// City-search behind the AdSet wizard's targeting step — Meta requires the
// opaque `key` this endpoint returns (not a plain city name) in
// createMetaAdSet's targeting.cities. Scoped to `type=city` only: region/
// zip/geo-market targeting is out of scope here.
export async function searchMetaAdGeoLocations(input: {
  query: string;
  accessToken: string;
}): Promise<MetaAdGeoLocation[]> {
  const params = new URLSearchParams({
    type: "adgeolocation",
    location_types: JSON.stringify(["city"]),
    q: input.query,
    access_token: input.accessToken,
  });
  const result = await request<{
    data?: Array<{
      key: string;
      name: string;
      country_code?: string;
      region?: string;
    }>;
  }>(`${GRAPH_BASE}/search?${params.toString()}`);

  return (result.data ?? []).map((loc) => ({
    key: loc.key,
    name: loc.name,
    countryCode: loc.country_code,
    region: loc.region,
  }));
}

export type MetaAdLocale = {
  id: number;
  label: string;
};

// Locale (ad_locale) search behind the AdSet wizard's targeting step —
// replaces a former hardcoded META_LOCALES table that turned out to have
// at least one wrong id (verified: id 24 is actually "English (UK)", not
// "Turkish" as the table claimed) with no way to catch the rest without a
// live call. Meta doesn't publish a static locale reference; `type=adlocale`
// is the only way to get a locale's real numeric id, confirmed against the
// same `/search` endpoint searchMetaAdGeoLocations already uses above (same
// shape: `key`/`name` pairs), just with a numeric `key` instead of a string
// one.
export async function searchMetaAdLocales(input: {
  query: string;
  accessToken: string;
}): Promise<MetaAdLocale[]> {
  const params = new URLSearchParams({
    type: "adlocale",
    q: input.query,
    access_token: input.accessToken,
  });
  const result = await request<{
    data?: Array<{ key: number; name: string }>;
  }>(`${GRAPH_BASE}/search?${params.toString()}`);

  return (result.data ?? []).map((loc) => ({
    id: loc.key,
    label: loc.name,
  }));
}

const IMAGE_UPLOAD_TIMEOUT_MS = 20_000;

// The Marketing API's `adimages` endpoint accepts base64 image bytes as a
// plain `bytes` form field — no multipart upload required, unlike
// publishInstagramPost (which needs a public image_url because Instagram
// fetches it itself). This means it works even when the asset has no
// public URL (e.g. local storage without R2 configured) — the caller reads
// the asset's bytes (see asset-storage.ts's readAsset) and passes them here.
export async function uploadMetaAdImage(input: {
  adAccountId: string;
  accessToken: string;
  imageBuffer: Buffer;
}): Promise<{ imageHash: string }> {
  const body = new URLSearchParams({
    bytes: input.imageBuffer.toString("base64"),
    access_token: input.accessToken,
  });

  const result = await request<{
    images?: Record<string, { hash?: string }>;
  }>(
    `${GRAPH_BASE}/${input.adAccountId}/adimages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    IMAGE_UPLOAD_TIMEOUT_MS,
  );

  const entry = Object.values(result.images ?? {})[0];
  if (!entry?.hash) {
    throw new MetaApiError("Meta did not return an image hash for the upload");
  }
  return { imageHash: entry.hash };
}

export async function createMetaAdCreative(input: {
  adAccountId: string;
  accessToken: string;
  pageId: string;
  imageHash: string;
  message: string;
  link: string;
  callToActionType: string;
}): Promise<{ creativeId: string }> {
  const objectStorySpec = {
    page_id: input.pageId,
    link_data: {
      image_hash: input.imageHash,
      link: input.link,
      message: input.message,
      call_to_action: { type: input.callToActionType },
    },
  };

  const body = new URLSearchParams({
    object_story_spec: JSON.stringify(objectStorySpec),
    access_token: input.accessToken,
  });

  const result = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/adcreatives`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return { creativeId: result.id };
}

// Same object_story_spec shape as createMetaAdCreative, except link_data
// carries `child_attachments` (one entry per carousel card) instead of a
// single image_hash/link pair. Meta requires 2-10 cards for a carousel
// creative — the lower bound is guarded here, the upper bound is left to
// Meta's own API validation (surfaced as a normal MetaApiError via `request`).
export async function createMetaCarouselAdCreative(input: {
  adAccountId: string;
  accessToken: string;
  pageId: string;
  message: string;
  cards: {
    link: string;
    name: string;
    imageHash: string;
    description?: string;
  }[];
  callToActionType?: string;
}): Promise<{ creativeId: string }> {
  if (input.cards.length < 2) {
    throw new MetaApiError("A carousel creative requires at least 2 cards");
  }

  const objectStorySpec = {
    page_id: input.pageId,
    link_data: {
      // Meta still requires a top-level fallback `link` on link_data even
      // when child_attachments is present (used by older/limited surfaces
      // that can't render the carousel) — the first card's link is a
      // reasonable default; every child still carries its own link.
      link: input.cards[0]!.link,
      message: input.message,
      child_attachments: input.cards.map((card) => ({
        link: card.link,
        name: card.name,
        image_hash: card.imageHash,
        ...(card.description ? { description: card.description } : {}),
      })),
      ...(input.callToActionType
        ? { call_to_action: { type: input.callToActionType } }
        : {}),
    },
  };

  const body = new URLSearchParams({
    object_story_spec: JSON.stringify(objectStorySpec),
    access_token: input.accessToken,
  });

  const result = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/adcreatives`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return { creativeId: result.id };
}

// video_data's own shape (unlike link_data) has no top-level `link` — the
// destination URL is nested inside call_to_action.value.link instead.
// image_url is a REQUIRED cover/thumbnail image and must be a public URL
// (unlike adimages' image_hash, video_data won't accept a hash here) — see
// resolveDirectPublicUrl in asset-storage.ts, which is why the wizard
// requires a separate thumbnail upload rather than deriving one from the
// video itself (no server-side video-frame extraction here).
export async function createMetaVideoAdCreative(input: {
  adAccountId: string;
  accessToken: string;
  pageId: string;
  videoId: string;
  thumbnailUrl: string;
  message: string;
  link: string;
  callToActionType: string;
}): Promise<{ creativeId: string }> {
  const objectStorySpec = {
    page_id: input.pageId,
    video_data: {
      video_id: input.videoId,
      image_url: input.thumbnailUrl,
      message: input.message,
      call_to_action: {
        type: input.callToActionType,
        value: { link: input.link },
      },
    },
  };

  const body = new URLSearchParams({
    object_story_spec: JSON.stringify(objectStorySpec),
    access_token: input.accessToken,
  });

  const result = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/adcreatives`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return { creativeId: result.id };
}

const VIDEO_UPLOAD_TIMEOUT_MS = 120_000; // a video is far larger than a
// single image (uploadMetaAdImage's IMAGE_UPLOAD_TIMEOUT_MS = 20_000) — give
// the transfer itself generous headroom, independent of Meta's own
// background processing (checked separately, see checkMetaVideoStatus below).

// Unlike uploadMetaAdImage's `adimages` endpoint (base64 bytes as a plain
// form field), the Marketing API's `advideos` endpoint requires a genuine
// multipart upload — `source` must be a file part or Meta rejects it. A
// native FormData body sets its own multipart boundary, so — unlike every
// other write in this file — Content-Type must NOT be set manually here;
// fetch derives it from the FormData instance.
export async function uploadMetaAdVideo(input: {
  adAccountId: string;
  accessToken: string;
  videoBuffer: Buffer;
  mimeType: string;
}): Promise<{ videoId: string }> {
  const form = new FormData();
  form.set(
    "source",
    new Blob([new Uint8Array(input.videoBuffer)], { type: input.mimeType }),
    "ad-video",
  );
  form.set("access_token", input.accessToken);

  const result = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/advideos`,
    { method: "POST", body: form },
    VIDEO_UPLOAD_TIMEOUT_MS,
  );
  if (!result.id) {
    throw new MetaApiError("Meta did not return a video id for the upload");
  }
  return { videoId: result.id };
}

// A SINGLE status check (not a retry loop, unlike waitForContainerReady
// above) — Meta processes an uploaded video asynchronously (transcoding,
// thumbnail generation) before it can back an ad creative, and that can
// take anywhere from seconds to several minutes. Looping with an in-process
// sleep here would block the calling ExecutionWorker tick for that whole
// span (risking its 5-minute tick watchdog and stalling every OTHER job's
// polling in the same tick) — instead MetaApiProvider's video path calls
// this ONCE per getStatus() poll, the same "check once, let the caller's
// own tick loop retry later" shape OpenClawProvider already uses for
// long-running browser runs. Returns false while still processing, true
// once ready; throws only on Meta's own reported error state.
export async function checkMetaVideoStatus(input: {
  videoId: string;
  accessToken: string;
}): Promise<boolean> {
  const result = await request<{ status?: { video_status?: string } }>(
    `${GRAPH_BASE}/${input.videoId}?fields=status&access_token=${encodeURIComponent(input.accessToken)}`,
  );
  const videoStatus = result.status?.video_status;
  if (videoStatus === "ready") return true;
  if (videoStatus === "error") {
    throw new MetaApiError(
      `Meta video could not be processed (video_status: ${videoStatus})`,
    );
  }
  return false;
}

export async function createMetaAd(input: {
  adAccountId: string;
  accessToken: string;
  adSetId: string;
  name: string;
  creativeId: string;
  status: "ACTIVE" | "PAUSED";
}): Promise<{ adId: string }> {
  const body = new URLSearchParams({
    name: input.name,
    adset_id: input.adSetId,
    creative: JSON.stringify({ creative_id: input.creativeId }),
    status: input.status,
    access_token: input.accessToken,
  });

  const result = await request<{ id: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/ads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return { adId: result.id };
}

// Updates an EXISTING ad — the write path behind META_AD_UPDATE. Meta's
// AdCreative content is immutable once created (confirmed against Meta's
// Marketing API docs: no update example exists for object_story_spec, only
// for name/status), so "editing" an ad's creative always means building a
// brand-new creative first (createMetaAdCreative/createMetaCarouselAdCreative/
// createMetaVideoAdCreative, same as at creation time) and pointing this ad
// at it via `creativeId` — never in-place content mutation.
export async function updateMetaAd(input: {
  adId: string;
  accessToken: string;
  name?: string;
  status?: "ACTIVE" | "PAUSED";
  creativeId?: string;
}): Promise<void> {
  const body = new URLSearchParams({ access_token: input.accessToken });
  if (input.name) body.set("name", input.name);
  if (input.status) body.set("status", input.status);
  if (input.creativeId) {
    body.set("creative", JSON.stringify({ creative_id: input.creativeId }));
  }

  await request<{ success: boolean }>(`${GRAPH_BASE}/${input.adId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
