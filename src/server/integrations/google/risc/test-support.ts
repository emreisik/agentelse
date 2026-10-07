import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import type { Jwk } from "@/lib/google-risc/jwt";

// Yalnız testler için: RSA anahtar çifti üretir, JWK dışa aktarır ve verilen
// iddialarla RS256 imzalı bir RISC jetonu üretir. Üretimde içe aktarılmaz.

export type TestRiscKey = {
  kid: string;
  jwk: Jwk;
  privateKey: KeyObject;
};

export function createTestRiscKey(kid = "test-kid", modulusLength = 2048): TestRiscKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength });
  const exported = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKey,
    jwk: {
      kty: "RSA",
      kid,
      n: String(exported.n),
      e: String(exported.e),
      alg: "RS256",
      use: "sig",
    },
  };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export type TestRiscClaims = {
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  jti?: string;
  events?: Record<string, unknown>;
};

export const TEST_RISC_AUDIENCE = "test-client.apps.googleusercontent.com";

// Varsayılan: sonda eğik çizgili Google iss'i, bir "tokens-revoked" olayı.
export function signTestRiscToken(
  key: TestRiscKey,
  claims: TestRiscClaims = {},
  header: Record<string, unknown> = {},
): string {
  const payload = {
    iss: "https://accounts.google.com/",
    aud: TEST_RISC_AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    events: {
      "https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked": {
        subject: {
          subject_type: "iss-sub",
          iss: "https://accounts.google.com/",
          sub: "google-sub-1",
        },
      },
    },
    ...claims,
  };
  const headerPart = b64url({ alg: "RS256", typ: "secevent+jwt", kid: key.kid, ...header });
  const signingInput = `${headerPart}.${b64url(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}
