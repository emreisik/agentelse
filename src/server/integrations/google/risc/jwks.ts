import "server-only";

import type { Jwk } from "@/lib/google-risc/jwt";
import { gaAgencyMockMode } from "@/lib/website-analytics/agency/flags";

// Google'ın RISC jetonlarını imzaladığı açık anahtarlar (JWKS). Önbellek
// Cache-Control max-age'e uyar (5 dk - 24 sa); bilinmeyen kid en çok 5 dakikada
// bir zorunlu yeniden çekime yol açar, böylece sahte kid'li istekler Google'a
// yük bindiremez. Mock kipte Google'a hiç gidilmez.

const DEFAULT_URL = "https://www.googleapis.com/oauth2/v3/certs";
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;
const FORCED_REFETCH_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 30_000;
const TIMEOUT_MS = 5000;

export type RiscKeyDeps = {
  fetchJson?: (
    url: string,
  ) => Promise<{ status: number; body: unknown; maxAgeSec: number | null }>;
  now?: () => number;
};

type Cache = {
  keys: Map<string, Jwk>;
  fetchedAt: number;
  expiresAt: number;
};

let cache: Cache | null = null;
let lastFailureAt: number | null = null;
let inFlight: Promise<boolean> | null = null;

export function resetRiscKeyCache(): void {
  cache = null;
  lastFailureAt = null;
  inFlight = null;
}

function jwksUrl(): string {
  return process.env.GOOGLE_RISC_JWKS_URL || DEFAULT_URL;
}

async function defaultFetchJson(url: string): Promise<{
  status: number;
  body: unknown;
  maxAgeSec: number | null;
}> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const match = /max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "");
  const maxAgeSec = match?.[1] ? Number(match[1]) : null;
  const body: unknown = response.ok ? await response.json() : null;
  return { status: response.status, body, maxAgeSec };
}

function parseKeys(body: unknown): Map<string, Jwk> {
  const keys = new Map<string, Jwk>();
  const list =
    body !== null && typeof body === "object"
      ? (body as { keys?: unknown }).keys
      : null;
  if (!Array.isArray(list)) return keys;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const jwk = entry as Record<string, unknown>;
    if (
      jwk.kty === "RSA" &&
      typeof jwk.kid === "string" &&
      typeof jwk.n === "string" &&
      typeof jwk.e === "string"
    ) {
      keys.set(jwk.kid, {
        kty: "RSA",
        kid: jwk.kid,
        n: jwk.n,
        e: jwk.e,
        ...(typeof jwk.alg === "string" ? { alg: jwk.alg } : {}),
        ...(typeof jwk.use === "string" ? { use: jwk.use } : {}),
      });
    }
  }
  return keys;
}

// Çekim başarılıysa true; aynı anda gelen çağrılar tek istekte birleşir.
function refresh(deps: RiscKeyDeps, now: number): Promise<boolean> {
  if (inFlight) return inFlight;
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const run = (async () => {
    try {
      const { status, body, maxAgeSec } = await fetchJson(jwksUrl());
      const keys = status === 200 ? parseKeys(body) : new Map<string, Jwk>();
      if (keys.size === 0) {
        lastFailureAt = now;
        return false;
      }
      const ttl = Math.min(
        MAX_TTL_MS,
        Math.max(MIN_TTL_MS, maxAgeSec === null ? DEFAULT_TTL_MS : maxAgeSec * 1000),
      );
      cache = { keys, fetchedAt: now, expiresAt: now + ttl };
      lastFailureAt = null;
      return true;
    } catch {
      lastFailureAt = now;
      return false;
    }
  })().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

export async function getGoogleRiscKey(
  kid: string,
  deps: RiscKeyDeps = {},
): Promise<Jwk | null> {
  if (gaAgencyMockMode()) return null;
  const now = (deps.now ?? Date.now)();
  if (cache !== null && now < cache.expiresAt) {
    const hit = cache.keys.get(kid);
    if (hit) return hit;
    // Bilinmeyen kid: anahtar dönmüş olabilir; en çok 5 dakikada bir yeniden çek.
    if (now - cache.fetchedAt < FORCED_REFETCH_MS) return null;
  }
  if (lastFailureAt !== null && now - lastFailureAt < FAILURE_BACKOFF_MS) {
    // Başarısız çekimden hemen sonra yeniden denenmez; eski kopya varsa o kullanılır.
    return cache?.keys.get(kid) ?? null;
  }
  await refresh(deps, now);
  // Başarısızlıkta süresi dolmuş kopyadaki anahtar yine de kullanılabilir.
  return cache?.keys.get(kid) ?? null;
}
