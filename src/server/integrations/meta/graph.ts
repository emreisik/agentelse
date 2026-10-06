import "server-only";

import { createHmac } from "node:crypto";

import { getEnv } from "@/lib/env";

import { callSiteFromUrl, logAppUsage } from "./app-usage-log";
import { currentMetaCallContext } from "./call-context";
import { classifyMetaError, type MetaCallFamily } from "./error-catalog";
import { MetaApiError, metaErrorFromBody } from "./errors";
import { MetaGovernor } from "./governor";

// Bütün Meta Graph / Marketing API çağrılarının geçtiği tek çekirdek
// (docs/meta-ads-plan.md §3.1). meta-client.ts'teki `request()` buraya
// delege eder; böylece her alan fonksiyonu kendiliğinden:
//   - hesap başına kota yöneticisinden (governor) izin alır,
//   - `appsecret_proof` ekler (Meta panelinde "Require App Secret" açılabilir),
//   - Meta'nın kullanım başlıklarını kaydeder,
//   - yapısal bir MetaApiError fırlatır (kod, alt kod, blame_field_specs,
//     fbtrace_id) ve kota hatasında hesabı blok süresi kadar bekletir.
// Kısa tekrar burada yapılmaz: yazmalarda kör tekrar yoktur (niyet günlüğü),
// kota hatasında kısa tekrar hata oranını bozar.

const GRAPH_HOSTNAME = "graph.facebook.com";
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

// "/v26.0/act_123/campaigns" -> "act_123"
export function accountFromUrl(url: string): string | undefined {
  const match = /\/(act_\d+)(?:\/|\?|$)/.exec(url);
  return match?.[1];
}

export function familyFromUrl(url: string): MetaCallFamily {
  if (/\/insights(?:\?|$|\/)/.test(url)) return "ads_insights";
  if (accountFromUrl(url)) return "ads_management";
  return "graph";
}

function isGraphHost(url: string): boolean {
  try {
    return new URL(url).hostname === GRAPH_HOSTNAME;
  } catch {
    return false;
  }
}

// access_token nerede taşınıyorsa appsecret_proof da oraya eklenir: URL
// sorgusu, urlencoded gövde ya da FormData (yüklemeler).
export function withAppSecretProof(
  url: string,
  init: RequestInit | undefined,
  appSecret: string | undefined,
): { url: string; init: RequestInit | undefined } {
  if (!appSecret) return { url, init };
  const parsed = new URL(url);
  const queryToken = parsed.searchParams.get("access_token");
  if (queryToken && !parsed.searchParams.has("appsecret_proof")) {
    // Appended to the raw URL: re-serializing it would re-encode the existing
    // query (fields=id,name -> fields=id%2Cname).
    const proof = appSecretProof(queryToken, appSecret);
    return { url: `${url}&appsecret_proof=${proof}`, init };
  }
  const body = init?.body;
  if (typeof body === "string" && body.includes("access_token=")) {
    const form = new URLSearchParams(body);
    const token = form.get("access_token");
    if (token && !form.has("appsecret_proof")) {
      form.set("appsecret_proof", appSecretProof(token, appSecret));
      return { url, init: { ...init, body: form.toString() } };
    }
  }
  if (body instanceof URLSearchParams) {
    const token = body.get("access_token");
    if (token && !body.has("appsecret_proof")) {
      const form = new URLSearchParams(body);
      form.set("appsecret_proof", appSecretProof(token, appSecret));
      return { url, init: { ...init, body: form } };
    }
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const token = body.get("access_token");
    if (typeof token === "string" && !body.has("appsecret_proof")) {
      body.set("appsecret_proof", appSecretProof(token, appSecret));
    }
  }
  return { url, init };
}

function appSecret(): string | undefined {
  try {
    const secret = getEnv().META_APP_SECRET;
    return typeof secret === "string" && secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
}

export async function metaFetch<T>(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> {
  const context = currentMetaCallContext();
  const method = (init?.method ?? "GET").toUpperCase();
  const graph = isGraphHost(url);
  const account = graph ? (context.account ?? accountFromUrl(url)) : undefined;

  if (account) {
    await MetaGovernor.acquire(account, context.lane ?? "P1_USER");
  }

  const prepared = graph
    ? withAppSecretProof(url, init, appSecret())
    : { url, init };
  const limit =
    timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  let res: Response;
  try {
    res = await fetch(prepared.url, {
      ...prepared.init,
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new MetaApiError(
      isAbort
        ? `Meta API request timed out (${limit}ms)`
        : `Could not reach Meta API: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (graph && res.headers) {
    if (account) {
      await MetaGovernor.observe(account, res.headers).catch(() => undefined);
    }
    logAppUsage(context.callSite ?? callSiteFromUrl(url), res.headers);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Boş gövde sorun değil; res.ok aşağıda denetlenir.
  }

  if (!res.ok) {
    const error = metaErrorFromBody(body, res.status);
    const { class: klass } = classifyMetaError(
      error,
      context.family ?? familyFromUrl(url),
    );
    if (account && klass === "RATE_LIMIT") {
      await MetaGovernor.block(account, error, res.headers ?? null).catch(
        () => undefined,
      );
    }
    throw error;
  }

  return body as T;
}
