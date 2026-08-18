import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

// Google OAuth authorization-code akışının `state` parametresi için CSRF
// koruması — ayrı bir DB tablosu/cookie yerine AUTH_SECRET ile imzalanmış,
// süreli bir token. Standart OAuth2 state deseni bu kadarını gerektirir.
const STATE_TTL_MS = 10 * 60_000;

type OAuthStatePayload = {
  projectId: string;
  userId: string;
  issuedAt: number;
};

function sign(payloadB64: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

export function signOAuthState(
  input: Pick<OAuthStatePayload, "projectId" | "userId">,
): string {
  const payload: OAuthStatePayload = { ...input, issuedAt: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyOAuthState(
  token: string,
): Pick<OAuthStatePayload, "projectId" | "userId"> | null {
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
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }
  if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;

  return { projectId: payload.projectId, userId: payload.userId };
}
