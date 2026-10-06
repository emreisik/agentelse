import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (SC-F3 paneli): bayrak kapalıyken hiçbir okuma
// yok; sayfa çizimi yalnız eksik satırı oluşturur (reset:false); açılış
// listesi dışındaki projede ensure/ensureVerifyToken çağrılmaz; dört kapsam
// durumu; kapsam tahmini ready/collecting/needs_crawl; ?issue= uyarısı açık
// gelir; 301 haritası yalnız açık GSC_LOST_URLS uyarısında hesaplanır; CWV
// verisi yoksa kart gizlenir. Kardeş paketlerin modülleri taklit edilir.

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  crawl: vi.fn(),
  allowed: vi.fn(),
  mock: vi.fn(),
  isWorkspaceManager: vi.fn(),
  projectFindUnique: vi.fn(),
  ensureForProject: vi.fn(),
  readState: vi.fn(),
  ensureVerifyToken: vi.fn(),
  readAuditSummary: vi.fn(),
  readSearchHealthScore: vi.fn(),
  listSearchAlerts: vi.fn(),
  readCoverage: vi.fn(),
  inspectionUsage: vi.fn(),
  readInspectionsFor: vi.fn(),
  readGscSitemaps: vi.fn(),
  readLatestCwv: vi.fn(),
  buildLostUrlReport: vi.fn(),
  recent: vi.fn(),
}));

vi.mock("@/lib/seo/health-flags", () => ({
  SeoFlags: { health: mocks.health, crawl: mocks.crawl },
  seoWorkAllowedFor: mocks.allowed,
  seoMockMode: mocks.mock,
}));
vi.mock("@/lib/seo/audit-constants", () => ({
  RECRAWL_MIN_GAP_MS: 86_400_000,
  SEO_VERIFY_META_NAME: "agentelse-site-verification",
  SEO_VERIFY_TXT_PREFIX: "agentelse-site-verification=",
}));
vi.mock("@/lib/seo/robots-parser", () => ({
  parseRobotsTxt: (text: string) => ({ text }),
  aiCrawlerAccess: (robots: { text: string } | null) => [
    {
      token: "GPTBot",
      owner: "OpenAI",
      purpose: "training",
      allowed: !robots?.text.includes("GPTBot"),
    },
  ],
  robotsDiff: (previous: string, current: string) => ({
    added: [current],
    removed: [previous],
  }),
}));
vi.mock("@/lib/seo/coverage", () => ({
  coverageText: (estimate: { point: number }) =>
    `~${Math.round(estimate.point * 100)}% (±6%)`,
}));
vi.mock("@/lib/seo/inspection", () => ({
  verdictLabel: (verdict: string | null) =>
    verdict === "PASS"
      ? "Indexed"
      : verdict
        ? "Not indexed"
        : "Not checked yet",
}));
vi.mock("@/lib/seo/health/guides", () => ({
  guideFor: (kind: string) => ({
    title: `Fix ${kind}`,
    steps: ["one", "two", "three"],
    screen: null,
    learnMoreUrl: null,
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: mocks.projectFindUnique } },
}));
vi.mock("@/server/security/tenant-context", () => ({
  isWorkspaceManager: mocks.isWorkspaceManager,
}));
vi.mock("@/server/seo/site/sites", () => ({
  SeoSites: {
    ensureForProject: mocks.ensureForProject,
    readState: mocks.readState,
  },
}));
vi.mock("@/server/seo/site/verify", () => ({
  ensureVerifyToken: mocks.ensureVerifyToken,
}));
vi.mock("@/server/seo/crawl/audit-summary", () => ({
  readAuditSummary: mocks.readAuditSummary,
}));
vi.mock("@/server/seo/health/runner", () => ({
  readSearchHealthScore: mocks.readSearchHealthScore,
}));
vi.mock("@/server/seo/health/alerts", () => ({
  listSearchAlerts: mocks.listSearchAlerts,
}));
vi.mock("@/server/seo/health/coverage", () => ({
  readCoverage: mocks.readCoverage,
}));
vi.mock("@/server/seo/health/google-reads", () => ({
  inspectionUsage: mocks.inspectionUsage,
  readInspectionsFor: mocks.readInspectionsFor,
  readGscSitemaps: mocks.readGscSitemaps,
}));
vi.mock("@/server/seo/health/cwv", () => ({
  readLatestCwv: mocks.readLatestCwv,
}));
vi.mock("@/server/seo/health/lost-urls", () => ({
  buildLostUrlReport: mocks.buildLostUrlReport,
}));
vi.mock("@/server/seo/health/updates", () => ({
  SearchUpdates: { recent: mocks.recent },
}));

const { loadSearchHealthPanel } = await import("./panel");

const NOW = new Date("2026-10-06T12:00:00.000Z");
const OPTIONS = { userId: "user-1", workspaceId: "ws-1", now: NOW };

type StateOverrides = {
  scope?: {
    kind: string;
    root: string;
    prefix: string | null;
    key: string;
  } | null;
  scopeVia?: "GSC" | "VERIFIED" | null;
  crawlEnabled?: boolean;
  lastFullCrawlAt?: Date | null;
  blocked?: boolean;
  robotsBody?: string | null;
  robotsPrevBody?: string | null;
  verifiedDomain?: string | null;
};

function state(overrides: StateOverrides = {}) {
  return {
    siteId: "site-1",
    projectId: "proj-1",
    isMock: false,
    scope:
      overrides.scope === undefined
        ? {
            kind: "GSC_DOMAIN",
            root: "example.com",
            prefix: null,
            key: "GSC_DOMAIN:example.com:",
          }
        : overrides.scope,
    scopeVia: overrides.scopeVia === undefined ? "GSC" : overrides.scopeVia,
    origin: "https://www.example.com",
    domain: "example.com",
    verification: {
      token: null,
      verifiedDomain: overrides.verifiedDomain ?? null,
      method: null,
      verifiedAt: null,
    },
    settings: {
      v: 1,
      crawlEnabled: overrides.crawlEnabled ?? true,
      pageLimit: 500,
    },
    robots: {
      verdict: "OK",
      status: 200,
      failures: 0,
      fetchedAt: new Date("2026-10-06T06:00:00.000Z"),
      changedAt: new Date("2026-10-05T06:00:00.000Z"),
      body:
        overrides.robotsBody === undefined
          ? "User-agent: *"
          : overrides.robotsBody,
      prevBody: overrides.robotsPrevBody ?? null,
    },
    httpRedirectsToHttps: true,
    sitemaps: [
      {
        url: "https://www.example.com/sitemap.xml",
        source: "ROBOTS",
        status: 200,
        kind: "urlset",
        urlCount: 40,
        inScope: 40,
        errors: [],
        fetchedAt: "2026-10-06T06:00:00.000Z",
      },
    ],
    sitemapsCheckedAt: null,
    sitemapBaselineAt: null,
    crawl: {
      blocked: overrides.blocked ?? false,
      pausedUntil: null,
      lastFullCrawlAt:
        overrides.lastFullCrawlAt === undefined
          ? new Date("2026-10-01T02:00:00.000Z")
          : overrides.lastFullCrawlAt,
      fullCrawlDueAt: new Date("2026-10-08T01:00:00.000Z"),
      lastRegressionAt: null,
      running: false,
      lastError: null,
      lastFull: {
        status: "DONE",
        pagesFetched: 37,
        finishedAt: null,
        stats: null,
      },
    },
  };
}

function alert(
  id: string,
  kind: string,
  severity: "INFO" | "WARN" | "CRITICAL",
) {
  return {
    id,
    source: kind.startsWith("GSC_") ? "GSC" : "SEO",
    kind,
    severity,
    title: `Title ${kind}`,
    detail: null,
    lastSeenAt: NOW,
    dedupeKey: `x:${kind}`,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.health.mockReturnValue(true);
  mocks.crawl.mockReturnValue(true);
  mocks.allowed.mockReturnValue(true);
  mocks.mock.mockReturnValue(false);
  mocks.isWorkspaceManager.mockResolvedValue(true);
  mocks.projectFindUnique.mockResolvedValue({ domain: "example.com" });
  mocks.ensureForProject.mockResolvedValue({ id: "site-1" });
  mocks.readState.mockResolvedValue(state());
  mocks.ensureVerifyToken.mockResolvedValue({
    token: "TOKEN123",
    domain: "example.com",
  });
  mocks.readAuditSummary.mockResolvedValue({
    crawledPages: 37,
    indexablePages: 30,
    cleanShare: 0.8,
    groups: [],
    keyPages: [
      {
        url: "https://www.example.com/",
        urlHash: "h-home",
        path: "/",
        isHomepage: true,
        status: 200,
        fetchError: null,
        finalUrl: "https://www.example.com/",
        robotsBlocked: false,
        noindex: false,
        indexable: true,
        lastCheckedAt: NOW,
      },
    ],
  });
  mocks.readSearchHealthScore.mockResolvedValue(null);
  mocks.listSearchAlerts.mockResolvedValue([]);
  mocks.readCoverage.mockResolvedValue({
    current: null,
    fourWeeksAgo: null,
    history: [],
    sampledSoFar: 0,
  });
  mocks.inspectionUsage.mockResolvedValue({
    used: 12,
    budget: 200,
    pausedUntil: null,
    queued: 0,
  });
  mocks.readInspectionsFor.mockResolvedValue(
    new Map([
      [
        "h-home",
        {
          url: "https://www.example.com/",
          urlHash: "h-home",
          verdict: "PASS",
          lastCrawlTime: new Date("2026-10-04T00:00:00.000Z"),
        },
      ],
    ]),
  );
  mocks.readGscSitemaps.mockResolvedValue([]);
  mocks.readLatestCwv.mockResolvedValue(null);
  mocks.buildLostUrlReport.mockResolvedValue({
    rows: [],
    text: "",
    lostClicksShare: null,
    critical: false,
    checkedThrough: null,
  });
  mocks.recent.mockResolvedValue([]);
});

describe("loadSearchHealthPanel", () => {
  it("returns null without any read when SEO_HEALTH is off", async () => {
    mocks.health.mockReturnValue(false);
    expect(await loadSearchHealthPanel("proj-1", OPTIONS)).toBeNull();
    for (const [name, mock] of Object.entries(mocks)) {
      if (name === "health") continue;
      expect(mock, name).not.toHaveBeenCalled();
    }
  });

  it("only creates a missing row on render (reset:false)", async () => {
    const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(mocks.ensureForProject).toHaveBeenCalledWith("proj-1", NOW, {
      reset: false,
    });
    expect(panel?.allowed).toBe(true);
    expect(panel?.canManage).toBe(true);
  });

  it("writes nothing for a project outside the allow-list", async () => {
    mocks.allowed.mockReturnValue(false);
    mocks.readState.mockResolvedValue(null);
    const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(mocks.ensureForProject).not.toHaveBeenCalled();
    expect(mocks.ensureVerifyToken).not.toHaveBeenCalled();
    expect(panel?.allowed).toBe(false);
    expect(panel?.scope).toEqual({
      state: "needs_verification",
      label: null,
      verify: null,
    });
    expect(panel?.keyPages[0]?.canInspect).toBe(false);
  });

  describe("scope", () => {
    it("gsc: the Search Console property", async () => {
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.scope).toEqual({
        state: "gsc",
        label: "example.com",
        verify: null,
      });
      expect(mocks.ensureVerifyToken).not.toHaveBeenCalled();
    });

    it("gsc: a URL-prefix property shows the prefix", async () => {
      mocks.readState.mockResolvedValue(
        state({
          scope: {
            kind: "GSC_PREFIX",
            root: "www.example.com",
            prefix: "https://www.example.com/blog/",
            key: "k",
          },
        }),
      );
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.scope.label).toBe("https://www.example.com/blog/");
    });

    it("verified: the verified domain", async () => {
      mocks.readState.mockResolvedValue(
        state({
          scope: {
            kind: "VERIFIED_DOMAIN",
            root: "example.com",
            prefix: null,
            key: "k",
          },
          scopeVia: "VERIFIED",
          verifiedDomain: "example.com",
        }),
      );
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.scope).toEqual({
        state: "verified",
        label: "example.com",
        verify: null,
      });
      expect(panel?.keyPages[0]?.canInspect).toBe(false);
    });

    it("needs_verification: meta tag and DNS record", async () => {
      mocks.readState.mockResolvedValue(state({ scope: null, scopeVia: null }));
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(mocks.ensureVerifyToken).toHaveBeenCalledWith("proj-1");
      expect(panel?.scope).toEqual({
        state: "needs_verification",
        label: null,
        verify: {
          domain: "example.com",
          token: "TOKEN123",
          metaTag:
            '<meta name="agentelse-site-verification" content="TOKEN123">',
          dnsName: "example.com",
          dnsValue: "agentelse-site-verification=TOKEN123",
        },
      });
    });

    it("needs_verification without a token shows no codes", async () => {
      mocks.readState.mockResolvedValue(state({ scope: null, scopeVia: null }));
      mocks.ensureVerifyToken.mockResolvedValue(null);
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.scope.state).toBe("needs_verification");
      expect(panel?.scope.verify).toBeNull();
    });

    it("no_domain: neither a domain nor a scope", async () => {
      mocks.projectFindUnique.mockResolvedValue({ domain: null });
      mocks.readState.mockResolvedValue(null);
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.scope).toEqual({
        state: "no_domain",
        label: null,
        verify: null,
      });
      expect(mocks.ensureVerifyToken).not.toHaveBeenCalled();
      expect(panel?.crawl).toBeNull();
      expect(panel?.sitemaps).toEqual([]);
    });
  });

  describe("coverage", () => {
    it("ready when the current week has an estimate", async () => {
      mocks.readCoverage.mockResolvedValue({
        current: {
          sampled: 40,
          indexed: 33,
          crawledNotIndexed: 3,
          point: 0.82,
          low: 0.76,
          high: 0.88,
          weekStart: "2026-09-28",
          population: 400,
        },
        fourWeeksAgo: null,
        history: [],
        sampledSoFar: 40,
      });
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.coverage).toEqual({
        state: "ready",
        text: "~82% (±6%)",
        sampled: 40,
        point: 0.82,
        low: 0.76,
        high: 0.88,
        weekStart: "2026-09-28",
      });
    });

    it("collecting while the sample grows", async () => {
      mocks.readCoverage.mockResolvedValue({
        current: null,
        fourWeeksAgo: null,
        history: [],
        sampledSoFar: 7,
      });
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.coverage).toEqual({ state: "collecting", sampled: 7 });
    });

    it("needs_crawl when SEO_CRAWL is off", async () => {
      mocks.crawl.mockReturnValue(false);
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.coverage).toEqual({ state: "needs_crawl" });
      expect(panel?.crawl?.available).toBe(false);
      expect(panel?.crawl?.canRecrawl).toBe(false);
    });

    it("needs_crawl when the audit is disabled and nothing was sampled", async () => {
      mocks.readState.mockResolvedValue(state({ crawlEnabled: false }));
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.coverage).toEqual({ state: "needs_crawl" });
    });

    it("null without Search Console", async () => {
      mocks.readCoverage.mockResolvedValue(null);
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.coverage).toBeNull();
    });
  });

  it("opens the issue named by ?issue= and puts criticals first", async () => {
    mocks.listSearchAlerts.mockResolvedValue([
      alert("a1", "SEO_TITLES_META", "WARN"),
      alert("a2", "SEO_KEY_PAGE_NOINDEX", "CRITICAL"),
    ]);
    const panel = await loadSearchHealthPanel("proj-1", {
      ...OPTIONS,
      issueId: "a1",
    });
    expect(mocks.listSearchAlerts).toHaveBeenCalledWith("proj-1", 30);
    expect(panel?.issues.map((issue) => [issue.id, issue.open])).toEqual([
      ["a2", false],
      ["a1", true],
    ]);
    expect(panel?.issues[0]?.guide.title).toBe("Fix SEO_KEY_PAGE_NOINDEX");
  });

  it("builds the 301 map only with an open GSC_LOST_URLS alert", async () => {
    await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(mocks.buildLostUrlReport).not.toHaveBeenCalled();

    mocks.listSearchAlerts.mockResolvedValue([
      alert("a3", "GSC_LOST_URLS", "WARN"),
    ]);
    const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(mocks.buildLostUrlReport).toHaveBeenCalledWith("proj-1", NOW);
    expect(panel?.lostUrls).not.toBeNull();
  });

  it("hides CWV without data and shows it with data", async () => {
    const hidden = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(hidden?.cwv).toBeNull();

    const phone = {
      formFactor: "PHONE",
      p75: { lcp: 2100, inp: 150, cls: 0.05, fcp: null, ttfb: null },
      overall: "good",
      collectionPeriod: "Sep 8 – Oct 5, 2026",
    };
    mocks.readLatestCwv.mockResolvedValue({
      origin: "https://www.example.com",
      checkedAt: NOW,
      phone,
      desktop: null,
      history: { phone: [], desktop: [] },
      urls: [],
    });
    const shown = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(shown?.cwv).toEqual({ phone, desktop: null });
  });

  it("joins key pages with Google's verdicts", async () => {
    const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(mocks.readInspectionsFor).toHaveBeenCalledWith("proj-1", ["h-home"]);
    expect(panel?.keyPages[0]).toMatchObject({
      path: "/",
      googleLabel: "Indexed",
      googleLastCrawl: new Date("2026-10-04T00:00:00.000Z"),
      canInspect: true,
    });
  });

  it("merges our sitemaps with Search Console's by address", async () => {
    mocks.readGscSitemaps.mockResolvedValue([
      {
        path: "https://WWW.example.com/sitemap.xml",
        type: "sitemap",
        isIndex: false,
        isPending: false,
        lastSubmitted: null,
        lastDownloaded: new Date("2026-10-05T00:00:00.000Z"),
        errors: 2,
        warnings: 1,
        submittedCount: 40,
        checkedAt: NOW,
      },
      {
        path: "https://www.example.com/news.xml",
        type: "sitemap",
        isIndex: false,
        isPending: false,
        lastSubmitted: null,
        lastDownloaded: null,
        errors: 0,
        warnings: 0,
        submittedCount: 5,
        checkedAt: NOW,
      },
    ]);
    const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(panel?.sitemaps).toEqual([
      {
        url: "https://www.example.com/sitemap.xml",
        source: "ROBOTS",
        status: 200,
        urls: 40,
        googleErrors: 2,
        googleWarnings: 1,
        googleLastDownloaded: new Date("2026-10-05T00:00:00.000Z"),
      },
      {
        url: "https://www.example.com/news.xml",
        source: "GSC",
        status: null,
        urls: 5,
        googleErrors: 0,
        googleWarnings: 0,
        googleLastDownloaded: null,
      },
    ]);
  });

  it("reads robots changes and AI crawler access", async () => {
    mocks.readState.mockResolvedValue(
      state({
        robotsBody: "User-agent: GPTBot\nDisallow: /",
        robotsPrevBody: "User-agent: *",
      }),
    );
    const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(panel?.robots?.diff).toEqual({
      added: ["User-agent: GPTBot\nDisallow: /"],
      removed: ["User-agent: *"],
    });
    expect(panel?.robots?.aiAccess).toEqual([
      { token: "GPTBot", owner: "OpenAI", purpose: "training", allowed: false },
    ]);
  });

  describe("recrawl", () => {
    it("allowed once the last full check is a day old", async () => {
      const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(panel?.crawl).toMatchObject({
        enabled: true,
        available: true,
        pages: 37,
        canRecrawl: true,
      });
    });

    it("not within a day, unless the audit is blocked", async () => {
      mocks.readState.mockResolvedValue(
        state({ lastFullCrawlAt: new Date("2026-10-06T02:00:00.000Z") }),
      );
      const recent = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(recent?.crawl?.canRecrawl).toBe(false);

      mocks.readState.mockResolvedValue(
        state({
          lastFullCrawlAt: new Date("2026-10-06T02:00:00.000Z"),
          blocked: true,
        }),
      );
      const blocked = await loadSearchHealthPanel("proj-1", OPTIONS);
      expect(blocked?.crawl?.canRecrawl).toBe(true);
    });
  });

  it("keeps rendering when a read fails", async () => {
    mocks.readAuditSummary.mockRejectedValue(new Error("boom"));
    mocks.listSearchAlerts.mockRejectedValue(new Error("boom"));
    const panel = await loadSearchHealthPanel("proj-1", OPTIONS);
    expect(panel?.issues).toEqual([]);
    expect(panel?.keyPages).toEqual([]);
    expect(panel?.crawl?.pages).toBe(37);
  });
});
