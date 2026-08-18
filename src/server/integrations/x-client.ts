import "server-only";

// A thin, real X (Twitter) API v2 wrapper — no SDK, plain `fetch` (same
// pattern as google-client.ts/meta-client.ts). The OAuth 2.0 + PKCE
// authorization-code flow + the minimum surface of tweet creation needed
// for this integration.
//
// IMPORTANT: as of February 2026, X removed the free tier for new
// developers — creating a post is now billed per use (~$0.01-0.015/post).
// Every "publish" click on this integration incurs a real cost on X's
// side, which is why it's already marked APPROVAL_REQUIRED + HIGH_RISK in
// execution-policy.ts — it can't be triggered without a deliberate
// approval.
//
// Image/video attachment: X's media upload still lives on a separate v1.1
// endpoint (upload.x.com/1.1/media/upload.json). This client currently
// only covers text tweets — if media support is added, a chunked upload
// to media/upload.json must happen first, and the returned media_id must
// be added to the media.media_ids array in the /2/tweets body.

import { getEnv } from "@/lib/env";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const USERINFO_URL = "https://api.x.com/2/users/me";
const TWEETS_URL = "https://api.x.com/2/tweets";

const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"];

const DEFAULT_TIMEOUT_MS = 8_000;

// The shape of IntegrationCredential.metadata (provider: "x").
export type XCredentialMetadata = {
  userId?: string;
  username?: string;
  displayName?: string;
  accessTokenExpiresAt?: string;
  lastTestResult?: {
    testedAt: string;
    username?: string;
    error?: string;
  };
};

export type XTokenPair = { accessToken: string; refreshToken: string };

export function serializeXTokens(tokens: XTokenPair): string {
  return JSON.stringify(tokens);
}

export function parseXTokens(raw: string): XTokenPair {
  return JSON.parse(raw) as XTokenPair;
}

export class XApiError extends Error {
  readonly xErrorType?: string;
  readonly httpStatus?: number;
  constructor(message: string, xErrorType?: string, httpStatus?: number) {
    super(message);
    this.name = "XApiError";
    this.xErrorType = xErrorType;
    this.httpStatus = httpStatus;
  }
}

// X's auth-expiry signal — used by publishWithRefresh (x-api-provider.ts) to
// only refresh+retry on an actually-expired/invalid token, instead of
// treating every publish failure (bad request, rate limit, billing error,
// network timeout, ...) as one and burning a refresh call on it.
export function isXAuthError(error: unknown): boolean {
  if (!(error instanceof XApiError)) return false;
  if (error.httpStatus === 401) return true;
  return (
    error.xErrorType === "invalid_token" ||
    error.xErrorType === "unauthorized_client"
  );
}

// There is no separate X_OAUTH_REDIRECT_URI env var — it's derived from
// the existing NEXT_PUBLIC_APP_URL, and this path must be registered as
// the "Callback URI" in the X Developer Portal.
function redirectUri(): string {
  return `${getEnv().NEXT_PUBLIC_APP_URL}/api/integrations/x/callback`;
}

// For confidential clients, X expects Basic Auth (client_id:client_secret)
// at the token endpoint — unlike Google/Meta/TikTok, the credentials are
// carried in the header, not the body.
function basicAuthHeader(): string {
  const env = getEnv();
  const raw = `${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
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
    throw new XApiError(
      isAbort
        ? `X API request timed out (${timeoutMs}ms)`
        : `Could not reach X API: ${error instanceof Error ? error.message : String(error)}`,
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
      title?: string;
      detail?: string;
      type?: string;
      error?: string;
      error_description?: string;
    } | null;
    const message =
      errorBody?.detail ??
      errorBody?.error_description ??
      errorBody?.title ??
      `X API error (HTTP ${res.status})`;
    throw new XApiError(
      message,
      errorBody?.type ?? errorBody?.error,
      res.status,
    );
  }

  return body as T;
}

export function buildXAuthorizeUrl(
  state: string,
  codeChallenge: string,
): string {
  const env = getEnv();
  const params = new URLSearchParams({
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeXAuthCode(
  code: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const env = getEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: codeVerifier,
    client_id: env.X_CLIENT_ID,
  });
  const result = await request<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: body.toString(),
  });
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresIn: result.expires_in,
  };
}

export async function refreshXAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const env = getEnv();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.X_CLIENT_ID,
  });
  const result = await request<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: body.toString(),
  });
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresIn: result.expires_in,
  };
}

export async function fetchXProfile(
  accessToken: string,
): Promise<{ userId: string; username: string; displayName: string } | null> {
  try {
    const result = await request<{
      data?: { id?: string; username?: string; name?: string };
    }>(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = result.data;
    if (!data?.id) return null;
    return {
      userId: data.id,
      username: data.username ?? data.id,
      displayName: data.name ?? data.username ?? data.id,
    };
  } catch {
    return null;
  }
}

export async function publishXPost(input: {
  accessToken: string;
  text: string;
}): Promise<{ tweetId: string }> {
  const result = await request<{ data?: { id?: string } }>(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: input.text }),
  });
  const tweetId = result.data?.id;
  if (!tweetId) {
    throw new XApiError("X did not return a tweet id");
  }
  return { tweetId };
}
