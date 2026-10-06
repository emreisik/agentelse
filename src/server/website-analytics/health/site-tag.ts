import "server-only";

import {
  parseRobots,
  robotsAllows,
} from "@/lib/website-analytics/health/robots";
import {
  combinePageScans,
  mockSiteTagResult,
  scanPageTags,
  type GaPageTagScan,
} from "@/lib/website-analytics/health/tag-scan";
import type { GaSiteTagResult } from "@/lib/website-analytics/health/types";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import {
  safeFetch,
  UnsafeUrlError,
  type SafeFetchOptions,
  type Transport,
} from "@/server/security/safe-fetch";

// GA-F3 MH3 site etiketi taraması (docs/measurement-health.md "Site
// taraması"): haftada bir (ya da 'I fixed it' ile) projenin alan adında
// robots.txt + ana sayfa + en çok 5 açılış sayfası, saniyede en çok bir
// istek, kendi kimliğimizle (AgentelseSiteCheck). Bütün istekler safeFetch'ten
// geçer (SSRF, boyut ve süre sınırı). Sonuçta adres yoktur; yalnız kimlikler,
// sayılar ve boolean'lar. Mock modda siteye gidilmez.

export const GA_SITE_CHECK_UA =
  "AgentelseSiteCheck/1.0 (+https://agentelse.com/bot)";
export const GA_SITE_CHECK_TOKEN = "AgentelseSiteCheck";

export type SiteFetchResult = {
  status: number;
  finalUrl: string;
  body: string;
};
export type SiteFetcher = (url: string) => Promise<SiteFetchResult | null>;

const REQUEST_GAP_MS = 1_000;
const SCAN_BUDGET_MS = 45_000;

function fetchOptions(
  kind: "html" | "robots",
): SafeFetchOptions & { userAgent: string } {
  const common = {
    truncate: true,
    timeoutMs: 8_000,
    hardDeadline: true,
    maxRedirects: 2,
    userAgent: GA_SITE_CHECK_UA,
  };
  if (kind === "html") {
    return {
      ...common,
      maxBytes: 1_500_000,
      accept: "text/html,application/xhtml+xml",
      allowedContentTypes: /^(text\/html|application\/xhtml\+xml)/i,
    };
  }
  return { ...common, maxBytes: 500_000, accept: "text/plain,*/*" };
}

// Hata adı ya da kodu; mesajlar adres/alan adı içerebileceği için loglanmaz.
function errorLabel(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return code;
    if (error instanceof Error) return error.name;
  }
  return "unknown";
}

// safeFetch 2xx dışını "HTTP <kod>" hatasıyla bildirir: durum kodu korunur
// (robots.txt 4xx = her şeye izin). Diğer hatalar null.
export function defaultSiteFetcher(
  kind: "html" | "robots",
  transport?: Transport /* from safe-fetch; test seam */,
): SiteFetcher {
  const options: SafeFetchOptions & { userAgent: string } = fetchOptions(kind);
  return async (url) => {
    // Yönlendirme yalnız aynı siteye (www ikizi) izlenir: yol (GA açılış
    // sayfası) başka bir sunucuya hiç gönderilmez.
    let startHost: string;
    try {
      startHost = new URL(url).hostname;
    } catch {
      return null;
    }
    try {
      const result = await safeFetch(
        url,
        {
          ...options,
          allowRedirect: (target) => sameSite(target.toString(), startHost),
        },
        transport,
      );
      return {
        status: result.status,
        finalUrl: result.url,
        body: result.body.toString("utf8"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const http = /HTTP (\d{3})/.exec(message);
      if (http) return { status: Number(http[1]), finalUrl: url, body: "" };
      if (!(error instanceof UnsafeUrlError)) {
        console.warn(
          `[ga-site-check] ${kind} fetch failed (${errorLabel(error)})`,
        );
      }
      return null;
    }
  };
}

function sameSite(finalUrl: string, host: string): boolean {
  let finalHost: string;
  try {
    finalHost = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.toLowerCase().replace(/^www\./, "");
  return finalHost === bare || finalHost === `www.${bare}`;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchSafely(
  fetcher: SiteFetcher,
  url: string,
): Promise<SiteFetchResult | null> {
  try {
    return await fetcher(url);
  } catch {
    return null;
  }
}

export async function scanSiteTags(
  input: {
    host: string;
    paths: string[];
    expectedId: string | null;
    now: Date;
  },
  deps: {
    fetchHtml?: SiteFetcher;
    fetchRobots?: SiteFetcher;
    sleep?: (ms: number) => Promise<void>;
    clock?: () => number;
  } = {},
): Promise<GaSiteTagResult> {
  const at = input.now.toISOString();
  const host = input.host.toLowerCase();
  const empty = (outcome: GaSiteTagResult["outcome"]): GaSiteTagResult => ({
    ...combinePageScans({ at, host, expectedId: input.expectedId, pages: [] }),
    outcome,
  });

  // Gerçek getiriciler verilmemişse mock modda ağa hiç çıkılmaz.
  if (!deps.fetchHtml && !deps.fetchRobots && gaMockMode()) {
    return mockSiteTagResult({ at, host, expectedId: input.expectedId });
  }

  const fetchHtml = deps.fetchHtml ?? defaultSiteFetcher("html");
  const fetchRobots = deps.fetchRobots ?? defaultSiteFetcher("robots");
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const origin = `https://${host}`;

  // 1. robots.txt: ulaşılamıyor ya da 5xx → hiçbir sayfa getirilmez
  // (Google'ın kuralı: sunucu hatası tam yasak sayılır). 4xx → her şeye izin.
  const robots = await fetchSafely(fetchRobots, `${origin}/robots.txt`);
  if (!robots || robots.status >= 500) return empty("fetch_failed");
  const rules = parseRobots(
    robots.status >= 200 && robots.status < 300 ? robots.body : "",
  );

  // 2. Kendi kimliğimize (yoksa *) izin verilen yollar.
  const paths = input.paths.filter((path) =>
    robotsAllows(rules, GA_SITE_CHECK_TOKEN, path),
  );
  if (paths.length === 0) return empty("blocked_by_robots");

  // 3. Sırayla, her istekten önce 1 sn; 45 sn bütçe dolunca durulur
  // (getirilmeyen sayfa başarısız sayılmaz).
  const pages: (GaPageTagScan | null)[] = [];
  for (const path of paths) {
    if (clock() - started >= SCAN_BUDGET_MS) break;
    await sleep(REQUEST_GAP_MS);
    if (clock() - started >= SCAN_BUDGET_MS) break;
    const page = await fetchSafely(fetchHtml, `${origin}${path}`);
    // 4. Getirilemeyen, 2xx olmayan ya da başka alan adına giden sayfa.
    if (
      !page ||
      page.status < 200 ||
      page.status >= 300 ||
      !sameSite(page.finalUrl, host)
    ) {
      pages.push(null);
      continue;
    }
    try {
      pages.push(scanPageTags(page.body));
    } catch {
      pages.push(null);
    }
  }

  // 5. Birleşim (adres içermez).
  return combinePageScans({ at, host, expectedId: input.expectedId, pages });
}
