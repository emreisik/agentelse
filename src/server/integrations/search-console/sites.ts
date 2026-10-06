import "server-only";

import { googleFetchJson } from "@/server/integrations/google/http";

import { mockSite } from "./mock";
import { gscMockMode, SEARCH_CONSOLE_BASE } from "./search-analytics";

// Search Console sites.get / sites.list (docs/google-search-console-plan.md
// §3.2, §3.3). Yalnız okuma. Ambar meta verisi (mülk türü, yetki düzeyi)
// buradan gelir; seçim listesinin eski yolu google-client.ts'te kalır.

export type GscPropertyType = "DOMAIN" | "URL_PREFIX";

export type GscSiteInfo = {
  siteUrl: string;
  permissionLevel: string;
  propertyType: GscPropertyType;
};

type RawSite = { siteUrl?: unknown; permissionLevel?: unknown };

// "sc-domain:example.com" alan adı mülküdür; diğerleri URL önekidir.
export function propertyTypeOf(siteUrl: string): GscPropertyType {
  return siteUrl.startsWith("sc-domain:") ? "DOMAIN" : "URL_PREFIX";
}

function headers(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function siteInfo(raw: RawSite, fallbackUrl?: string): GscSiteInfo | null {
  const siteUrl =
    typeof raw.siteUrl === "string" && raw.siteUrl ? raw.siteUrl : fallbackUrl;
  if (!siteUrl) return null;
  return {
    siteUrl,
    permissionLevel:
      typeof raw.permissionLevel === "string" && raw.permissionLevel
        ? raw.permissionLevel
        : "unknown",
    propertyType: propertyTypeOf(siteUrl),
  };
}

export async function getSearchConsoleSite(
  accessToken: string,
  siteUrl: string,
): Promise<GscSiteInfo> {
  if (gscMockMode()) return mockSite(siteUrl);
  const raw = await googleFetchJson<RawSite | null>(
    `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}`,
    { headers: headers(accessToken) },
    { kind: "read" },
  );
  return siteInfo(raw ?? {}, siteUrl)!;
}

// Doğrulanmamış siteler (siteUnverifiedUser) atlanır: Search Analytics onlara
// 403 döner.
export async function listSearchConsoleSiteInfos(
  accessToken: string,
): Promise<GscSiteInfo[]> {
  if (gscMockMode()) {
    return [
      mockSite("sc-domain:example.com"),
      mockSite("https://www.example.com/"),
    ];
  }
  const raw = await googleFetchJson<{ siteEntry?: unknown } | null>(
    `${SEARCH_CONSOLE_BASE}/sites`,
    { headers: headers(accessToken) },
    { kind: "read" },
  );
  const entries = Array.isArray(raw?.siteEntry) ? raw.siteEntry : [];
  const sites: GscSiteInfo[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const site = siteInfo(entry as RawSite);
    if (!site || site.permissionLevel === "siteUnverifiedUser") continue;
    sites.push(site);
  }
  return sites;
}
