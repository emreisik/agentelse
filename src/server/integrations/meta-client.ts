import "server-only";

// A thin, real Meta Graph API + Marketing API wrapper — no SDK, plain
// `fetch` (same pattern as google-client.ts). The OAuth authorization-code
// flow + the minimum surface of Instagram Content Publishing + Marketing
// API needed for this integration.

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

// The shape of IntegrationCredential.metadata (provider: "meta") — the
// callback route writes it when establishing the connection, meta-actions.ts
// updates selection/test results, and the integrations page and
// MetaApiProvider read it directly.
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
    } | null;
    const message =
      errorBody?.error?.message ?? `Meta API error (HTTP ${res.status})`;
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

// A one-off test call that proves the connection actually works, without
// publishing/running a campaign (same purpose as runGa4TestReport in
// google-client.ts) — confirms the Page token is still valid and has
// access to the IG account.
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
const CONTAINER_POLL_MAX_ATTEMPTS = 15; // ~30s — plenty for a single image.

// After the media container is created, Instagram downloads and processes
// the given image_url in the background — if media_publish is called
// before status_code moves from IN_PROGRESS to FINISHED, it fails with an
// error like "media ID does not exist". So we wait for FINISHED before
// publishing.
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

// The two-step Instagram Content Publishing flow: first the media
// container is created, then we wait for it to be processed, then it's
// published. imageUrl must be publicly reachable (an R2/asset storage URL
// — see src/server/media). If mediaType is "STORIES", it's published as a
// Story — Stories have NO caption field (a Meta API constraint; the text
// must already be embedded in the image), so caption is only sent in
// normal post (FEED) mode.
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
};

export async function listMetaAdSets(input: {
  campaignId: string;
  accessToken: string;
}): Promise<MetaAdSetSummary[]> {
  const params = new URLSearchParams({
    fields:
      "id,name,status,effective_status,daily_budget,optimization_goal,billing_event",
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
  }>(`${GRAPH_BASE}/${input.campaignId}/adsets?${params.toString()}`);

  return rows.map((a) => ({
    adSetId: a.id,
    name: a.name,
    status: a.status,
    effectiveStatus: a.effective_status,
    dailyBudgetCents: a.daily_budget ? Number(a.daily_budget) : undefined,
    optimizationGoal: a.optimization_goal,
    billingEvent: a.billing_event,
  }));
}

export type MetaAdSummary = {
  adId: string;
  name: string;
  status: string;
  effectiveStatus: string;
  creativeId?: string;
  thumbnailUrl?: string;
};

export async function listMetaAds(input: {
  adSetId: string;
  accessToken: string;
}): Promise<MetaAdSummary[]> {
  const params = new URLSearchParams({
    fields: "id,name,status,effective_status,creative{id,thumbnail_url}",
    limit: "100",
    access_token: input.accessToken,
  });
  const rows = await requestAllPages<{
    id: string;
    name: string;
    status: string;
    effective_status: string;
    creative?: { id: string; thumbnail_url?: string };
  }>(`${GRAPH_BASE}/${input.adSetId}/ads?${params.toString()}`);

  return rows.map((a) => ({
    adId: a.id,
    name: a.name,
    status: a.status,
    effectiveStatus: a.effective_status,
    creativeId: a.creative?.id,
    thumbnailUrl: a.creative?.thumbnail_url,
  }));
}

// ---------------------------------------------------------------------------
// AdSet / Ad / AdCreative creation — the write path behind META_ADSET_CREATE
// and META_AD_CREATE (see MetaApiProvider). Minimal field sets, same spirit
// as createMetaCampaign: enough surface for an AI-assisted draft, not a full
// ads-manager clone. Targeting is deliberately shallow for v1 — country
// codes + an age range — Meta's full targeting spec (interests, custom
// audiences, placements...) is out of scope here.
export type MetaAdSetTargeting = {
  countries: string[];
  ageMin?: number;
  ageMax?: number;
};

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
  const targeting = {
    geo_locations: { countries: input.targeting.countries },
    ...(input.targeting.ageMin !== undefined
      ? { age_min: input.targeting.ageMin }
      : {}),
    ...(input.targeting.ageMax !== undefined
      ? { age_max: input.targeting.ageMax }
      : {}),
  };

  const body = new URLSearchParams({
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: String(input.dailyBudgetCents),
    billing_event: input.billingEvent,
    optimization_goal: input.optimizationGoal,
    targeting: JSON.stringify(targeting),
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
