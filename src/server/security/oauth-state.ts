import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

// CSRF protection for the `state` parameter of the Google OAuth
// authorization-code flow — a time-limited token signed with AUTH_SECRET,
// instead of a separate DB table/cookie. The standard OAuth2 state pattern
// requires no more than this.
const STATE_TTL_MS = 10 * 60_000;

type OAuthStatePayload = {
  projectId: string;
  userId: string;
  issuedAt: number;
  // Only filled in by providers that use PKCE (TikTok, X and Google) — see
  // pkce.ts. Meta/LinkedIn never send this field.
  codeVerifier?: string;
  // Only filled in by Google — which of the two Google integrations
  // (analytics / search_console) this grant is for, since both share one
  // callback URL. See google-client.ts's GOOGLE_SERVICES.
  service?: string;
  // Only filled in by Meta's Instagram service — "instagram" when the grant
  // is made through Instagram Login (no Facebook account), absent for the
  // Facebook Login route. Both share one callback URL.
  login?: string;
  // Only filled in by Google's optional upgrade flow (GA-F7) — "edit" when
  // the grant asks for analytics.edit on top of the connected read access.
  upgrade?: string;
};

function sign(payloadB64: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

export function signOAuthState(
  input: Pick<
    OAuthStatePayload,
    "projectId" | "userId" | "codeVerifier" | "service" | "login" | "upgrade"
  >,
): string {
  const payload: OAuthStatePayload = { ...input, issuedAt: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyOAuthState(
  token: string,
): Pick<
  OAuthStatePayload,
  "projectId" | "userId" | "codeVerifier" | "service" | "login" | "upgrade"
> | null {
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;

  const expectedSig = sign(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload.projectId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.issuedAt !== "number" ||
    (payload.codeVerifier !== undefined &&
      typeof payload.codeVerifier !== "string") ||
    (payload.service !== undefined && typeof payload.service !== "string") ||
    (payload.login !== undefined && typeof payload.login !== "string") ||
    (payload.upgrade !== undefined && typeof payload.upgrade !== "string")
  ) {
    return null;
  }
  if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;

  return {
    projectId: payload.projectId,
    userId: payload.userId,
    codeVerifier: payload.codeVerifier,
    service: payload.service,
    login: payload.login,
    upgrade: payload.upgrade,
  };
}
