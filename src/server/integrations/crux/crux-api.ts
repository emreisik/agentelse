import "server-only";

import {
  parseCruxHistory,
  parseCruxRecord,
  type CwvRecord,
} from "@/lib/seo/cwv";
import { cruxApiKey, seoMockMode } from "@/lib/seo/health-flags";

import { mockCruxHistory, mockCruxRecord } from "./crux-mock";

// Chrome UX Report istemcisi (docs/search-health.md "Core Web Vitals"). CrUX
// herkese açık saha verisidir; istek kısıtlı GOOGLE_API_KEY ile yapılır.
// Anahtar YALNIZ X-Goog-Api-Key başlığında gider: URL'de, hata mesajında ya
// da logda asla görünmez (hata mesajlarına yanıt gövdesi de konmaz). Metrik
// listesi gönderilmez (hepsi gelir). 404 = bu hedef için veri yok. Mock
// modunda fetch hiç çağrılmaz.

export const CRUX_RECORD_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const CRUX_HISTORY_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";

const TIMEOUT_MS = 15_000;

export type CruxTarget = { origin: string } | { url: string };

// Anahtar eksik, geçersiz ya da API'ye kapalı: iş durur, operatör sayaçta görür.
export class CruxBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CruxBlockedError";
  }
}

// 429 ve diğer hatalar; mesajda yalnız HTTP durumu bulunur.
export class CruxApiError extends Error {
  readonly httpStatus: number | null;

  constructor(message: string, httpStatus: number | null) {
    super(message);
    this.name = "CruxApiError";
    this.httpStatus = httpStatus;
  }
}

type CruxOptions = { fetchImpl?: typeof fetch };

async function post(
  endpoint: string,
  target: CruxTarget,
  formFactor: "PHONE" | "DESKTOP",
  options: CruxOptions,
): Promise<unknown> {
  const key = cruxApiKey();
  if (!key) throw new CruxBlockedError("Chrome UX Report API key is not set");
  const fetchImpl = options.fetchImpl ?? fetch;
  const body =
    "origin" in target
      ? { origin: target.origin, formFactor }
      : { url: target.url, formFactor };
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new CruxApiError(
      timedOut
        ? `Chrome UX Report request timed out (${TIMEOUT_MS}ms)`
        : "Could not reach the Chrome UX Report API",
      null,
    );
  }
  if (res.status === 404) return null;
  const text = await res.text().catch(() => "");
  if (res.status === 403 || (res.status === 400 && /API key/i.test(text))) {
    throw new CruxBlockedError(
      `Chrome UX Report API refused the key (HTTP ${res.status})`,
    );
  }
  if (!res.ok) {
    throw new CruxApiError(
      `Chrome UX Report API error (HTTP ${res.status})`,
      res.status,
    );
  }
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new CruxApiError(
      "Chrome UX Report API returned invalid JSON",
      res.status,
    );
  }
}

export async function queryCruxRecord(
  target: CruxTarget,
  formFactor: "PHONE" | "DESKTOP",
  options: CruxOptions = {},
): Promise<CwvRecord | null> {
  const raw = seoMockMode()
    ? mockCruxRecord(target, formFactor)
    : await post(CRUX_RECORD_ENDPOINT, target, formFactor, options);
  return raw === null ? null : parseCruxRecord(raw, formFactor);
}

export async function queryCruxHistory(
  target: CruxTarget,
  formFactor: "PHONE" | "DESKTOP",
  options: CruxOptions = {},
): Promise<CwvRecord[]> {
  const raw = seoMockMode()
    ? mockCruxHistory(target, formFactor)
    : await post(CRUX_HISTORY_ENDPOINT, target, formFactor, options);
  return raw === null ? [] : parseCruxHistory(raw, formFactor);
}
