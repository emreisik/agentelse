import { createHash } from "node:crypto";

import type { RiscTokenIdentifier } from "./events";

// Google'ın token-revoked olayı token'ı düz yazmaz: ya ilk karakterleri
// ("prefix") ya da çift SHA-512 özetini gönderir (doğrulanmalı: gerçek bir
// olayla). Bu fonksiyon bir yenileme token'ının o kimliğe uyup uymadığını söyler.

export type TokenMatch = "match" | "no_match" | "unknown_alg";

// Çok kısa bir önek çok sayıda token'la eşleşirdi.
const MIN_PREFIX_LENGTH = 12;

function normalizeBase64(value: string): string {
  return value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
}

function sha512(input: string | Buffer): Buffer {
  return createHash("sha512").update(input).digest();
}

export function matchRiscTokenIdentifier(
  identifier: RiscTokenIdentifier,
  refreshToken: string,
): TokenMatch {
  if (identifier.alg === "prefix") {
    if (identifier.value.length < MIN_PREFIX_LENGTH) return "no_match";
    return refreshToken.startsWith(identifier.value) ? "match" : "no_match";
  }
  if (identifier.alg === "hash_base64_sha512_sha512") {
    const first = sha512(refreshToken);
    // İki zincirleme biçimi de kabul edilir: ham özet ve onaltılık metin.
    const candidates = [sha512(first), sha512(first.toString("hex"))];
    const wanted = normalizeBase64(identifier.value);
    return candidates.some(
      (digest) => normalizeBase64(digest.toString("base64")) === wanted,
    )
      ? "match"
      : "no_match";
  }
  return "unknown_alg";
}
