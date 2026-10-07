import "server-only";

import { prisma } from "@/lib/prisma";
import { isHomepageUrl } from "@/lib/seo/crawl-url";
import { applyMockMode, seoGeoEnabledFor } from "@/lib/seo/apply/flags";
import { GEO_CHECKS, GEO_MANUAL_GAP_MS } from "@/lib/seo/geo/catalog";
import { rescore } from "@/lib/seo/geo/evaluate";
import { buildLlmsTxt } from "@/lib/seo/geo/llms";
import {
  isAcknowledgeable,
  parseGeoResult,
  type GeoAuditResult,
} from "@/lib/seo/geo/types";
import type { GeoCheckView, GeoPanel } from "@/lib/seo/geo/view-types";
import { isWorkspaceManager } from "@/server/security/tenant-context";

import { readAiTraffic } from "./ai-traffic";
import {
  parseRecommendations,
  readGeoAudit,
  validAcknowledged,
} from "./store";

// Search sayfasındaki "AI search visibility" bölümünün verisi (SC-F8). Bayrak
// kapalıyken ya da proje izinli değilken veritabanına hiç gitmez (null).
// Denetim yoksa ya da bayatsa durum "waiting" (tarama verisi var) ya da
// "needs_crawl"; hazırsa kayıtlı sonuç kabullerle yeniden puanlanarak gösterilir.
// llms.txt taslağı yalnız dosya yokken (state "missing") üretilir ve en çok 40
// anahtar sayfadan kurulur: ana sayfa önce, sonra en çok iç link alanlar.

const DRAFT_PAGES = 40;
const SITE_NAME_MAX = 80;

// "Acme | Widgets" gibi başlığın ilk parçası site adıdır.
function siteNameFrom(title: string | null, fallback: string): string {
  const first = (title ?? "")
    .split(/\s[|–—·]\s|\s-\s/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return (first || fallback).slice(0, SITE_NAME_MAX);
}

async function buildDraft(siteId: string, origin: string | null) {
  const pages = await prisma.seoPage.findMany({
    where: { siteId, status: 200, goneAt: null, indexable: true },
    orderBy: [{ inlinks: "desc" }, { path: "asc" }],
    take: DRAFT_PAGES,
    select: { url: true, title: true, metaDescription: true },
  });
  if (pages.length === 0) return null;
  const home = pages.find((page) => isHomepageUrl(page.url));
  const ordered = home
    ? [home, ...pages.filter((page) => page !== home)]
    : pages;
  let host: string | null = null;
  try {
    host = origin ? new URL(origin).hostname : null;
  } catch {
    host = null;
  }
  return buildLlmsTxt({
    siteName: siteNameFrom(home?.title ?? null, host ?? "Site"),
    description: home?.metaDescription ?? null,
    pages: ordered.map((page) => ({
      url: page.url,
      title: page.title,
      description: page.metaDescription,
    })),
    host,
  });
}

function viewsOf(
  result: GeoAuditResult,
  recommendations: ReturnType<typeof parseRecommendations>,
  canManage: boolean,
): GeoCheckView[] {
  const texts = new Map(
    (recommendations?.items ?? []).map((item) => [item.checkId, item.text]),
  );
  return result.checks.map((check) => {
    const def = GEO_CHECKS[check.id];
    return {
      id: check.id,
      status: check.status,
      title: def.title,
      why: def.why,
      how: def.how,
      recommendation: texts.get(check.id) ?? null,
      facts: check.facts,
      canAcknowledge:
        canManage &&
        isAcknowledgeable(check.id) &&
        (check.status === "WARN" || check.status === "ACK"),
    };
  });
}

export async function loadGeoPanel(input: {
  projectId: string;
  userId: string;
}): Promise<GeoPanel | null> {
  if (!seoGeoEnabledFor(input.projectId)) return null;
  const now = new Date();
  const site = await prisma.seoSite.findUnique({
    where: {
      projectId_isMock: {
        projectId: input.projectId,
        isMock: applyMockMode(),
      },
    },
    select: {
      id: true,
      workspaceId: true,
      scopeKey: true,
      origin: true,
      lastFullCrawlAt: true,
    },
  });
  const empty = (state: GeoPanel["state"]): GeoPanel => ({
    enabled: true,
    state,
    score: null,
    previousScore: null,
    checks: [],
    crawlers: [],
    llms: { state: "unknown", draft: null },
    auditedAt: null,
    canAuditNow: false,
    canAcknowledge: false,
    recommendationSource: null,
    traffic: null,
  });
  if (!site || !site.scopeKey) return empty("needs_crawl");

  const [audit, canManage] = await Promise.all([
    readGeoAudit(input.projectId),
    isWorkspaceManager(input.userId, site.workspaceId).catch(() => false),
  ]);
  const stored = audit ? parseGeoResult(audit.result) : null;
  if (!audit || !stored) {
    const crawled = site.origin !== null && site.lastFullCrawlAt !== null;
    return { ...empty(crawled ? "waiting" : "needs_crawl"), canAcknowledge: canManage };
  }

  const result = rescore(stored, validAcknowledged(audit.acknowledged));
  const recommendations = parseRecommendations(audit.recommendations);
  const [draft, traffic] = await Promise.all([
    result.llms.state === "missing"
      ? buildDraft(site.id, site.origin).catch(() => null)
      : Promise.resolve(null),
    readAiTraffic(input.projectId).catch(() => null),
  ]);
  return {
    enabled: true,
    state: "ready",
    score: result.score,
    previousScore: audit.previousScore,
    checks: viewsOf(result, recommendations, canManage),
    crawlers: result.crawlers,
    llms: { state: result.llms.state, draft },
    auditedAt: audit.auditedAt.toISOString(),
    canAuditNow: now.getTime() - audit.auditedAt.getTime() >= GEO_MANUAL_GAP_MS,
    canAcknowledge: canManage,
    recommendationSource: recommendations?.source ?? null,
    traffic,
  };
}
