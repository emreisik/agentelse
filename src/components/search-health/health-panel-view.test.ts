import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SearchHealthPanel } from "@/server/seo/health/panel";

// Bu dosyanın kanıtladığı (SC-F3 "Index & technical health"): puan rozeti
// ve "—"; kritik tavan notu; uyarı listesi rehber adımları ve "In Search
// Console" satırıyla, ?issue= uyarısında açık; GSC'siz Inspect gizli; kilit
// sayfa durumları (robots engeli, döngü, zaman aşımı); AI tarayıcı tablosu;
// 301 haritası; boş durumlar; doğrulama kartı; izin listesi dışı notu.
// Sunucu eylemleri ve ActionForm taklit edilir; panel düz props'tur.

vi.mock("@/server/actions/search-health-actions", () => ({
  requestInspectionAction: vi.fn(),
  checkSiteVerificationAction: vi.fn(),
  setSiteCrawlAction: vi.fn(),
  recrawlSiteAction: vi.fn(),
  muteSearchAlertAction: vi.fn(),
  deleteSiteAuditDataAction: vi.fn(),
}));

// SC-F6: "I fixed this" düğmesi sunucu eylemini içe aktarır; burada işaretlenir.
vi.mock("@/components/search-actions/track-fix-button", () => ({
  TrackFixButton: ({ alertId }: { alertId: string }) =>
    createElement("span", { "data-track-fix": alertId }),
}));

// ActionForm geçirgen: eylem adını işaretler.
vi.mock("@/components/shared/action-form", () => ({
  ActionForm: ({
    action,
    children,
  }: {
    action: { getMockName?: () => string };
    children: ReactNode;
  }) =>
    createElement(
      "form",
      { "data-action": action?.getMockName?.() ?? "" },
      children,
    ),
}));

// CWV eşikleri sözleşmedeki değerler (C paketinin saf kütüphanesi).
vi.mock("@/lib/seo/cwv", () => {
  const thresholds: Record<string, [number, number]> = {
    lcp: [2500, 4000],
    inp: [200, 500],
    cls: [0.1, 0.25],
  };
  return {
    cwvRating: (metric: string, value: number | null) => {
      const pair = thresholds[metric];
      if (value === null || !pair) return null;
      return value <= pair[0]
        ? "good"
        : value <= pair[1]
          ? "needs-improvement"
          : "poor";
    },
  };
});

const { HealthPanelView } = await import("./health-panel-view");
const actions = await import("@/server/actions/search-health-actions");
vi.mocked(actions.requestInspectionAction).mockName("inspect");
vi.mocked(actions.checkSiteVerificationAction).mockName("verify");
vi.mocked(actions.setSiteCrawlAction).mockName("settings");
vi.mocked(actions.recrawlSiteAction).mockName("recrawl");
vi.mocked(actions.muteSearchAlertAction).mockName("mute");
vi.mocked(actions.deleteSiteAuditDataAction).mockName("delete");

const NOW = new Date("2026-10-06T12:00:00.000Z");

function keyPage(
  patch: Partial<SearchHealthPanel["keyPages"][number]>,
): SearchHealthPanel["keyPages"][number] {
  return {
    url: "https://www.example.com/",
    path: "/",
    isHomepage: true,
    status: 200,
    fetchError: null,
    robotsBlocked: false,
    noindex: false,
    indexable: true,
    googleLabel: "Indexed",
    googleLastCrawl: null,
    lastCheckedAt: NOW,
    canInspect: true,
    ...patch,
  };
}

function panel(patch: Partial<SearchHealthPanel> = {}): SearchHealthPanel {
  return {
    projectId: "proj-1",
    canManage: true,
    isMock: false,
    allowed: true,
    score: {
      value: 81,
      parts: [
        {
          key: "indexing",
          label: "Indexing",
          weight: 35,
          score: 82,
          available: true,
        },
        {
          key: "technical",
          label: "Technical",
          weight: 25,
          score: 80,
          available: true,
        },
        {
          key: "cwv",
          label: "Core Web Vitals",
          weight: 15,
          score: null,
          available: false,
        },
      ],
      cappedByCritical: false,
      computedAt: NOW,
    },
    scope: { state: "gsc", label: "example.com", verify: null },
    issues: [],
    coverage: null,
    inspections: null,
    keyPages: [],
    sitemaps: [],
    robots: null,
    crawl: null,
    cwv: null,
    lostUrls: null,
    updates: [],
    ...patch,
  };
}

const render = (value: SearchHealthPanel) =>
  renderToStaticMarkup(createElement(HealthPanelView, { panel: value }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

describe("HealthPanelView", () => {
  it("shows the score badge, its parts and when it was updated", () => {
    const html = render(panel());
    const plain = text(html);
    expect(plain).toContain("Index & technical health");
    expect(plain).toContain("Search health 81/100");
    expect(plain).toContain("Based on: Indexing, Technical");
    expect(plain).not.toContain("Core Web Vitals,");
    expect(plain).toContain("Updated");
    expect(html).toContain("emerald");
    expect(plain).not.toContain("Capped while a critical issue is open");
    expect(plain).not.toContain("not enabled");
  });

  it("shows — without a score, amber and red tones, and the critical cap", () => {
    expect(
      text(
        render(
          panel({
            score: {
              value: null,
              parts: [],
              cappedByCritical: false,
              computedAt: null,
            },
          }),
        ),
      ),
    ).toContain("Search health —");
    expect(
      render(
        panel({
          score: {
            value: 55,
            parts: [],
            cappedByCritical: false,
            computedAt: null,
          },
        }),
      ),
    ).toContain("amber");
    const capped = render(
      panel({
        score: {
          value: 40,
          parts: [],
          cappedByCritical: true,
          computedAt: null,
        },
      }),
    );
    expect(capped).toContain("rose");
    expect(text(capped)).toContain("Capped while a critical issue is open");
  });

  it("lists issues with their guide, opened from ?issue=", () => {
    const html = render(
      panel({
        issues: [
          {
            id: "a1",
            source: "SEO",
            kind: "SEO_KEY_PAGE_NOINDEX",
            severity: "CRITICAL",
            title: "Your homepage is set to noindex",
            detail: "Google drops pages marked noindex.",
            lastSeenAt: NOW,
            guide: {
              title: "Remove noindex",
              steps: [
                "Open the page template",
                "Remove the robots meta tag",
                "Ask Google to recrawl",
              ],
              screen: "URL Inspection",
              learnMoreUrl: "https://developers.google.com/search/docs/noindex",
            },
            open: true,
          },
          {
            id: "a2",
            source: "GSC",
            kind: "GSC_SITEMAP_ERRORS",
            severity: "WARN",
            title: "Your sitemap has errors",
            detail: null,
            lastSeenAt: NOW,
            guide: {
              title: "Fix sitemap",
              steps: ["Open Sitemaps"],
              screen: null,
              learnMoreUrl: null,
            },
            open: false,
          },
        ],
      }),
    );
    const plain = text(html);
    expect(plain).toContain("Critical Your homepage is set to noindex");
    expect(plain).toContain("Warning Your sitemap has errors");
    expect(plain).toContain("Remove the robots meta tag");
    expect(plain).toContain("In Search Console: URL Inspection");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toMatch(
      /<details[^>]*open=""[^>]*>\s*<summary[^>]*>How to fix/,
    );
    expect(html.match(/<details[^>]*open=""/g)).toHaveLength(1);
    expect(plain).toContain("Mute for 7 days");
    expect(html).toContain('data-action="mute"');
  });

  it("renders the tracking button only for issues with a tracked state (SC-F6)", () => {
    const issue = (id: string) => ({
      id,
      source: "SEO" as const,
      kind: "SEO_KEY_PAGE_NOINDEX",
      severity: "WARN" as const,
      title: `Issue ${id}`,
      detail: null,
      lastSeenAt: NOW,
      guide: { title: "Fix", steps: ["Do it"], screen: null, learnMoreUrl: null },
      open: false,
    });
    const value = panel({ issues: [issue("a1"), issue("a2")] });
    expect(render(value)).not.toContain("data-track-fix");
    const html = renderToStaticMarkup(
      createElement(HealthPanelView, {
        panel: value,
        tracked: { a1: { trackable: true } },
      }),
    );
    expect(html).toContain('data-track-fix="a1"');
    expect(html).not.toContain('data-track-fix="a2"');
  });

  it("shows the empty issue state", () => {
    expect(text(render(panel()))).toContain(
      "No search health issues right now.",
    );
  });

  it("explains coverage, collection and the inspection limit", () => {
    const ready = text(
      render(
        panel({
          coverage: {
            state: "ready",
            text: "~82% (±6%)",
            sampled: 64,
            point: 0.82,
            low: 0.76,
            high: 0.88,
            weekStart: "2026-09-28",
          },
          inspections: { used: 200, budget: 200, pausedUntil: null, queued: 0 },
        }),
      ),
    );
    expect(ready).toContain("~82% (±6%) of your sitemap pages are indexed");
    expect(ready).toContain(
      "Based on 64 pages checked with Google’s URL Inspection",
    );
    expect(ready).toContain("URL inspections today: 200 of 200");
    expect(ready).toContain(
      "Daily URL inspection limit reached. More checks tomorrow.",
    );

    expect(
      text(render(panel({ coverage: { state: "collecting", sampled: 7 } }))),
    ).toContain("Checking a sample of your sitemap pages (7 so far).");
    expect(
      text(render(panel({ coverage: { state: "needs_crawl" } }))),
    ).toContain("Turn on the site audit to estimate coverage.");
  });

  it("shows key page statuses", () => {
    const plain = text(
      render(
        panel({
          keyPages: [
            keyPage({}),
            keyPage({
              url: "https://www.example.com/a",
              path: "/a",
              isHomepage: false,
              robotsBlocked: true,
              status: null,
              indexable: false,
            }),
            keyPage({
              url: "https://www.example.com/b",
              path: "/b",
              isHomepage: false,
              fetchError: "LOOP",
              status: 301,
            }),
            keyPage({
              url: "https://www.example.com/c",
              path: "/c",
              isHomepage: false,
              fetchError: "TIMEOUT",
              status: null,
            }),
            keyPage({
              url: "https://www.example.com/d",
              path: "/d",
              isHomepage: false,
              status: null,
              lastCheckedAt: null,
              indexable: null,
              googleLabel: "Not checked yet",
            }),
            keyPage({
              url: "https://www.example.com/e",
              path: "/e",
              isHomepage: false,
              noindex: true,
              indexable: false,
              googleLabel: "Not indexed",
            }),
          ],
        }),
      ),
    );
    expect(plain).toContain("Homepage 200 Yes Indexed");
    expect(plain).toContain("/a Blocked by robots.txt No");
    expect(plain).toContain("/b Redirect loop");
    expect(plain).toContain("/c Didn't respond");
    expect(plain).toContain("/d Not checked yet — Not checked yet");
    expect(plain).toContain("/e 200 No (noindex) Not indexed");
    expect(plain).toContain("Last crawled by Google");
    expect(plain).toContain("Inspect");
  });

  it("hides Inspect without Search Console", () => {
    const html = render(
      panel({
        scope: { state: "verified", label: "example.com", verify: null },
        keyPages: [keyPage({ canInspect: false })],
      }),
    );
    expect(html).not.toContain('data-action="inspect"');
    expect(text(html)).toContain("Audit scope: example.com (verified)");
  });

  it("shows sitemaps, robots changes and AI crawler access", () => {
    const html = render(
      panel({
        sitemaps: [
          {
            url: "https://www.example.com/sitemap.xml",
            source: "ROBOTS",
            status: 200,
            urls: 40,
            googleErrors: 2,
            googleWarnings: 1,
            googleLastDownloaded: null,
          },
        ],
        robots: {
          verdict: "OK",
          fetchedAt: NOW,
          changedAt: new Date("2026-10-05T00:00:00.000Z"),
          diff: { added: ["disallow: /private"], removed: [] },
          aiAccess: [
            {
              token: "GPTBot",
              owner: "OpenAI",
              purpose: "training",
              allowed: false,
            },
            {
              token: "OAI-SearchBot",
              owner: "OpenAI",
              purpose: "search",
              allowed: true,
            },
          ],
        },
      }),
    );
    const plain = text(html);
    expect(plain).toContain("/sitemap.xml");
    expect(plain).toContain("40 pages");
    expect(plain).toContain("Google: 2 errors, 1 warnings");
    expect(plain).toContain("robots.txt found");
    expect(plain).toContain("Changed Oct 5, 2026");
    expect(plain).toContain("See changes");
    expect(plain).toContain("+ disallow: /private");
    expect(html).toContain('data-table="ai-crawlers"');
    expect(plain).toContain("GPTBot OpenAI AI training Blocked");
    expect(plain).toContain("OAI-SearchBot OpenAI Answers and search Allowed");
    expect(plain).toContain(
      "Your choice: blocking AI crawlers keeps your pages out of their answers.",
    );

    expect(
      text(
        render(
          panel({
            robots: {
              verdict: "MISSING",
              fetchedAt: NOW,
              changedAt: null,
              diff: null,
              aiAccess: [],
            },
          }),
        ),
      ),
    ).toContain("No robots.txt (everything is allowed)");
    expect(
      text(
        render(
          panel({
            robots: {
              verdict: "SERVER_ERROR",
              fetchedAt: NOW,
              changedAt: null,
              diff: null,
              aiAccess: [],
            },
          }),
        ),
      ),
    ).toContain("robots.txt is failing");
  });

  it("shows the technical audit with its controls", () => {
    const crawl: NonNullable<SearchHealthPanel["crawl"]> = {
      enabled: true,
      pageLimit: 250,
      available: true,
      running: true,
      blocked: true,
      lastFullAt: new Date("2026-10-01T02:00:00.000Z"),
      nextDueAt: null,
      pages: 137,
      groups: [
        {
          code: "TA1",
          title: "Pages without a title",
          severity: "WARN",
          count: 3,
          samples: ["/a", "/b"],
        },
      ],
      canRecrawl: true,
    };
    const html = render(panel({ crawl }));
    const plain = text(html);
    expect(plain).toContain("Last full check Oct 1, 2026 · 137 pages");
    expect(plain).toContain("Running…");
    expect(plain).toContain(
      "Our site audit is being blocked by your server or firewall. Allow AgentelseSiteAudit (see agentelse.com/bot), then check again.",
    );
    expect(plain).toContain("Warning Pages without a title 3 pages");
    expect(html).toContain('data-action="settings"');
    expect(html).toContain('data-action="recrawl"');
    expect(plain).toContain("Check again now");
    expect(html).toContain('data-action="delete"');
    expect(plain).toContain(
      "Your verification stays; crawled pages and checks are deleted.",
    );

    const member = render(
      panel({ canManage: false, crawl: { ...crawl, canRecrawl: false } }),
    );
    expect(member).not.toContain('data-action="settings"');
    expect(member).not.toContain('data-action="delete"');
    expect(member).not.toContain('data-action="recrawl"');

    expect(
      text(
        render(
          panel({
            crawl: { ...crawl, enabled: false, running: false, blocked: false },
          }),
        ),
      ),
    ).toContain("The site audit is off.");
  });

  it("shows Core Web Vitals only with data", () => {
    expect(render(panel())).not.toContain('data-card="cwv"');
    const plain = text(
      render(
        panel({
          cwv: {
            phone: {
              formFactor: "PHONE",
              p75: { lcp: 2140, inp: 310, cls: 0.312, fcp: null, ttfb: null },
              overall: "poor",
              collectionPeriod: "Sep 8 – Oct 5, 2026",
            },
            desktop: null,
          },
        }),
      ),
    );
    expect(plain).toContain("Phone · Poor");
    expect(plain).toContain("LCP 2.1 s (Good)");
    expect(plain).toContain("INP 310 ms (Needs improvement)");
    expect(plain).toContain("CLS 0.31 (Poor)");
    expect(plain).toContain(
      "Desktop Not enough Chrome users for field data yet.",
    );
    expect(plain).toContain(
      "Field data from real Chrome users, last 28 days (Sep 8 – Oct 5, 2026).",
    );
  });

  it("shows the redirect map", () => {
    const html = render(
      panel({
        lostUrls: {
          rows: [
            {
              from: "https://www.example.com/old",
              fromPath: "/old",
              to: "https://www.example.com/new",
              reason: "NOT_FOUND",
              score: 0.6,
              keyPage: true,
            },
            {
              from: "https://www.example.com/gone",
              fromPath: "/gone",
              to: null,
              reason: "TO_HOMEPAGE",
              score: 0,
              keyPage: false,
            },
          ],
          text: "/old https://www.example.com/new\n# /gone: no close match",
          lostClicksShare: 0.12,
          critical: false,
          checkedThrough: "2026-10-04",
        },
      }),
    );
    const plain = text(html);
    expect(plain).toContain(
      "/old Page not found (404) https://www.example.com/new",
    );
    expect(plain).toContain("/gone Redirects to the homepage No close match");
    expect(plain).toContain("permanent (301) redirects");
    expect(html).toMatch(/<textarea[^>]*readOnly=""[^>]*>/i);
    expect(html).toContain("# /gone: no close match");
  });

  it("asks for verification with both methods", () => {
    const html = render(
      panel({
        scope: {
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
        },
      }),
    );
    const plain = text(html);
    expect(plain).toContain("Verify your website to run the technical audit");
    expect(plain).toContain(
      '<meta name="agentelse-site-verification" content="TOKEN123">',
    );
    expect(plain).toContain("agentelse-site-verification=TOKEN123");
    expect(html).toContain('data-action="verify"');
    expect(plain).toContain("Check now");
  });

  it("explains a missing domain", () => {
    expect(
      text(
        render(
          panel({ scope: { state: "no_domain", label: null, verify: null } }),
        ),
      ),
    ).toContain(
      "Add your website address to this project to run the technical audit.",
    );
    expect(text(render(panel()))).toContain(
      "Audit scope: example.com (from Search Console)",
    );
  });

  it("says when the project is outside the rollout", () => {
    const html = render(
      panel({
        allowed: false,
        scope: { state: "needs_verification", label: null, verify: null },
        issues: [],
      }),
    );
    const plain = text(html);
    expect(plain).toContain(
      "Search health is not enabled for this project yet.",
    );
    expect(plain).toContain("Verify your website to run the technical audit");
    expect(html).not.toContain('data-action="verify"');
  });

  it("marks updates still rolling out", () => {
    const plain = text(
      render(
        panel({
          updates: [
            {
              name: "October 2026 core update",
              kind: "CORE",
              startedAt: new Date("2026-10-02T00:00:00.000Z"),
              endedAt: null,
              url: null,
            },
            {
              name: "August 2026 spam update",
              kind: "SPAM",
              startedAt: new Date("2026-08-10T00:00:00.000Z"),
              endedAt: new Date("2026-08-20T00:00:00.000Z"),
              url: "https://status.search.google.com/x",
            },
          ],
        }),
      ),
    );
    expect(plain).toContain(
      "October 2026 core update · Oct 2, 2026 · rolling out",
    );
    expect(plain).toContain(
      "August 2026 spam update · Aug 10, 2026 – Aug 20, 2026",
    );
  });
});
