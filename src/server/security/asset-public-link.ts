import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

// External providers (Instagram/Ads servers like the Meta Graph API) can't
// authenticate to the normal /api/assets/[assetId] route via
// requireUser+requireProjectAccess — so this generates a short-lived token
// signed with AUTH_SECRET, locked to a SINGLE assetId (the same signing
// pattern as oauth-state.ts). Once the token expires / the asset changes,
// old links automatically become invalid, and a permanent "public" URL is
// never created.
const LINK_TTL_MS = 15 * 60_000;

type AssetLinkPayload = {
  assetId: string;
  issuedAt: number;
};

function sign(payloadB64: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET)
    .update(payloadB64)
    .digest("base64url");
}

export function signAssetPublicToken(assetId: string): string {
  const payload: AssetLinkPayload = { assetId, issuedAt: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyAssetPublicToken(
  assetId: string,
  token: string,
): boolean {
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;

  const expectedSig = sign(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return false;
  }

  let payload: AssetLinkPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (
    typeof payload.assetId !== "string" ||
    typeof payload.issuedAt !== "number"
  ) {
    return false;
  }
  if (payload.assetId !== assetId) return false;
  if (Date.now() - payload.issuedAt > LINK_TTL_MS) return false;

  return true;
}

// For the payload.imageUrl of capabilities like INSTAGRAM_PUBLISH — Meta's
// servers can download directly from here (without auth).
export function buildAssetPublicUrl(assetId: string): string {
  const token = signAssetPublicToken(assetId);
  const env = getEnv();
  const base = env.PUBLIC_ASSET_BASE_URL || env.NEXT_PUBLIC_APP_URL;
  return `${base}/api/public/assets/${assetId}?token=${token}`;
}
