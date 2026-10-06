import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret } from "./crypto";

// Meta bağlantı token'ları için ayrı ve sürümlü şifreleme (docs/meta-ads-plan.md
// F8). META_TOKEN_KEYS = "k2:<64 hex>,k1:<64 hex>": ilk anahtar yazmada
// kullanılır, hepsi okumada. Tanımlı değilse "legacy" = ortak
// TEMPORARY_SECRET_ENCRYPTION_KEY. Anahtar değişince eski kayıtlar okunur ve
// yeni anahtarla yeniden yazılır (needsRotation).

export const LEGACY_KEY_ID = "legacy";

type KeyRing = { current: string; keys: Map<string, Buffer> };

export function parseKeyRing(raw: string | undefined): KeyRing | null {
  if (!raw?.trim()) return null;
  const keys = new Map<string, Buffer>();
  let current: string | null = null;
  for (const part of raw.split(",")) {
    const [id, hex] = part.trim().split(":");
    if (!id || !hex || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || !/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error("META_TOKEN_KEYS must look like keyId:<64 hex chars>[,keyId:<64 hex chars>]");
    }
    if (id === LEGACY_KEY_ID) throw new Error(`"${LEGACY_KEY_ID}" is reserved in META_TOKEN_KEYS`);
    keys.set(id, Buffer.from(hex, "hex"));
    current ??= id;
  }
  return current ? { current, keys } : null;
}

function ring(): KeyRing | null {
  return parseKeyRing(process.env.META_TOKEN_KEYS);
}

function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
}

function open(payload: string, key: Buffer): string {
  const [iv, tag, data] = payload.split(".");
  if (!iv || !tag || !data) throw new Error("Malformed encrypted token");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

export function encryptToken(plaintext: string): { encryptedSecret: string; keyId: string } {
  const keys = ring();
  if (!keys) return { encryptedSecret: encryptSecret(plaintext), keyId: LEGACY_KEY_ID };
  return {
    encryptedSecret: seal(plaintext, keys.keys.get(keys.current)!),
    keyId: keys.current,
  };
}

export function decryptToken(encryptedSecret: string, keyId: string): string {
  if (keyId === LEGACY_KEY_ID) return decryptSecret(encryptedSecret);
  const key = ring()?.keys.get(keyId);
  if (!key) throw new Error(`Encryption key "${keyId}" is not configured (META_TOKEN_KEYS)`);
  return open(encryptedSecret, key);
}

// Kayıt güncel anahtarla mı yazılmış?
export function needsRotation(keyId: string): boolean {
  const keys = ring();
  return keys ? keyId !== keys.current : keyId !== LEGACY_KEY_ID;
}
