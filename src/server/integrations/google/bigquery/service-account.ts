import "server-only";

import { createPrivateKey, createSign } from "node:crypto";

import { GoogleApiError } from "../errors";
import { googleFetchJson } from "../http";
import { BigQueryError, classifyBigQueryError } from "./errors";

// Tek paylaşımlı Google servis hesabı (env GOOGLE_BIGQUERY_SA_KEY): JWT
// (RS256, node:crypto) access token ile değiştirilir. Özel anahtar hiçbir
// zaman loglanmaz, hata mesajına ya da dönüş değerine girmez.

export type ServiceAccountKey = {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

export const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
// Token süresi dolmadan bu kadar önce yenilenir.
const REFRESH_MARGIN_MS = 5 * 60_000;

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Anahtar dosyası ham JSON ya da base64 JSON olarak verilir.
function readKeyJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed = tryParseJson(trimmed);
  if (parsed === null) {
    parsed = tryParseJson(Buffer.from(trimmed, "base64").toString("utf8"));
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

// Yalnız Google'ın kendi token adresine gidilir; başka bir adres yok sayılır.
function safeTokenUri(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TOKEN_URI;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === "https:" &&
      (host === "googleapis.com" || host.endsWith(".googleapis.com"))
      ? value
      : DEFAULT_TOKEN_URI;
  } catch {
    return DEFAULT_TOKEN_URI;
  }
}

export function parseServiceAccountKey(
  raw: string | undefined,
): ServiceAccountKey | null {
  if (!raw) return null;
  const json = readKeyJson(raw);
  if (!json || json.type !== "service_account") return null;
  const email = json.client_email;
  const key = json.private_key;
  if (typeof email !== "string" || !email) return null;
  if (typeof key !== "string" || !key) return null;
  // Env'e yapıştırılan anahtarlarda satır sonları çoğu zaman düz "\n" gelir.
  const privateKey = key.replace(/\\n/g, "\n");
  try {
    createPrivateKey(privateKey);
  } catch {
    return null;
  }
  return {
    clientEmail: email,
    privateKey,
    tokenUri: safeTokenUri(json.token_uri),
  };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signServiceAccountJwt(
  key: ServiceAccountKey,
  input: { scope: string; now: Date; lifetimeSec?: number },
): string {
  const iat = Math.floor(input.now.getTime() / 1000);
  const exp = iat + (input.lifetimeSec ?? 3600);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: input.scope,
      aud: key.tokenUri,
      iat,
      exp,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(key.privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

export type TokenProvider = {
  email: string | null;
  configured: boolean;
  getToken(): Promise<string>;
};

type ExchangeResult = { accessToken: string; expiresInSec: number };

async function defaultExchange(
  key: ServiceAccountKey,
  assertion: string,
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await googleFetchJson<{
    access_token?: unknown;
    expires_in?: unknown;
  }>(
    key.tokenUri,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { kind: "token", retry: false },
  );
  if (typeof response?.access_token !== "string" || !response.access_token) {
    throw new BigQueryError("SA_AUTH");
  }
  const expires = Number(response.expires_in);
  return {
    accessToken: response.access_token,
    expiresInSec: Number.isFinite(expires) && expires > 0 ? expires : 3600,
  };
}

// Token değişimi hatası, geçici (ağ, 5xx, kota) değilse servis hesabı
// kimlik doğrulaması sorunudur.
function exchangeError(error: unknown): BigQueryError {
  if (error instanceof BigQueryError) return error;
  if (error instanceof GoogleApiError) {
    const classified = classifyBigQueryError(error);
    if (
      classified.code === "TIMEOUT" ||
      classified.code === "UNAVAILABLE" ||
      classified.code === "RATE_LIMIT"
    ) {
      return classified;
    }
  }
  return new BigQueryError("SA_AUTH");
}

export function createServiceAccountTokenProvider(
  options: {
    key?: ServiceAccountKey | null;
    now?: () => Date;
    exchange?: (
      key: ServiceAccountKey,
      assertion: string,
    ) => Promise<ExchangeResult>;
  } = {},
): TokenProvider {
  const key =
    options.key !== undefined
      ? options.key
      : parseServiceAccountKey(process.env.GOOGLE_BIGQUERY_SA_KEY);
  const now = options.now ?? (() => new Date());
  const exchange = options.exchange ?? defaultExchange;

  let cached: { token: string; expiresAtMs: number } | null = null;
  // Eşzamanlı çağrılar tek değişimi paylaşır.
  let inflight: Promise<string> | null = null;

  async function refresh(serviceKey: ServiceAccountKey): Promise<string> {
    try {
      const issued = now();
      const assertion = signServiceAccountJwt(serviceKey, {
        scope: BIGQUERY_SCOPE,
        now: issued,
      });
      const result = await exchange(serviceKey, assertion);
      cached = {
        token: result.accessToken,
        expiresAtMs: issued.getTime() + result.expiresInSec * 1000,
      };
      return result.accessToken;
    } catch (error) {
      throw exchangeError(error);
    }
  }

  return {
    email: key?.clientEmail ?? null,
    configured: key !== null,
    async getToken() {
      if (!key) throw new BigQueryError("NOT_CONFIGURED");
      if (cached && now().getTime() < cached.expiresAtMs - REFRESH_MARGIN_MS) {
        return cached.token;
      }
      if (!inflight) {
        inflight = refresh(key).finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
