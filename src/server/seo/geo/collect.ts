import "server-only";

import { prisma } from "@/lib/prisma";
import { CRAWL_MAX_BYTES, SEO_CRAWLER_TOKEN } from "@/lib/seo/audit-constants";
import { seoWorkAllowedFor } from "@/lib/seo/health-flags";
import { extractPageFacts } from "@/lib/seo/html-audit";
import { extractJsonLdBlocks, organizationFacts } from "@/lib/seo/geo/entities";
import type { GeoInput } from "@/lib/seo/geo/evaluate";
import { LLMS_MAX_BYTES } from "@/lib/seo/geo/llms";
import { isAllowed, parseRobotsTxt } from "@/lib/seo/robots-parser";
import {
  siteFetch,
  type SiteFetchDeps,
  type SiteFetchResult,
} from "@/server/seo/crawl/fetcher";
import { sharedHostPacer } from "@/server/seo/crawl/pacer";
import { hostScope, isFailingVerdict } from "@/server/seo/crawl/robots";
import { siteTransport } from "@/server/seo/crawl/transport";
import { SeoSites } from "@/server/seo/site/sites";

// GEO denetiminin girdisi (SC-F8, docs/ai-search-visibility.md "Veri
// kaynakları"): SeoSite'ın robots kopyası, en çok 300 SeoPage satırı ve TAM
// İKİ canlı GET (/llms.txt ve ana sayfa). İki GET de saklı robots.txt'e ve
// sitenin kapsamına bağlıdır; robots izin vermiyorsa istek hiç yapılmaz.
// Hiçbir zaman fırlatmaz: getirme hatası "unknown", robots engeli "blocked"
// olur. Mock kipte siteTransport() bellek içi siteyi döner (ağa çıkılmaz).

export const GEO_PAGE_LIMIT = 300;
const HANDLES_LIMIT = 10;

export type GeoCollectDeps = {
  fetchDeps?: Partial<SiteFetchDeps>;
  now?: Date;
};

export type GeoCollectResult =
  | {
      ok: true;
      siteId: string;
      scopeKey: string | null;
      isMock: boolean;
      input: GeoInput;
    }
  | { ok: false; reason: "no_site" | "no_crawl" | "not_allowed" };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function h2Of(headings: unknown): string[] {
  if (!headings || typeof headings !== "object" || Array.isArray(headings)) {
    return [];
  }
  const h2 = (headings as { h2?: unknown }).h2;
  return Array.isArray(h2)
    ? h2.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isMissingStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429 && status !== 408;
}

function fetchFailed(result: SiteFetchResult): boolean {
  return (
    result.errorKind !== null ||
    result.status === null ||
    result.leftScope ||
    result.redirectLoop ||
    result.tooManyRedirects
  );
}

function llmsOf(result: SiteFetchResult | null): GeoInput["llms"] {
  if (!result) return { state: "unknown", text: null };
  if (result.blockedByRobots || result.blockedHop) {
    return { state: "blocked", text: null };
  }
  if (fetchFailed(result) || result.status === null) {
    return { state: "unknown", text: null };
  }
  if (result.status >= 200 && result.status < 300) {
    return result.body
      ? { state: "present", text: result.body.toString("utf8") }
      : { state: "unknown", text: null };
  }
  if (isMissingStatus(result.status)) return { state: "missing", text: null };
  return { state: "unknown", text: null };
}

function homeOf(result: SiteFetchResult | null): GeoInput["home"] {
  if (!result) return null;
  if (result.blockedByRobots || result.blockedHop) return null;
  if (fetchFailed(result) || result.status === null) return null;
  if (result.status < 200 || result.status >= 300) {
    return {
      status: result.status,
      schemaTypes: [],
      renderRisk: false,
      title: null,
      org: null,
    };
  }
  // HTML olmayan yanıtın gövdesi atlanır: ana sayfa verisi yok.
  if (!result.body) return null;
  const html = result.body.toString("utf8");
  const facts = extractPageFacts(html, result.finalUrl, {
    truncated: result.truncated,
  });
  return {
    status: result.status,
    schemaTypes: facts.jsonLd.types,
    renderRisk: facts.renderRisk,
    title: facts.title,
    org: organizationFacts(extractJsonLdBlocks(html)),
  };
}

export async function collectGeoInput(
  projectId: string,
  deps: GeoCollectDeps = {},
): Promise<GeoCollectResult> {
  if (!seoWorkAllowedFor(projectId)) return { ok: false, reason: "not_allowed" };
  const now = deps.now ?? new Date();
  const state = await SeoSites.readState(projectId);
  if (!state || !state.scope) return { ok: false, reason: "no_site" };

  const [pages, brand, project, accounts] = await Promise.all([
    prisma.seoPage.findMany({
      where: { siteId: state.siteId, status: 200, goneAt: null },
      orderBy: [{ inlinks: "desc" }, { path: "asc" }],
      take: GEO_PAGE_LIMIT,
      select: {
        path: true,
        wordCount: true,
        schemaTypes: true,
        headings: true,
        robotsMeta: true,
        xRobotsTag: true,
        indexable: true,
        status: true,
      },
    }),
    prisma.brand.findFirst({
      where: { projectId, isDefault: true },
      orderBy: { createdAt: "asc" },
      select: { name: true },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    }),
    prisma.socialAccount.findMany({
      where: { projectId, status: "CONNECTED" },
      take: HANDLES_LIMIT,
      select: { username: true },
    }),
  ]);
  if (!state.origin || pages.length === 0) {
    return { ok: false, reason: "no_crawl" };
  }

  const verdict = state.robots.verdict;
  const robots =
    verdict === "OK" && state.robots.body
      ? parseRobotsTxt(state.robots.body)
      : null;
  const originHost = hostOf(state.origin);

  let llms: GeoInput["llms"] = { state: "unknown", text: null };
  let home: GeoInput["home"] = null;
  // robots.txt okunamadıysa (5xx/ağ) Google gibi hiçbir şey getirilmez.
  if (originHost && verdict !== null && !isFailingVerdict(verdict)) {
    const fetchDeps: SiteFetchDeps = {
      transport: deps.fetchDeps?.transport ?? siteTransport(),
      pacer: deps.fetchDeps?.pacer ?? sharedHostPacer,
    };
    const scope = hostScope({ scope: state.scope }, originHost);
    // Yalnız köken alan adı ve saklı robots.txt kuralları.
    const gate = (url: string) =>
      hostOf(url) === originHost &&
      isAllowed(robots, SEO_CRAWLER_TOKEN, url).allowed;
    const llmsResult = await siteFetch(
      `${state.origin}/llms.txt`,
      {
        scope,
        originHost,
        accept: "any",
        maxBytes: LLMS_MAX_BYTES,
        isAllowed: gate,
      },
      fetchDeps,
    );
    llms = llmsOf(llmsResult);
    const homeResult = await siteFetch(
      `${state.origin}/`,
      {
        scope,
        originHost,
        accept: "html",
        maxBytes: CRAWL_MAX_BYTES,
        isAllowed: gate,
      },
      fetchDeps,
    );
    home = homeOf(homeResult);
  }

  const handles = accounts
    .map((account) => account.username.replace(/^@/, "").trim().toLowerCase())
    .filter((handle) => handle.length > 0);
  return {
    ok: true,
    siteId: state.siteId,
    scopeKey: state.scope.key,
    isMock: state.isMock,
    input: {
      robots,
      robotsVerdict: verdict,
      llms,
      home,
      pages: pages.map((page) => ({
        path: page.path,
        wordCount: page.wordCount,
        schemaTypes: page.schemaTypes,
        h2: h2Of(page.headings),
        robotsMeta: page.robotsMeta,
        xRobotsTag: page.xRobotsTag,
        indexable: page.indexable,
        status: page.status,
      })),
      brandName: brand?.name?.trim() || project?.name?.trim() || null,
      connectedHandles: handles,
      acknowledged: [],
      now,
    },
  };
}
