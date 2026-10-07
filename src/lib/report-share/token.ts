import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Paylaşım belirteci: `${id}.${secret}`. Gizli parça 32 rastgele bayttır
// (base64url, 43 karakter); veritabanında yalnız sha256 özeti saklanır.

const ID_PATTERN = /^[a-z0-9]{20,40}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateShareSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShareSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function formatShareToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

// Katı ayrıştırma: tek nokta, kimlik ve gizli parça kalıba uymalı.
export function parseShareToken(
  token: string,
): { id: string; secret: string } | null {
  if (typeof token !== "string" || token.length > 120) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [id, secret] = parts as [string, string];
  if (!ID_PATTERN.test(id) || !SECRET_PATTERN.test(secret)) return null;
  return { id, secret };
}

// Sabit zamanlı karşılaştırma; uzunluklar farklıysa fırlatmadan false.
export function verifyShareSecret(
  secret: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashShareSecret(secret), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
