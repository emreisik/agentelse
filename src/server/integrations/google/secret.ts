import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret } from "../../security/crypto";

// Google yenileme token'ları için sürümlü şifreleme (docs/website-agency.md
// "Anahtar döndürme"). GOOGLE_TOKEN_KEYS = "k2:<64 hex>,k1:<64 hex>": ilk
// anahtar yazmada, hepsi okumada kullanılır. Anahtar kimliği şifreli metnin
// önekindedir: gk1:<keyId>:<iv.tag.data>. Böylece IntegrationCredential'a
// sütun eklenmez; "Use existing connection" kopyası (şifreli metin eşitliği)
// bozulmaz. Önekli olmayan eski kayıtlar bugünkü gibi okunur. Env tanımsızsa
// encryptGoogleSecret eski biçimi bayt bayt aynı üretir.
// Meta'nın security/key-ring.ts dosyasına dokunulmaz.

export const GOOGLE_SECRET_PREFIX = "gk1:";
export const GOOGLE_LEGACY_KEY_ID = "legacy";

export type GoogleKeyRing = {
  current: string;
  keys: ReadonlyMap<string, Buffer>;
};

export class GoogleSecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleSecretKeyError";
  }
}

// Anahtar halkası çağrı anında env'den okunur (önbellek yok). Boş değer null,
// bozuk değer hata fırlatır.
export function parseGoogleKeyRing(
  raw: string | undefined,
): GoogleKeyRing | null {
  if (!raw?.trim()) return null;
  const keys = new Map<string, Buffer>();
  let current: string | null = null;
  for (const part of raw.split(",")) {
    const [id, hex, extra] = part.trim().split(":");
    if (
      !id ||
      !hex ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
      !/^[0-9a-f]{64}$/i.test(hex)
    ) {
      throw new Error(
        "GOOGLE_TOKEN_KEYS must look like keyId:<64 hex chars>[,keyId:<64 hex chars>]",
      );
    }
    if (id === GOOGLE_LEGACY_KEY_ID) {
      throw new Error(
        `"${GOOGLE_LEGACY_KEY_ID}" is reserved in GOOGLE_TOKEN_KEYS`,
      );
    }
    if (keys.has(id)) {
      throw new Error("GOOGLE_TOKEN_KEYS contains a duplicate key id");
    }
    keys.set(id, Buffer.from(hex, "hex"));
    current ??= id;
  }
  return current ? { current, keys } : null;
}

// Bozuk halka bir kez loglanır (anahtar değeri asla yazılmaz).
let malformedLogged = false;

function safeRing(raw: string | undefined): GoogleKeyRing | null {
  try {
    return parseGoogleKeyRing(raw);
  } catch {
    if (!malformedLogged) {
      malformedLogged = true;
      console.error(
        "[google-secret] GOOGLE_TOKEN_KEYS is malformed; falling back to the legacy key",
      );
    }
    return null;
  }
}

export function googleKeyRingConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return safeRing(env.GOOGLE_TOKEN_KEYS) !== null;
}

export function googleSecretPrefixFor(keyId: string): string {
  return `${GOOGLE_SECRET_PREFIX}${keyId}:`;
}

function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64"))
    .join(".");
}

function open(payload: string, key: Buffer): string {
  const [iv, tag, data] = payload.split(".");
  if (!iv || !tag || !data) {
    throw new GoogleSecretKeyError("Malformed encrypted secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptGoogleSecret(plaintext: string): string {
  const ring = safeRing(process.env.GOOGLE_TOKEN_KEYS);
  const key = ring?.keys.get(ring.current);
  if (!ring || !key) return encryptSecret(plaintext);
  return googleSecretPrefixFor(ring.current) + seal(plaintext, key);
}

// "gk1:<keyId>:<rest>" -> { keyId, rest }; başka biçim null.
function splitPrefixed(
  payload: string,
): { keyId: string; rest: string } | null {
  if (!payload.startsWith(GOOGLE_SECRET_PREFIX)) return null;
  const body = payload.slice(GOOGLE_SECRET_PREFIX.length);
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  return { keyId: body.slice(0, colon), rest: body.slice(colon + 1) };
}

export function decryptGoogleSecret(payload: string): string {
  if (!payload.startsWith(GOOGLE_SECRET_PREFIX)) return decryptSecret(payload);
  const parts = splitPrefixed(payload);
  if (!parts) throw new GoogleSecretKeyError("Malformed encrypted secret");
  let ring: GoogleKeyRing | null;
  try {
    ring = parseGoogleKeyRing(process.env.GOOGLE_TOKEN_KEYS);
  } catch {
    throw new GoogleSecretKeyError("GOOGLE_TOKEN_KEYS is malformed");
  }
  const key = ring?.keys.get(parts.keyId);
  if (!key) {
    throw new GoogleSecretKeyError(
      `Encryption key "${parts.keyId}" is not configured (GOOGLE_TOKEN_KEYS)`,
    );
  }
  return open(parts.rest, key);
}

export function googleSecretKeyId(payload: string): string {
  return splitPrefixed(payload)?.keyId ?? GOOGLE_LEGACY_KEY_ID;
}

// Kayıt güncel anahtarla yazılmış mı? Halka yoksa ya da şifreli metin boşsa
// döndürülecek bir şey yoktur.
export function googleSecretNeedsRotation(payload: string): boolean {
  if (!payload) return false;
  const ring = safeRing(process.env.GOOGLE_TOKEN_KEYS);
  if (!ring) return false;
  return googleSecretKeyId(payload) !== ring.current;
}
