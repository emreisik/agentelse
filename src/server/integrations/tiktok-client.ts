import "server-only";

// A thin, real TikTok Content Posting API wrapper — no SDK, plain `fetch`
// (same pattern as google-client.ts/meta-client.ts). The OAuth 2.0 + PKCE
// authorization-code flow + the minimum surface of the Content Posting API
// (Direct Post) needed for this integration.
//
// IMPORTANT: content published by an "unaudited" client is automatically
// made private/self-only by TikTok (if the video.publish scope hasn't been
// audited). For a post visible to the general public, the app needs to go
// through TikTok Developer Portal's audit process — this code cannot get
// around that.

import { getEnv } from "@/lib/env";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USERINFO_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url";
const POST_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const POST_STATUS_URL =
  "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const SCOPES = ["user.info.basic", "video.publish"];

const DEFAULT_TIMEOUT_MS = 8_000;

// The shape of IntegrationCredential.metadata (provider: "tiktok") — the
// callback route writes it when establishing the connection,
// tiktok-actions.ts updates the test result, and the integrations page
// reads it directly.
export type TikTokCredentialMetadata = {
  openId?: string;
  displayName?: string;
  avatarUrl?: string;
  // The access token lives ~24 hours — once the JSON stored in
  // encryptedSecret (accessToken+refreshToken) expires, it's automatically
  // renewed via refreshTikTokAccessToken (see tiktok-api-provider.ts).
  accessTokenExpiresAt?: string;
  lastTestResult?: {
    testedAt: string;
    displayName?: string;
    error?: string;
  };
};

// A token pair stored as JSON in the encryptedSecret field — unlike
// Google, TikTok's access + refresh token come back together in the same
// token endpoint response, so carrying both in a single encrypted field
// (without opening a separate DB column like Google's) is the simplest
// solution.
export type TikTokTokenPair = { accessToken: string; refreshToken: string };

export function serializeTikTokTokens(tokens: TikTokTokenPair): string {
  return JSON.stringify(tokens);
}

export function parseTikTokTokens(raw: string): TikTokTokenPair {
  return JSON.parse(raw) as TikTokTokenPair;
}

export class TikTokApiError extends Error {
  readonly tiktokErrorCode?: string;
  readonly httpStatus?: number;
  constructor(message: string, tiktokErrorCode?: string, httpStatus?: number) {
    super(message);
    this.name = "TikTokApiError";
    this.tiktokErrorCode = tiktokErrorCode;
    this.httpStatus = httpStatus;
  }
}

// TikTok's own auth-expiry signal (distinct from other 4xx errors like a
// malformed request or a content-policy rejection) — used by
// publishWithRefresh (tiktok-api-provider.ts) to only refresh+retry on an
// actually-expired token, instead of treating every failure as one.
export function isTikTokAuthError(error: unknown): boolean {
  if (!(error instanceof TikTokApiError)) return false;
  if (error.httpStatus === 401) return true;
  return (
    error.tiktokErrorCode === "access_token_invalid" ||
    error.tiktokErrorCode === "invalid_token" ||
    error.tiktokErrorCode === "token_expired"
  );
}

// There is no separate TIKTOK_OAUTH_REDIRECT_URI env var — it's derived
// from the existing NEXT_PUBLIC_APP_URL, and this path must be registered
// as the "Redirect URI" in the TikTok Developer Portal.
function redirectUri(): string {
  return `${getEnv().NEXT_PUBLIC_APP_URL}/api/integrations/tiktok/callback`;
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
    throw new TikTokApiError(
      isAbort
        ? `TikTok API request timed out (${timeoutMs}ms)`
        : `Could not reach TikTok API: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Empty body — not a problem, res.ok/error.code is checked below.
  }

  // TikTok can return HTTP 200 while carrying the error in body.error.code
  // with a value other than "ok" (unlike Google/Meta) — check both.
  const errorBody = body as {
    error?: { code?: string; message?: string };
  } | null;
  const bodyErrorCode = errorBody?.error?.code;
  if (!res.ok || (bodyErrorCode && bodyErrorCode !== "ok")) {
    const message =
      errorBody?.error?.message ?? `TikTok API error (HTTP ${res.status})`;
    throw new TikTokApiError(message, bodyErrorCode, res.status);
  }

  return body as T;
}

export function buildTikTokAuthorizeUrl(
  state: string,
  codeChallenge: string,
): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(","),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeTikTokAuthCode(
  code: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const env = getEnv();
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code_verifier: codeVerifier,
  });
  const result = await request<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: body.toString(),
  });
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresIn: result.expires_in,
  };
}

// The refresh_token can also rotate (the response returns a new
// refresh_token) — the caller must always save the returned pair, never
// reuse the old one.
export async function refreshTikTokAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const env = getEnv();
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const result = await request<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: body.toString(),
  });
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresIn: result.expires_in,
  };
}

export async function fetchTikTokProfile(accessToken: string): Promise<{
  openId: string;
  displayName: string;
  avatarUrl?: string;
} | null> {
  try {
    const result = await request<{
      data?: {
        user?: {
          open_id?: string;
          display_name?: string;
          avatar_url?: string;
        };
      };
    }>(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = result.data?.user;
    if (!user?.open_id) return null;
    return {
      openId: user.open_id,
      displayName: user.display_name ?? user.open_id,
      avatarUrl: user.avatar_url,
    };
  } catch {
    return null;
  }
}

// Direct Post — PULL_FROM_URL mode: TikTok itself downloads the public
// video URL we give it (an R2 asset — see buildAssetPublicUrl) in the
// background, so we never have to do a chunked upload (the same idea as
// Meta's media container pattern, in a different API shape). privacy_level
// is already forced to SELF_ONLY by TikTok for an "unaudited" client;
// PUBLIC_TO_EVERYONE becomes requestable after the audit.
export async function publishTikTokVideo(input: {
  accessToken: string;
  videoUrl: string;
  caption: string;
  privacyLevel?: "SELF_ONLY" | "PUBLIC_TO_EVERYONE";
}): Promise<{ publishId: string }> {
  const result = await request<{ data?: { publish_id?: string } }>(
    POST_INIT_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          title: input.caption,
          privacy_level: input.privacyLevel ?? "SELF_ONLY",
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: "PULL_FROM_URL",
          video_url: input.videoUrl,
        },
      }),
    },
  );
  const publishId = result.data?.publish_id;
  if (!publishId) {
    throw new TikTokApiError("TikTok did not return a publish_id");
  }
  return { publishId };
}

export type TikTokPublishStatus =
  | "PROCESSING_DOWNLOAD"
  | "PROCESSING_UPLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED";

export async function fetchTikTokPublishStatus(
  accessToken: string,
  publishId: string,
): Promise<{ status: TikTokPublishStatus; failReason?: string }> {
  const result = await request<{
    data?: { status?: string; fail_reason?: string };
  }>(POST_STATUS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  return {
    status: (result.data?.status as TikTokPublishStatus) ?? "FAILED",
    failReason: result.data?.fail_reason,
  };
}
