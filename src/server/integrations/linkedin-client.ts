import "server-only";

// A thin, real LinkedIn REST API (Community Management API — the "Share
// on LinkedIn" product) wrapper — no SDK, plain `fetch` (same pattern as
// google-client.ts/meta-client.ts). The OAuth 2.0 authorization-code flow
// (NO PKCE — LinkedIn's 3-legged flow doesn't require it) + the minimum
// surface of personal profile sharing needed for this integration.
//
// NOTE: obtaining a refresh token additionally requires "Programmatic
// Refresh Tokens" product approval on some apps — without approval, the
// user must reconnect after the access token expires in ~60 days (like
// Meta's long-lived token).

import { getEnv } from "@/lib/env";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const IMAGES_INIT_URL =
  "https://api.linkedin.com/rest/images?action=initializeUpload";
const POSTS_URL = "https://api.linkedin.com/rest/posts";
const LINKEDIN_API_VERSION = "202601";

const SCOPES = ["openid", "profile", "w_member_social"];

const DEFAULT_TIMEOUT_MS = 8_000;

// The shape of IntegrationCredential.metadata (provider: "linkedin").
export type LinkedInCredentialMetadata = {
  memberUrn?: string;
  displayName?: string;
  avatarUrl?: string;
  accessTokenExpiresAt?: string;
  hasRefreshToken?: boolean;
  lastTestResult?: {
    testedAt: string;
    displayName?: string;
    error?: string;
  };
};

export class LinkedInApiError extends Error {
  readonly linkedinErrorCode?: number;
  constructor(message: string, linkedinErrorCode?: number) {
    super(message);
    this.name = "LinkedInApiError";
    this.linkedinErrorCode = linkedinErrorCode;
  }
}

// LinkedIn's auth-expiry signal — used by LinkedInApiProvider's
// publishWithRefresh to only refresh+retry on an actually-expired/invalid
// token, instead of treating every publish failure as one.
export function isLinkedInAuthError(error: unknown): boolean {
  return error instanceof LinkedInApiError && error.linkedinErrorCode === 401;
}

// There is no separate LINKEDIN_OAUTH_REDIRECT_URI env var — it's derived
// from the existing NEXT_PUBLIC_APP_URL, and this path must be registered
// as the "Authorized redirect URL" in the LinkedIn Developer Portal.
function redirectUri(): string {
  return `${getEnv().NEXT_PUBLIC_APP_URL}/api/integrations/linkedin/callback`;
}

function restHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// Same abort/timeout pattern as google-client.ts/meta-client.ts/
// tiktok-client.ts/x-client.ts — returns the raw Response (not just the
// parsed body) because createLinkedInPost needs the `x-restli-id` response
// header, which a body-only helper can't expose.
async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new LinkedInApiError(
      isAbort
        ? `LinkedIn API request timed out (${timeoutMs}ms)`
        : `Could not reach LinkedIn API: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await fetchWithTimeout(url, init, timeoutMs);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Empty body — not a problem, res.ok is checked below.
  }

  if (!res.ok) {
    const errorBody = body as {
      message?: string;
      status?: number;
      code?: string;
    } | null;
    const message =
      errorBody?.message ?? `LinkedIn API error (HTTP ${res.status})`;
    throw new LinkedInApiError(message, res.status);
  }

  return body as T;
}

export function buildLinkedInAuthorizeUrl(state: string): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeLinkedInAuthCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}> {
  const env = getEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
    redirect_uri: redirectUri(),
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
    expiresIn: result.expires_in ?? 60 * 24 * 60 * 60,
  };
}

// invalid_grant → refresh token revoked/expired, the caller should mark the
// credential EXPIRED and prompt reconnection (same convention as
// refreshGoogleAccessToken).
export async function refreshLinkedInAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const env = getEnv();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
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
    expiresIn: result.expires_in ?? 0,
  };
}

// Throws LinkedInApiError on ANY failure (network/timeout, non-2xx, or a
// response missing `sub`) instead of swallowing it into a `null` return —
// callers that can tolerate a missing profile (e.g. the OAuth callback,
// which should still persist the connection) catch and degrade explicitly;
// callers that can't (e.g. a publish-time re-check) get a real error to
// react to instead of an ambiguous null.
export async function fetchLinkedInProfile(
  accessToken: string,
): Promise<{ memberUrn: string; displayName: string; avatarUrl?: string }> {
  const result = await request<{
    sub?: string;
    name?: string;
    picture?: string;
  }>(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!result.sub) {
    throw new LinkedInApiError("LinkedIn userinfo response is missing `sub`");
  }
  return {
    memberUrn: `urn:li:person:${result.sub}`,
    displayName: result.name ?? result.sub,
    avatarUrl: result.picture,
  };
}

// Image sharing is a 2-step process: initializeUpload returns an upload
// URL + image URN, raw bytes are PUT to that URL, then the image URN is
// embedded in the post body (unlike Meta's media container pattern —
// LinkedIn has no separate "is it ready" waiting step; it's usable as
// soon as the upload finishes synchronously).
export async function uploadLinkedInImage(input: {
  accessToken: string;
  memberUrn: string;
  imageBytes: ArrayBuffer;
}): Promise<{ imageUrn: string }> {
  const init = await request<{
    value?: { uploadUrl?: string; image?: string };
  }>(IMAGES_INIT_URL, {
    method: "POST",
    headers: {
      ...restHeaders(input.accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      initializeUploadRequest: { owner: input.memberUrn },
    }),
  });
  const uploadUrl = init.value?.uploadUrl;
  const imageUrn = init.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new LinkedInApiError("LinkedIn did not return an image upload URL");
  }

  const putRes = await fetchWithTimeout(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${input.accessToken}` },
    body: input.imageBytes,
  });
  if (!putRes.ok) {
    throw new LinkedInApiError(
      `Could not upload LinkedIn image (HTTP ${putRes.status})`,
      putRes.status,
    );
  }

  return { imageUrn };
}

// Sharing text (+ an optional single image) — Community Management API
// `/rest/posts`. On success the body comes back empty, and the created
// post's urn comes in the `x-restli-id` response header — this is why it
// uses fetchWithTimeout directly instead of the body-only `request()`.
export async function createLinkedInPost(input: {
  accessToken: string;
  memberUrn: string;
  commentary: string;
  imageUrn?: string;
}): Promise<{ postUrn: string }> {
  const body: Record<string, unknown> = {
    author: input.memberUrn,
    commentary: input.commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.imageUrn) {
    body.content = { media: { id: input.imageUrn } };
  }

  const res = await fetchWithTimeout(POSTS_URL, {
    method: "POST",
    headers: {
      ...restHeaders(input.accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const postUrn = res.headers.get("x-restli-id");
  if (!res.ok || !postUrn) {
    const errorJson = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new LinkedInApiError(
      errorJson?.message ??
        `Could not create LinkedIn post (HTTP ${res.status})`,
      res.status,
    );
  }
  return { postUrn };
}
