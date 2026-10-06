import "server-only";

import {
  CRAWL_MAX_BYTES,
  CRAWL_MAX_REDIRECTS,
  CRAWL_TIMEOUT_MS,
  SEO_CRAWLER_USER_AGENT,
} from "@/lib/seo/audit-constants";
import {
  crawlHostAllowed,
  inScope,
  normalizeCrawlUrl,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import {
  GuardedTimeoutError,
  type GuardedRequest,
  type GuardedResponse,
  type GuardedTransport,
} from "@/server/security/guarded-transport";
import { assertSafeUrl, UnsafeUrlError } from "@/server/security/safe-fetch";

import { sharedHostPacer, type HostPacer } from "./pacer";
import { siteTransport } from "./transport";

// Tarayıcının tek getirme yolu (docs/google-search-console-plan.md SC-F3).
// Yönlendirmeler adım adım izlenir ve HER adımda yeniden denetlenir:
// güvenli adres, tarama kapsamı, izinli alan adı (köken ya da www/apex eşi)
// ve robots.txt. Alan adı başına aralık paylaşılan pacer'dan geçer. Hiçbir
// zaman hata fırlatmaz; sonuç her durumu alanlarıyla anlatır. Loglara yalnız
// mesaj ve alan adı yazılır, gövde ve tam adres yazılmaz.

export type SiteFetchErrorKind = "TIMEOUT" | "NETWORK" | "UNSAFE";

export type SiteFetchResult = {
  requestedUrl: string;
  // Son istenen adres; kapsam/robots/döngü yüzünden durulduysa izlenmeyen
  // yönlendirme hedefi (status o durumda son adımın 3xx'idir).
  finalUrl: string;
  status: number | null;
  hops: { url: string; status: number }[];
  redirectLoop: boolean;
  tooManyRedirects: boolean;
  leftScope: boolean;
  // İlk adres robots.txt'e takıldı: hiç istek yapılmadı.
  blockedByRobots: boolean;
  // Sonraki bir yönlendirme adımı robots.txt'e takıldı.
  blockedHop: boolean;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  xRobotsTag: string[];
  retryAfterMs: number | null;
  body: Buffer | null;
  bodySkipped: boolean;
  truncated: boolean;
  notModified: boolean;
  firstByteMs: number | null;
  elapsedMs: number;
  errorKind: SiteFetchErrorKind | null;
  error: string | null;
};

export type SiteFetchDeps = { transport: GuardedTransport; pacer: HostPacer };

export type SiteFetchOptions = {
  scope: CrawlScope;
  // null: kapsamdaki her alan adı; aksi hâlde köken ve www/apex eşi.
  originHost: string | null;
  accept: "html" | "any";
  maxBytes?: number;
  conditional?: { etag: string | null; lastModified: string | null } | null;
  isAllowed?: (url: string) => boolean | Promise<boolean>;
  // robots Crawl-delay; pacer en az 1 sn uygular.
  intervalMs?: number;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const HTML_BODY_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function firstHeader(value: string | string[] | undefined): string | null {
  return headerValues(value)[0] ?? null;
}

// Retry-After: saniye ya da HTTP tarihi; geçmiş tarih 0, bozuk değer null.
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function errorKindOf(error: unknown): SiteFetchErrorKind {
  if (error instanceof UnsafeUrlError) return "UNSAFE";
  if (error instanceof GuardedTimeoutError) return "TIMEOUT";
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || error.name === "TimeoutError") return "TIMEOUT";
  }
  return "NETWORK";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function emptyResult(url: string): SiteFetchResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: null,
    hops: [],
    redirectLoop: false,
    tooManyRedirects: false,
    leftScope: false,
    blockedByRobots: false,
    blockedHop: false,
    contentType: null,
    etag: null,
    lastModified: null,
    xRobotsTag: [],
    retryAfterMs: null,
    body: null,
    bodySkipped: false,
    truncated: false,
    notModified: false,
    firstByteMs: null,
    elapsedMs: 0,
    errorKind: null,
    error: null,
  };
}

async function allowedByRobots(
  check: SiteFetchOptions["isAllowed"],
  url: string,
): Promise<boolean> {
  if (!check) return true;
  try {
    return await check(url);
  } catch (error) {
    // Robots kararı verilemiyorsa istek yapılmaz.
    console.warn(
      `[seo-crawl] robots check failed for ${hostOf(url)}:`,
      messageOf(error),
    );
    return false;
  }
}

function applyResponse(
  result: SiteFetchResult,
  response: GuardedResponse,
): void {
  const headers = response.headers;
  result.status = response.status;
  result.contentType = firstHeader(headers["content-type"]);
  result.etag = firstHeader(headers.etag);
  result.lastModified = firstHeader(headers["last-modified"]);
  result.xRobotsTag = headerValues(headers["x-robots-tag"]);
  result.retryAfterMs = parseRetryAfter(firstHeader(headers["retry-after"]));
  result.firstByteMs = response.firstByteMs;
  result.notModified = response.status === 304;
  result.bodySkipped = response.bodySkipped;
  result.truncated = response.truncated;
  const bodyless = response.status >= 300 && response.status < 400;
  result.body = bodyless || response.bodySkipped ? null : response.body;
}

async function fetchHops(
  requestedUrl: string,
  options: SiteFetchOptions,
  deps: SiteFetchDeps,
  result: SiteFetchResult,
): Promise<void> {
  let current = normalizeCrawlUrl(requestedUrl);
  if (!current) {
    result.errorKind = "UNSAFE";
    result.error = "Invalid URL";
    return;
  }
  result.finalUrl = current;

  const request: Omit<GuardedRequest, "timeoutMs" | "headers"> = {
    userAgent: SEO_CRAWLER_USER_AGENT,
    accept: options.accept === "html" ? HTML_ACCEPT : "*/*",
    maxBytes: options.maxBytes ?? CRAWL_MAX_BYTES,
    ...(options.accept === "html" ? { bodyContentTypes: HTML_BODY_TYPES } : {}),
  };
  const visited = new Set<string>();
  // Süre sınırı yalnız ağ süresini sayar; pacer beklemeleri dahil değil.
  let networkMs = 0;

  for (let hop = 0; ; hop += 1) {
    let url: URL;
    try {
      url = assertSafeUrl(current);
    } catch (error) {
      result.errorKind = "UNSAFE";
      result.error = messageOf(error);
      return;
    }

    const hostOk =
      options.originHost === null ||
      crawlHostAllowed(current, options.originHost);
    if (!inScope(current, options.scope) || !hostOk) {
      result.leftScope = true;
      return;
    }

    if (!(await allowedByRobots(options.isAllowed, current))) {
      if (hop === 0) result.blockedByRobots = true;
      else result.blockedHop = true;
      return;
    }

    visited.add(current);
    await deps.pacer.wait(url.hostname, options.intervalMs);

    const remaining = CRAWL_TIMEOUT_MS - networkMs;
    if (remaining <= 0) {
      result.errorKind = "TIMEOUT";
      result.error = "The site took too long to respond";
      return;
    }

    const conditional = hop === 0 ? options.conditional : null;
    const headers: Record<string, string> = {};
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) {
      headers["if-modified-since"] = conditional.lastModified;
    }

    const startedAt = Date.now();
    let response: GuardedResponse;
    try {
      response = await deps.transport(url, {
        ...request,
        headers,
        timeoutMs: remaining,
      });
    } catch (error) {
      networkMs += Date.now() - startedAt;
      result.elapsedMs = networkMs;
      result.errorKind = errorKindOf(error);
      result.error = messageOf(error);
      if (result.errorKind !== "UNSAFE") {
        console.warn(
          `[seo-crawl] fetch failed for ${url.hostname} (${result.errorKind}):`,
          result.error,
        );
      }
      return;
    }
    networkMs += Date.now() - startedAt;
    result.elapsedMs = networkMs;

    result.finalUrl = current;
    result.hops.push({ url: current, status: response.status });
    applyResponse(result, response);

    if (!REDIRECT_STATUSES.has(response.status)) return;

    const location = firstHeader(response.headers.location);
    // Hedefsiz yönlendirme: son adım 3xx olarak kalır.
    if (!location) return;
    const next = normalizeCrawlUrl(location, current);
    if (!next) {
      result.leftScope = true;
      return;
    }
    result.finalUrl = next;
    if (visited.has(next)) {
      result.redirectLoop = true;
      return;
    }
    if (hop + 1 > CRAWL_MAX_REDIRECTS) {
      result.tooManyRedirects = true;
      return;
    }
    current = next;
  }
}

export async function siteFetch(
  url: string,
  options: SiteFetchOptions,
  deps?: SiteFetchDeps,
): Promise<SiteFetchResult> {
  const result = emptyResult(url);
  try {
    const resolved = deps ?? {
      transport: siteTransport(),
      pacer: sharedHostPacer,
    };
    await fetchHops(url, options, resolved, result);
  } catch (error) {
    // Beklenmeyen bir hata (pacer, taşıyıcı seçimi) da sonuç olarak döner.
    result.errorKind = errorKindOf(error);
    result.error = messageOf(error);
    if (result.errorKind !== "UNSAFE") {
      console.error(
        `[seo-crawl] unexpected fetch failure for ${hostOf(url)}:`,
        result.error,
      );
    }
  }
  return result;
}
