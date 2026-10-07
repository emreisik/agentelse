import { createPublicKey, verify } from "node:crypto";

// Google RISC jetonu için RS256 JWT doğrulaması (node:crypto; bağımlılık yok).
// Yalnız RS256 kabul edilir ("none" ve HS* asla), anahtar en az 2048 bit olmalı.

export type Jwk = {
  kty: "RSA";
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
};

export type JwtParts = {
  header: Record<string, unknown>;
  payload: unknown;
  signingInput: string;
  signature: Buffer;
};

const MAX_TOKEN_LENGTH = 16_384;
const MIN_MODULUS_BYTES = 256;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function decodeJwt(token: string): JwtParts | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;
  if (!parts.every((part) => BASE64URL.test(part))) return null;
  try {
    const header = decodeJson(headerPart);
    if (header === null || typeof header !== "object" || Array.isArray(header)) {
      return null;
    }
    return {
      header: header as Record<string, unknown>,
      payload: decodeJson(payloadPart),
      signingInput: `${headerPart}.${payloadPart}`,
      signature: Buffer.from(signaturePart, "base64url"),
    };
  } catch {
    return null;
  }
}

export function verifyRs256(parts: JwtParts, jwk: Jwk): boolean {
  try {
    if (parts.header.alg !== "RS256") return false;
    if (jwk.kty !== "RSA") return false;
    if (typeof parts.header.kid !== "string" || parts.header.kid !== jwk.kid) {
      return false;
    }
    if (jwk.alg !== undefined && jwk.alg !== "RS256") return false;
    if (Buffer.from(jwk.n, "base64url").length < MIN_MODULUS_BYTES) return false;
    const key = createPublicKey({
      key: { kty: "RSA", n: jwk.n, e: jwk.e },
      format: "jwk",
    });
    return verify(
      "RSA-SHA256",
      Buffer.from(parts.signingInput),
      key,
      parts.signature,
    );
  } catch {
    return false;
  }
}
