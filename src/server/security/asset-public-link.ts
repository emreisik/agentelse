import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";

// Dış sağlayıcıların (Meta Graph API gibi Instagram/Ads sunucuları) normal
// /api/assets/[assetId] rotasına requireUser+requireProjectAccess ile giriş
// yapması mümkün değil — bu yüzden AUTH_SECRET ile imzalanmış, kısa ömürlü,
// TEK bir assetId'ye kilitli bir token üretir (oauth-state.ts'teki aynı
// imzalama deseni). Token süresi dolunca/asset değişince eski linkler
// otomatik geçersiz kalır, kalıcı bir "herkese açık" URL asla oluşmaz.
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

// INSTAGRAM_PUBLISH gibi capability'lerin payload.imageUrl'i için — Meta'nın
// sunucuları buradan doğrudan (auth'suz) indirebilir.
export function buildAssetPublicUrl(assetId: string): string {
  const token = signAssetPublicToken(assetId);
  const env = getEnv();
  const base = env.PUBLIC_ASSET_BASE_URL || env.NEXT_PUBLIC_APP_URL;
  return `${base}/api/public/assets/${assetId}?token=${token}`;
}
