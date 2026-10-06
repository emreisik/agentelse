import "server-only";

import { googleFetchJson } from "@/server/integrations/google/http";

import { mockSitemaps } from "./mock";
import { gscMockMode, SEARCH_CONSOLE_BASE } from "./search-analytics";

// Search Console sitemaps.list (docs/google-search-console-plan.md §3.5,
// SK10). YALNIZ OKUMA: site haritası gönderme, silme ya da PUT çağrısı
// bilerek yoktur; Agentelse kullanıcının Search Console'unu değiştirmez.
// Senkronu SC-F3'tedir; SC-F2'de yalnız istemci vardır.

export type GscSitemapInfo = {
  path: string;
  type: string | null;
  isIndex: boolean;
  isPending: boolean;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  errors: number;
  warnings: number;
  contents: { type: string; submitted: number }[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// int64 alanları JSON'da dizgi olarak gelir ("42").
function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSitemap(value: unknown): GscSitemapInfo | null {
  const raw = record(value);
  const path = text(raw?.path);
  if (!raw || !path) return null;
  const contents = Array.isArray(raw.contents) ? raw.contents : [];
  return {
    path,
    type: text(raw.type),
    isIndex: raw.isSitemapsIndex === true,
    isPending: raw.isPending === true,
    lastSubmitted: text(raw.lastSubmitted),
    lastDownloaded: text(raw.lastDownloaded),
    errors: count(raw.errors),
    warnings: count(raw.warnings),
    contents: contents.flatMap((item) => {
      const content = record(item);
      const type = text(content?.type);
      return type ? [{ type, submitted: count(content?.submitted) }] : [];
    }),
  };
}

export async function listSearchConsoleSitemaps(
  accessToken: string,
  siteUrl: string,
): Promise<GscSitemapInfo[]> {
  if (gscMockMode()) return mockSitemaps(siteUrl);
  const raw = await googleFetchJson<{ sitemap?: unknown } | null>(
    `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    { kind: "read" },
  );
  const list = Array.isArray(raw?.sitemap) ? raw.sitemap : [];
  return list
    .map(parseSitemap)
    .filter((sitemap): sitemap is GscSitemapInfo => sitemap !== null);
}
