import "server-only";

import { normalizeDomain } from "@/lib/domain";
import {
  scopeFromGscSite,
  scopeFromVerifiedDomain,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import { primaryGscLink } from "@/server/seo/store";

// Tarama kapsamı (docs/search-health.md "Kapsam ve doğrulama"): önce projenin
// geçerli kipteki birincil Search Console bağı (sağlığı GONE/ACCESS_LOST
// değilse), yoksa Project.domain'in Agentelse doğrulaması. İkisi de yoksa
// tarayıcı boşta kalır ve panel doğrulama kartını gösterir.

export type SiteScopeResolution = {
  scope: CrawlScope;
  via: "GSC" | "VERIFIED";
  linkId: string | null;
} | null;

const LOST_LINK_HEALTH = new Set(["GONE", "ACCESS_LOST"]);

export async function resolveSiteScope(input: {
  projectId: string;
  domain: string | null;
  verifiedDomain: string | null;
}): Promise<SiteScopeResolution> {
  const link = await primaryGscLink(input.projectId);
  if (link && !LOST_LINK_HEALTH.has(link.health)) {
    const scope = scopeFromGscSite(link.siteUrl);
    if (scope) return { scope, via: "GSC", linkId: link.id };
  }
  const domain = input.domain ? normalizeDomain(input.domain) : "";
  if (domain && input.verifiedDomain && input.verifiedDomain === domain) {
    const scope = scopeFromVerifiedDomain(domain);
    if (scope) return { scope, via: "VERIFIED", linkId: null };
  }
  return null;
}

const SCOPE_KINDS = new Set(["GSC_DOMAIN", "GSC_PREFIX", "VERIFIED_DOMAIN"]);

// SeoSite.scope Json'unu okur; biçim bozuksa null.
export function parseStoredScope(value: unknown): CrawlScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { kind, root, prefix, key } = record;
  if (typeof kind !== "string" || !SCOPE_KINDS.has(kind)) return null;
  if (typeof root !== "string" || !root) return null;
  if (typeof key !== "string" || !key) return null;
  if (prefix !== null && typeof prefix !== "string") return null;
  return {
    kind: kind as CrawlScope["kind"],
    root,
    prefix: prefix ?? null,
    key,
  };
}
