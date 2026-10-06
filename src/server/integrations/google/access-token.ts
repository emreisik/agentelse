import "server-only";

import { createHash } from "node:crypto";

// Access token'lar yalnız süreç belleğinde tutulur (DB'ye ve loglara asla
// yazılmaz). Eskiden her Google çağrısı yeni bir token alıyordu; artık bir
// token, bitişinden 5 dk öncesine kadar yeniden kullanılır ve aynı anda gelen
// istekler tek bir yenilemeyi bekler (tek uçuş).

const SAFETY_MS = 5 * 60_000;

type Entry = { accessToken: string; expiresAt: number };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string>>();

// Yeniden bağlanınca refresh token (ve şifreli metni) değişir; anahtar da
// değişsin diye şifreli metnin kısa özeti eklenir.
export function googleAccessTokenKey(
  credentialId: string,
  encryptedSecret: string,
): string {
  const digest = createHash("sha256")
    .update(encryptedSecret)
    .digest("base64url")
    .slice(0, 16);
  return `${credentialId}:${digest}`;
}

export async function cachedGoogleAccessToken(
  key: string,
  mint: () => Promise<{ accessToken: string; expiresIn: number }>,
  now: () => number = Date.now,
): Promise<string> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt - SAFETY_MS > now()) return hit.accessToken;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = mint()
    .then(({ accessToken, expiresIn }) => {
      cache.set(key, { accessToken, expiresAt: now() + expiresIn * 1000 });
      return accessToken;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// Disconnect ve invalid_grant sonrası o bağlantının token'ları unutulur.
export function forgetGoogleAccessTokens(credentialId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${credentialId}:`)) cache.delete(key);
  }
}
