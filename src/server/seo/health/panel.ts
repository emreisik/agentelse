import "server-only";

import { prisma } from "@/lib/prisma";
import {
  RECRAWL_MIN_GAP_MS,
  SEO_VERIFY_META_NAME,
  SEO_VERIFY_TXT_PREFIX,
} from "@/lib/seo/audit-constants";
import type { CrawlScope } from "@/lib/seo/crawl-url";
import { coverageText } from "@/lib/seo/coverage";
import {
  SeoFlags,
  seoMockMode,
  seoWorkAllowedFor,
} from "@/lib/seo/health-flags";
import type { SearchHealthGuide } from "@/lib/seo/health/guides";
import { guideFor } from "@/lib/seo/health/guides";
import type { SearchHealthScore } from "@/lib/seo/health/score";
import { verdictLabel } from "@/lib/seo/inspection";
import {
  aiCrawlerAccess,
  parseRobotsTxt,
  robotsDiff,
} from "@/lib/seo/robots-parser";
import { isWorkspaceManager } from "@/server/security/tenant-context";
import type { AuditIssueGroup } from "@/server/seo/crawl/audit-summary";
import { readAuditSummary } from "@/server/seo/crawl/audit-summary";
import { listSearchAlerts } from "@/server/seo/health/alerts";
import { readCoverage } from "@/server/seo/health/coverage";
import { readLatestCwv, type CwvView } from "@/server/seo/health/cwv";
import {
  inspectionUsage,
  readGscSitemaps,
  readInspectionsFor,
  type GscSitemapRow,
} from "@/server/seo/health/google-reads";
import type { LostUrlReport } from "@/server/seo/health/lost-urls";
import { buildLostUrlReport } from "@/server/seo/health/lost-urls";
import { readSearchHealthScore } from "@/server/seo/health/runner";
import { SearchUpdates } from "@/server/seo/health/updates";
import { SeoSites, type SeoSiteState } from "@/server/seo/site/sites";
import { ensureVerifyToken } from "@/server/seo/site/verify";

// Search sayfasındaki "Index & technical health" bölümünün verisi (SC-F3,
// docs/search-health.md). Bayrak kapalıyken veritabanına hiç gitmez. Sayfa
// çizimi yalnız eksik SeoSite satırını oluşturur (reset:false); kapsam
// sıfırlaması burada asla olmaz. Okumalar birbirinden yalıtılır: biri
// düşerse yalnız o kart boş kalır.

export type SearchHealthPanel = {
  projectId: string;
  canManage: boolean;
  isMock: boolean;
  allowed: boolean;
  score: {
    value: number | null;
    parts: SearchHealthScore["parts"];
    cappedByCritical: boolean;
    computedAt: Date | null;
  };
  scope: {
    state: "gsc" | "verified" | "needs_verification" | "no_domain";
    label: string | null;
    verify: {
      domain: string;
      token: string;
      metaTag: string;
      dnsName: string;
      dnsValue: string;
    } | null;
  };
  issues: {
    id: string;
    source: "GSC" | "SEO";
    kind: string;
    severity: "INFO" | "WARN" | "CRITICAL";
    title: string;
    detail: string | null;
    lastSeenAt: Date;
    guide: SearchHealthGuide;
    open: boolean;
  }[];
  coverage:
    | {
        state: "ready";
        text: string;
        sampled: number;
        point: number;
        low: number;
        high: number;
        weekStart: string;
      }
    | { state: "collecting"; sampled: number }
    | { state: "needs_crawl" }
    | null;
  inspections: {
    used: number;
    budget: number;
    pausedUntil: Date | null;
    queued: number;
  } | null;
  keyPages: {
    url: string;
    path: string;
    isHomepage: boolean;
    status: number | null;
    fetchError: string | null;
    robotsBlocked: boolean;
    noindex: boolean;
    indexable: boolean | null;
    googleLabel: string;
    googleLastCrawl: Date | null;
    lastCheckedAt: Date | null;
    canInspect: boolean;
  }[];
  sitemaps: {
    url: string;
    source: string;
    status: number | null;
    urls: number | null;
    googleErrors: number | null;
    googleWarnings: number | null;
    googleLastDownloaded: Date | null;
  }[];
  robots: {
    verdict: string | null;
    fetchedAt: Date | null;
    changedAt: Date | null;
    diff: { added: string[]; removed: string[] } | null;
    aiAccess: {
      token: string;
      owner: string;
      purpose: "search" | "training";
      allowed: boolean;
    }[];
  } | null;
  crawl: {
    enabled: boolean;
    pageLimit: number;
    available: boolean;
    running: boolean;
    blocked: boolean;
    lastFullAt: Date | null;
    nextDueAt: Date | null;
    pages: number;
    groups: AuditIssueGroup[];
    canRecrawl: boolean;
  } | null;
  cwv: { phone: CwvView | null; desktop: CwvView | null } | null;
  lostUrls: LostUrlReport | null;
  updates: {
    name: string;
    kind: string;
    startedAt: Date;
    endedAt: Date | null;
    url: string | null;
  }[];
};

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, WARN: 1, INFO: 2 };
const UPDATES_DAYS = 90;
const ALERT_LIMIT = 30;

// Okuma hatası paneli düşürmez; o kart "veri yok" gibi görünür.
function settle<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch(() => null);
}

function scopeLabel(scope: CrawlScope, state: SeoSiteState): string {
  if (scope.kind === "GSC_PREFIX") return scope.prefix ?? scope.root;
  if (scope.kind === "GSC_DOMAIN") return scope.root;
  return state.verification.verifiedDomain ?? scope.root;
}

// Sitemap adresleri kendi okumamızla Google'ın listesi arasında host + yol
// üzerinden eşleşir (şema ve host harf farkı yok sayılır).
function sitemapKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function mergeSitemaps(
  own: SeoSiteState["sitemaps"],
  google: readonly GscSitemapRow[],
): SearchHealthPanel["sitemaps"] {
  const byKey = new Map(google.map((row) => [sitemapKey(row.path), row]));
  const rows: SearchHealthPanel["sitemaps"] = own.map((summary) => {
    const key = sitemapKey(summary.url);
    const match = byKey.get(key) ?? null;
    if (match) byKey.delete(key);
    return {
      url: summary.url,
      source: summary.source,
      status: summary.status,
      urls: summary.urlCount,
      googleErrors: match?.errors ?? null,
      googleWarnings: match?.warnings ?? null,
      googleLastDownloaded: match?.lastDownloaded ?? null,
    };
  });
  // Yalnız Search Console'un bildiği sitemap'ler sona eklenir.
  for (const row of byKey.values()) {
    rows.push({
      url: row.path,
      source: "GSC",
      status: null,
      urls: row.submittedCount,
      googleErrors: row.errors,
      googleWarnings: row.warnings,
      googleLastDownloaded: row.lastDownloaded,
    });
  }
  return rows;
}

function robotsView(state: SeoSiteState): SearchHealthPanel["robots"] {
  const { robots } = state;
  if (!robots.fetchedAt && !robots.verdict) return null;
  const parsed = robots.body ? parseRobotsTxt(robots.body) : null;
  return {
    verdict: robots.verdict,
    fetchedAt: robots.fetchedAt,
    changedAt: robots.changedAt,
    diff:
      robots.prevBody !== null && robots.body !== null
        ? robotsDiff(robots.prevBody, robots.body)
        : null,
    aiAccess: aiCrawlerAccess(parsed),
  };
}

export async function loadSearchHealthPanel(
  projectId: string,
  options: {
    userId: string;
    workspaceId: string;
    issueId?: string | null;
    now?: Date;
  },
): Promise<SearchHealthPanel | null> {
  if (!SeoFlags.health()) return null;
  const now = options.now ?? new Date();
  const allowed = seoWorkAllowedFor(projectId);

  const [canManage, project] = await Promise.all([
    isWorkspaceManager(options.userId, options.workspaceId).catch(() => false),
    settle(
      prisma.project.findUnique({
        where: { id: projectId },
        select: { domain: true },
      }),
    ),
  ]);
  // Yalnız eksik satır oluşur; izin listesi dışındaki projede hiç yazım yok.
  if (allowed) {
    await settle(SeoSites.ensureForProject(projectId, now, { reset: false }));
  }
  const state = await settle(SeoSites.readState(projectId));
  const projectDomain = project?.domain?.trim() || null;

  const [
    audit,
    stored,
    alerts,
    coverage,
    usage,
    gscSitemaps,
    cwv,
    updates,
    verifyToken,
  ] = await Promise.all([
    settle(readAuditSummary(projectId)),
    settle(readSearchHealthScore(projectId)),
    settle(listSearchAlerts(projectId, ALERT_LIMIT)),
    settle(readCoverage(projectId)),
    settle(inspectionUsage(projectId, now)),
    settle(readGscSitemaps(projectId)),
    settle(readLatestCwv(projectId)),
    settle(SearchUpdates.recent(now, UPDATES_DAYS)),
    // Doğrulama kartı yalnız alan adı olup kapsamı olmayan projede gerekir.
    allowed && projectDomain && !state?.scope
      ? settle(ensureVerifyToken(projectId))
      : Promise.resolve(null),
  ]);

  const issues: SearchHealthPanel["issues"] = (alerts ?? [])
    .map((alert) => ({
      id: alert.id,
      source: alert.source,
      kind: alert.kind,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      lastSeenAt: alert.lastSeenAt,
      guide: guideFor(alert.kind),
      open: Boolean(options.issueId) && alert.id === options.issueId,
    }))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
    );
  const lostOpen = issues.some((issue) => issue.kind === "GSC_LOST_URLS");

  const keyPageHashes = (audit?.keyPages ?? []).map((page) => page.urlHash);
  const [inspections, lostUrls] = await Promise.all([
    keyPageHashes.length > 0
      ? settle(readInspectionsFor(projectId, keyPageHashes))
      : Promise.resolve(null),
    // 301 haritası yalnız açık bir GSC_LOST_URLS uyarısında hesaplanır.
    lostOpen
      ? settle(buildLostUrlReport(projectId, now))
      : Promise.resolve(null),
  ]);

  // Kapsam kartı
  let scope: SearchHealthPanel["scope"];
  if (state?.scope && state.scopeVia) {
    scope = {
      state: state.scopeVia === "GSC" ? "gsc" : "verified",
      label: scopeLabel(state.scope, state),
      verify: null,
    };
  } else if (projectDomain) {
    const domain = verifyToken?.domain ?? projectDomain;
    scope = {
      state: "needs_verification",
      label: null,
      verify: verifyToken
        ? {
            domain,
            token: verifyToken.token,
            metaTag: `<meta name="${SEO_VERIFY_META_NAME}" content="${verifyToken.token}">`,
            dnsName: domain,
            dnsValue: `${SEO_VERIFY_TXT_PREFIX}${verifyToken.token}`,
          }
        : null,
    };
  } else {
    scope = { state: "no_domain", label: null, verify: null };
  }

  // Kapsam tahmini: sitemap envanteri tarayıcıdan gelir (SEO_CRAWL).
  let coverageView: SearchHealthPanel["coverage"] = null;
  if (coverage) {
    const crawlOn = SeoFlags.crawl();
    const crawlEnabled = state?.settings.crawlEnabled ?? true;
    if (coverage.current) {
      const current = coverage.current;
      coverageView = {
        state: "ready",
        text: coverageText(current),
        sampled: current.sampled,
        point: current.point,
        low: current.low,
        high: current.high,
        weekStart: current.weekStart,
      };
    } else if (!crawlOn || (!crawlEnabled && coverage.sampledSoFar === 0)) {
      coverageView = { state: "needs_crawl" };
    } else {
      coverageView = { state: "collecting", sampled: coverage.sampledSoFar };
    }
  }

  // Inspect yalnız Search Console kapsamında ve izin listesindeki projede.
  const canInspect = allowed && state?.scopeVia === "GSC";
  const keyPages: SearchHealthPanel["keyPages"] = (audit?.keyPages ?? []).map(
    (page) => {
      const inspection = inspections?.get(page.urlHash) ?? null;
      return {
        url: page.url,
        path: page.path,
        isHomepage: page.isHomepage,
        status: page.status,
        fetchError: page.fetchError,
        robotsBlocked: page.robotsBlocked,
        noindex: page.noindex,
        indexable: page.indexable,
        googleLabel: verdictLabel(inspection?.verdict ?? null),
        googleLastCrawl: inspection?.lastCrawlTime ?? null,
        lastCheckedAt: page.lastCheckedAt,
        canInspect,
      };
    },
  );

  let crawl: SearchHealthPanel["crawl"] = null;
  if (state) {
    const enabled = state.settings.crawlEnabled;
    const available = SeoFlags.crawl() && state.scope !== null;
    const lastFullAt = state.crawl.lastFullCrawlAt;
    const old =
      !lastFullAt || now.getTime() - lastFullAt.getTime() >= RECRAWL_MIN_GAP_MS;
    crawl = {
      enabled,
      pageLimit: state.settings.pageLimit,
      available,
      running: state.crawl.running,
      blocked: state.crawl.blocked,
      lastFullAt,
      nextDueAt: state.crawl.fullCrawlDueAt,
      pages: audit?.crawledPages ?? state.crawl.lastFull?.pagesFetched ?? 0,
      groups: audit?.groups ?? [],
      canRecrawl: enabled && available && (old || state.crawl.blocked),
    };
  }

  return {
    projectId,
    canManage,
    isMock: state?.isMock ?? seoMockMode(),
    allowed,
    score: stored
      ? {
          value: stored.score.value,
          parts: stored.score.parts,
          cappedByCritical: stored.score.cappedByCritical,
          computedAt: stored.computedAt,
        }
      : { value: null, parts: [], cappedByCritical: false, computedAt: null },
    scope,
    issues,
    coverage: coverageView,
    inspections: usage,
    keyPages,
    sitemaps: state ? mergeSitemaps(state.sitemaps, gscSitemaps ?? []) : [],
    robots: state ? robotsView(state) : null,
    crawl,
    cwv: cwv ? { phone: cwv.phone, desktop: cwv.desktop } : null,
    lostUrls,
    updates: (updates ?? []).map((update) => ({
      name: update.name,
      kind: update.kind,
      startedAt: update.startedAt,
      endedAt: update.endedAt,
      url: update.url,
    })),
  };
}
