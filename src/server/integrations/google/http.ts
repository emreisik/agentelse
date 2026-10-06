import "server-only";

import { googleRetryBudget } from "./error-catalog";
import { GoogleApiError, googleErrorFromResponse } from "./errors";

// Bütün Google çağrılarının geçtiği tek kapı (GA ve Search Console ortak).
// Düz `fetch`, SDK yok. Token asla loglanmaz.

export type GoogleRequestKind = "token" | "admin" | "read" | "report";

// Zaman aşımları işe göre ayrılır; eskiden hepsi 8 sn'ydi ve büyük rapor
// sorguları yarıda kesiliyordu.
const TIMEOUT_MS: Record<GoogleRequestKind, number> = {
  token: 10_000,
  admin: 15_000,
  read: 15_000,
  report: 30_000,
};

// TRANSIENT için iki, SERVER_ERROR için bir tekrar (googleRetryBudget);
// gecikmeler ±%25 jitter'lı.
const RETRY_DELAYS_MS = [2_000, 8_000];
// Google bundan uzun beklememizi isterse kısa tekrar yapılmaz; iş ertelenir.
const MAX_RETRY_AFTER_MS = 30_000;

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type GoogleRequestOptions = {
  kind?: GoogleRequestKind;
  timeoutMs?: number;
  // Tekrarı güvenli olmayan çağrılar (yetkilendirme kodu tek kullanımlıktır)
  // false verir.
  retry?: boolean;
  sleep?: Sleep;
  random?: () => number;
};

export async function googleFetchJson<T>(
  url: string,
  init: RequestInit = {},
  options: GoogleRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS[options.kind ?? "read"];
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchOnce<T>(url, init, timeoutMs);
    } catch (error) {
      if (!(error instanceof GoogleApiError) || options.retry === false) {
        throw error;
      }
      const delay = retryDelay(error, attempt, random);
      if (delay === null) throw error;
      await sleep(delay);
    }
  }
}

function retryDelay(
  error: GoogleApiError,
  attempt: number,
  random: () => number,
): number | null {
  if (attempt >= googleRetryBudget(error.errorClass)) return null;
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs <= MAX_RETRY_AFTER_MS ? error.retryAfterMs : null;
  }
  const base =
    RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 2_000;
  return Math.round(base * (0.75 + random() * 0.5));
}

async function fetchOnce<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GoogleApiError(
      timedOut
        ? `Google API request timed out (${timeoutMs}ms)`
        : `Could not reach Google API: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      timedOut ? { timedOut: true } : { network: true },
    );
  }

  // Boş gövde (ör. revoke'un 200'ü) sorun değildir; JSON değilse null kalır.
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    throw googleErrorFromResponse(
      res.status,
      body,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  return body as T;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
