import { describe, expect, it } from "vitest";

import { addDays, gscToday } from "@/lib/seo/dates";

import { SEARCH_ALERT_KIND_NAMES, type SearchAlertKind } from "./alert-kinds";
import {
  evaluateSearchHealth,
  type KeyPageCheck,
  type SearchHealthEvaluation,
  type SearchHealthInput,
} from "./checks";
import type { DropDay } from "./search-drop";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TODAY = gscToday(NOW);
const FINAL = addDays(TODAY, -3);

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function page(overrides: Partial<KeyPageCheck> = {}): KeyPageCheck {
  return {
    url: "https://example.com/",
    path: "/",
    isHomepage: true,
    status: 200,
    fetchError: null,
    previousFetchError: null,
    noindexMeta: false,
    noindexHeader: false,
    canonical: "https://example.com/",
    renderRisk: false,
    schemaErrors: 0,
    checkedAt: ago(HOUR),
    inspection: {
      verdict: "PASS",
      previousVerdict: "PASS",
      googleCanonical: "https://example.com/",
      userCanonical: "https://example.com/",
      lastCrawlTime: ago(5 * DAY),
      richResultErrors: 0,
    },
    ...overrides,
  };
}

const PRICING = page({
  url: "https://example.com/pricing",
  path: "/pricing",
  isHomepage: false,
  canonical: "https://example.com/pricing",
  inspection: {
    verdict: "PASS",
    previousVerdict: "PASS",
    googleCanonical: "https://example.com/pricing",
    userCanonical: "https://example.com/pricing",
    lastCrawlTime: ago(5 * DAY),
    richResultErrors: 0,
  },
});

function flatDays(lastTwo?: [number, number]): DropDay[] {
  const days: DropDay[] = [];
  for (let offset = 69; offset >= 0; offset -= 1) {
    const clicks = lastTwo && offset <= 1 ? lastTwo[offset === 1 ? 0 : 1] : 100;
    days.push({ day: addDays(FINAL, -offset), clicks, nonBrandClicks: null });
  }
  return days;
}

type Gsc = NonNullable<SearchHealthInput["gsc"]>;

function base(): SearchHealthInput {
  return {
    now: NOW,
    projectStatus: "ACTIVE",
    scope: {
      kind: "GSC_DOMAIN",
      root: "example.com",
      prefix: null,
      key: "GSC_DOMAIN:example.com:",
    },
    crawlEnabled: true,
    crawlBlocked: false,
    lastFullCrawlAt: ago(2 * DAY),
    lastRegressionAt: ago(HOUR),
    lastFull: {
      status: "DONE",
      pagesFetched: 100,
      finishedAt: ago(2 * DAY),
      newUrls: 0,
      knownNowRedirect: 0,
      knownRefetched: 80,
    },
    keyPages: [page(), PRICING],
    robots: {
      verdict: "OK",
      failures: 0,
      fetchedAt: ago(HOUR),
      body: "User-agent: *\nAllow: /\n",
    },
    sitemaps: {
      checkedAt: ago(HOUR),
      summaries: [
        { url: "https://example.com/sitemap.xml", status: 200, kind: "urlset" },
      ],
    },
    homepageAssets: ["https://example.com/app.js"],
    httpRedirectsToHttps: true,
    issues: {
      counts: {},
      redirectChainsLinked: 0,
      httpPages: 0,
      sitemapCrawled: 50,
      sitemapBad: 0,
    },
    technicalCleanShare: 0.9,
    cwv: {
      enabled: true,
      checkedAt: ago(2 * DAY),
      overall: "good",
      worsened: false,
      hasOrigin: true,
    },
    gsc: {
      link: {
        createdAt: ago(30 * DAY),
        health: "OK",
        domainMatch: true,
        lastFinalDate: FINAL,
        consecutiveFailures: 0,
        lastDailyAt: ago(2 * HOUR),
      },
      today: TODAY,
      days: flatDays(),
      updates: [],
      coverage: {
        current: {
          weekStart: "2026-09-28",
          sampled: 50,
          indexed: 45,
          crawledNotIndexed: 2,
          point: 0.9,
          low: 0.8,
          high: 0.95,
        },
        earlier: {
          weekStart: "2026-08-31",
          sampled: 50,
          indexed: 45,
          crawledNotIndexed: 2,
          point: 0.9,
          low: 0.8,
          high: 0.95,
        },
        dropped: false,
      },
      newSitemapUrls: { inspected: 10, notIndexed: 1 },
      sitemaps: {
        checkedAt: ago(HOUR),
        rows: [
          {
            path: "https://example.com/sitemap.xml",
            isPending: false,
            lastSubmitted: ago(30 * DAY),
            lastDownloaded: ago(2 * DAY),
            errors: 0,
          },
        ],
      },
      lostUrls: { rows: [], lostClicksShare: 0 },
      orphanPaths: [],
    },
  };
}

function withGsc(patch: Partial<Gsc>): SearchHealthInput {
  const input = base();
  return { ...input, gsc: { ...input.gsc!, ...patch } };
}

function draftOf(result: SearchHealthEvaluation, kind: SearchAlertKind) {
  return result.drafts.find((draft) => draft.kind === kind) ?? null;
}

function evaluatedKinds(result: SearchHealthEvaluation): SearchAlertKind[] {
  return [...result.evaluated.GSC, ...result.evaluated.SEO];
}

function isEvaluated(result: SearchHealthEvaluation, kind: SearchAlertKind) {
  return evaluatedKinds(result).includes(kind);
}

function withRobots(body: string): SearchHealthInput {
  const input = base();
  return { ...input, robots: { ...input.robots!, body } };
}

function withPages(...pages: KeyPageCheck[]): SearchHealthInput {
  return { ...base(), keyPages: pages };
}

describe("evaluateSearchHealth baseline", () => {
  it("raises nothing and evaluates every kind for a healthy site", () => {
    const result = evaluateSearchHealth(base());
    expect(result.drafts).toEqual([]);
    expect(evaluatedKinds(result).sort()).toEqual(
      [...SEARCH_ALERT_KIND_NAMES].sort(),
    );
    expect(result.available).toEqual({
      indexing: true,
      technical: true,
      sitemap_robots: true,
      cwv: true,
      data: true,
    });
    expect(result.coveragePoint).toBe(0.9);
    expect(result.technicalCleanShare).toBe(0.9);
  });

  it("uses source-prefixed dedupe keys", () => {
    const result = evaluateSearchHealth(withPages(page({ noindexMeta: true })));
    expect(draftOf(result, "SEO_KEY_PAGE_NOINDEX")?.dedupeKey).toBe(
      "seo:SEO_KEY_PAGE_NOINDEX",
    );
  });
});

describe("SH1 sync stale", () => {
  it("allows five days and alerts on the sixth", () => {
    const edge = evaluateSearchHealth(
      withGsc({
        link: { ...base().gsc!.link, lastFinalDate: addDays(TODAY, -5) },
      }),
    );
    expect(draftOf(edge, "GSC_SYNC_STALE")).toBeNull();
    const stale = evaluateSearchHealth(
      withGsc({
        link: { ...base().gsc!.link, lastFinalDate: addDays(TODAY, -6) },
      }),
    );
    expect(draftOf(stale, "GSC_SYNC_STALE")?.severity).toBe("WARN");
  });

  it("waits 48 hours after the link is created", () => {
    const young = evaluateSearchHealth(
      withGsc({
        link: {
          ...base().gsc!.link,
          createdAt: ago(24 * HOUR),
          lastFinalDate: null,
        },
      }),
    );
    expect(draftOf(young, "GSC_SYNC_STALE")).toBeNull();
  });

  it("alerts after repeated failures with no recent daily sync", () => {
    const failing = evaluateSearchHealth(
      withGsc({
        link: {
          ...base().gsc!.link,
          consecutiveFailures: 3,
          lastDailyAt: ago(37 * HOUR),
        },
      }),
    );
    expect(draftOf(failing, "GSC_SYNC_STALE")).not.toBeNull();
  });
});

describe("SH2 search drop and SH23 overlap", () => {
  it("raises a GSC drop alert with the metric, percentage and dates", () => {
    const result = evaluateSearchHealth(withGsc({ days: flatDays([40, 45]) }));
    const draft = draftOf(result, "GSC_SEARCH_DROP");
    expect(draft).toMatchObject({ source: "GSC", severity: "CRITICAL" });
    expect(draft?.detail).toContain("Clicks from Google were at most 45%");
    expect(draft?.detail).not.toContain("rollout");
    expect(isEvaluated(result, "GSC_UPDATE_OVERLAP")).toBe(true);
    expect(draftOf(result, "GSC_UPDATE_OVERLAP")).toBeNull();
  });

  it("names an overlapping Google update", () => {
    const result = evaluateSearchHealth(
      withGsc({
        days: flatDays([60, 70]),
        updates: [
          {
            name: "October 2026 core update",
            startedAt: new Date(`${addDays(FINAL, -5)}T15:00:00Z`),
            endedAt: null,
          },
        ],
      }),
    );
    expect(draftOf(result, "GSC_SEARCH_DROP")?.severity).toBe("WARN");
    expect(draftOf(result, "GSC_SEARCH_DROP")?.detail).toContain(
      "Started during the October 2026 core update rollout.",
    );
    expect(draftOf(result, "GSC_UPDATE_OVERLAP")).toMatchObject({
      source: "GSC",
      severity: "INFO",
    });
  });

  it("does not judge a drop on stale data", () => {
    const result = evaluateSearchHealth(
      withGsc({
        days: flatDays([10, 10]),
        link: { ...base().gsc!.link, lastFinalDate: addDays(TODAY, -6) },
      }),
    );
    expect(draftOf(result, "GSC_SEARCH_DROP")).toBeNull();
    expect(isEvaluated(result, "GSC_SEARCH_DROP")).toBe(false);
  });
});

describe("SH3 key page noindex", () => {
  it("titles the homepage and says meta tag", () => {
    const result = evaluateSearchHealth(
      withPages(page({ noindexMeta: true }), PRICING),
    );
    const draft = draftOf(result, "SEO_KEY_PAGE_NOINDEX");
    expect(draft).toMatchObject({
      severity: "CRITICAL",
      title: "Your homepage is set to noindex",
    });
    expect(draft?.detail).toContain("/ (meta tag)");
  });

  it("says X-Robots-Tag header for other key pages", () => {
    const result = evaluateSearchHealth(
      withPages(page(), { ...PRICING, noindexHeader: true }),
    );
    const draft = draftOf(result, "SEO_KEY_PAGE_NOINDEX");
    expect(draft?.title).toBe("A key page is set to noindex");
    expect(draft?.detail).toContain("/pricing (X-Robots-Tag header)");
  });

  it("keeps the alert open when the noindex check is stale", () => {
    const result = evaluateSearchHealth(
      withPages(page(), {
        ...PRICING,
        noindexMeta: true,
        checkedAt: ago(13 * HOUR),
      }),
    );
    expect(draftOf(result, "SEO_KEY_PAGE_NOINDEX")).toBeNull();
    expect(isEvaluated(result, "SEO_KEY_PAGE_NOINDEX")).toBe(false);
  });
});

describe("SH4 robots", () => {
  it("is CRITICAL when Googlebot is disallowed from the site", () => {
    const result = evaluateSearchHealth(
      withRobots(
        "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
      ),
    );
    const draft = draftOf(result, "SEO_ROBOTS_BLOCK");
    expect(draft?.severity).toBe("CRITICAL");
    expect(draft?.detail).toContain("Google is blocked");
  });

  it("is CRITICAL when the '*' group blocks everything despite a permissive Googlebot group", () => {
    const result = evaluateSearchHealth(
      withRobots(
        "User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n",
      ),
    );
    const draft = draftOf(result, "SEO_ROBOTS_BLOCK");
    expect(draft?.severity).toBe("CRITICAL");
    expect(draft?.detail).toContain(
      "Other search engines are blocked (rules for all crawlers)",
    );
    expect(draft?.detail).not.toContain("Google is blocked");
  });

  it("names blocked key pages", () => {
    const result = evaluateSearchHealth(
      withRobots("User-agent: *\nDisallow: /pricing\n"),
    );
    expect(draftOf(result, "SEO_ROBOTS_BLOCK")?.detail).toContain("/pricing");
  });

  it("never alerts on a missing robots.txt", () => {
    const input = base();
    const result = evaluateSearchHealth({
      ...input,
      robots: {
        verdict: "MISSING",
        failures: 0,
        fetchedAt: ago(HOUR),
        body: null,
      },
    });
    for (const kind of [
      "SEO_ROBOTS_BLOCK",
      "SEO_ROBOTS_ERROR",
      "SEO_ROBOTS_ASSETS",
    ] as const) {
      expect(draftOf(result, kind)).toBeNull();
      expect(isEvaluated(result, kind)).toBe(true);
    }
  });

  it("needs a confirmed failure for SEO_ROBOTS_ERROR", () => {
    const input = base();
    const unconfirmed = evaluateSearchHealth({
      ...input,
      robots: {
        verdict: "SERVER_ERROR",
        failures: 0,
        fetchedAt: ago(HOUR),
        body: null,
      },
    });
    expect(draftOf(unconfirmed, "SEO_ROBOTS_ERROR")).toBeNull();
    const confirmed = evaluateSearchHealth({
      ...input,
      robots: {
        verdict: "SERVER_ERROR",
        failures: 1,
        fetchedAt: ago(HOUR),
        body: null,
      },
    });
    expect(draftOf(confirmed, "SEO_ROBOTS_ERROR")?.severity).toBe("CRITICAL");
    // İçerik bilinmiyor: engel türü açık kalır.
    expect(isEvaluated(confirmed, "SEO_ROBOTS_BLOCK")).toBe(false);
  });

  it("warns when assets are blocked", () => {
    const result = evaluateSearchHealth(
      withRobots("User-agent: *\nDisallow: /app.js\n"),
    );
    expect(draftOf(result, "SEO_ROBOTS_ASSETS")?.severity).toBe("WARN");
    expect(draftOf(result, "SEO_ROBOTS_BLOCK")).toBeNull();
  });

  it("does not evaluate robots kinds on a stale fetch", () => {
    const input = base();
    const result = evaluateSearchHealth({
      ...input,
      robots: { ...input.robots!, fetchedAt: ago(27 * HOUR) },
    });
    expect(isEvaluated(result, "SEO_ROBOTS_BLOCK")).toBe(false);
    expect(isEvaluated(result, "SEO_ROBOTS_ERROR")).toBe(false);
  });
});

describe("SH5 key page errors", () => {
  it("alerts on 410 and on redirect loops", () => {
    expect(
      draftOf(
        evaluateSearchHealth(withPages(page(), { ...PRICING, status: 410 })),
        "SEO_KEY_PAGE_ERROR",
      )?.severity,
    ).toBe("CRITICAL");
    expect(
      draftOf(
        evaluateSearchHealth(
          withPages(page(), { ...PRICING, status: null, fetchError: "LOOP" }),
        ),
        "SEO_KEY_PAGE_ERROR",
      )?.detail,
    ).toContain("redirect loop");
  });

  it("needs two consecutive network errors", () => {
    const once = evaluateSearchHealth(
      withPages(page(), { ...PRICING, status: null, fetchError: "TIMEOUT" }),
    );
    expect(draftOf(once, "SEO_KEY_PAGE_ERROR")).toBeNull();
    const twice = evaluateSearchHealth(
      withPages(page(), {
        ...PRICING,
        status: null,
        fetchError: "TIMEOUT",
        previousFetchError: "TIMEOUT",
      }),
    );
    expect(draftOf(twice, "SEO_KEY_PAGE_ERROR")).not.toBeNull();
  });

  it("does not treat a homepage 403 as an error", () => {
    const result = evaluateSearchHealth(
      withPages(page({ status: 403 }), PRICING),
    );
    expect(draftOf(result, "SEO_KEY_PAGE_ERROR")).toBeNull();
  });
});

describe("SH6 canonicals and SH7 index loss", () => {
  it("is CRITICAL when a key page's canonical is on another site", () => {
    const result = evaluateSearchHealth(
      withPages(page(), { ...PRICING, canonical: "https://other.com/pricing" }),
    );
    expect(draftOf(result, "SEO_CANONICAL_OFFSITE")?.severity).toBe("CRITICAL");
    const sameSite = evaluateSearchHealth(
      withPages(page(), {
        ...PRICING,
        canonical: "https://blog.example.com/x",
      }),
    );
    expect(draftOf(sameSite, "SEO_CANONICAL_OFFSITE")).toBeNull();
  });

  it("warns when Google picks another canonical", () => {
    const result = evaluateSearchHealth(
      withPages(page(), {
        ...PRICING,
        inspection: {
          ...PRICING.inspection!,
          googleCanonical: "https://example.com/plans",
        },
      }),
    );
    expect(draftOf(result, "GSC_CANONICAL_MISMATCH")).toMatchObject({
      source: "GSC",
      severity: "WARN",
    });
  });

  it("is CRITICAL when a key page goes from PASS to NEUTRAL", () => {
    const result = evaluateSearchHealth(
      withPages(page(), {
        ...PRICING,
        inspection: { ...PRICING.inspection!, verdict: "NEUTRAL" },
      }),
    );
    expect(draftOf(result, "GSC_INDEX_LOST")?.severity).toBe("CRITICAL");
  });
});

describe("SH8–SH13 indexing and sitemaps", () => {
  it("SH8 alerts above 30% only", () => {
    const edge = evaluateSearchHealth(
      withGsc({ newSitemapUrls: { inspected: 10, notIndexed: 3 } }),
    );
    expect(draftOf(edge, "GSC_NEW_PAGES_NOT_INDEXED")).toBeNull();
    const over = evaluateSearchHealth(
      withGsc({ newSitemapUrls: { inspected: 10, notIndexed: 4 } }),
    );
    expect(draftOf(over, "GSC_NEW_PAGES_NOT_INDEXED")?.severity).toBe("WARN");
    const few = evaluateSearchHealth(
      withGsc({ newSitemapUrls: { inspected: 4, notIndexed: 4 } }),
    );
    expect(draftOf(few, "GSC_NEW_PAGES_NOT_INDEXED")).toBeNull();
  });

  it("SH9 alerts under 70% or on a non-overlapping drop", () => {
    const coverage = base().gsc!.coverage!;
    const at70 = evaluateSearchHealth(
      withGsc({
        coverage: {
          ...coverage,
          current: { ...coverage.current!, point: 0.7 },
        },
      }),
    );
    expect(draftOf(at70, "GSC_COVERAGE_DROP")).toBeNull();
    const under = evaluateSearchHealth(
      withGsc({
        coverage: {
          ...coverage,
          current: { ...coverage.current!, point: 0.69 },
        },
      }),
    );
    expect(draftOf(under, "GSC_COVERAGE_DROP")?.severity).toBe("WARN");
    const dropped = evaluateSearchHealth(
      withGsc({ coverage: { ...coverage, dropped: true } }),
    );
    expect(draftOf(dropped, "GSC_COVERAGE_DROP")?.title).toBe(
      "Fewer of your sitemap pages are indexed",
    );
    const small = evaluateSearchHealth(
      withGsc({
        coverage: {
          ...coverage,
          current: { ...coverage.current!, sampled: 19, point: 0.2 },
        },
      }),
    );
    expect(draftOf(small, "GSC_COVERAGE_DROP")).toBeNull();
  });

  it("SH10 needs a doubling to at least 10%", () => {
    const coverage = base().gsc!.coverage!;
    const doubled = evaluateSearchHealth(
      withGsc({
        coverage: {
          ...coverage,
          earlier: { ...coverage.earlier!, crawledNotIndexed: 3 },
          current: { ...coverage.current!, crawledNotIndexed: 6 },
        },
      }),
    );
    expect(draftOf(doubled, "GSC_CRAWLED_NOT_INDEXED")?.severity).toBe("WARN");
    const notDoubled = evaluateSearchHealth(
      withGsc({
        coverage: {
          ...coverage,
          earlier: { ...coverage.earlier!, crawledNotIndexed: 3 },
          current: { ...coverage.current!, crawledNotIndexed: 5 },
        },
      }),
    );
    expect(draftOf(notDoubled, "GSC_CRAWLED_NOT_INDEXED")).toBeNull();
  });

  it("SH11 flags a sitemap pending for more than 7 days", () => {
    const row = base().gsc!.sitemaps!.rows[0]!;
    const pending = evaluateSearchHealth(
      withGsc({
        sitemaps: {
          checkedAt: ago(HOUR),
          rows: [{ ...row, isPending: true, lastSubmitted: ago(8 * DAY) }],
        },
      }),
    );
    expect(draftOf(pending, "GSC_SITEMAP_ERRORS")?.severity).toBe("WARN");
    const recent = evaluateSearchHealth(
      withGsc({
        sitemaps: {
          checkedAt: ago(HOUR),
          rows: [{ ...row, isPending: true, lastSubmitted: ago(6 * DAY) }],
        },
      }),
    );
    expect(draftOf(recent, "GSC_SITEMAP_ERRORS")).toBeNull();
  });

  it("SH11 flags a missing own sitemap", () => {
    const result = evaluateSearchHealth({
      ...base(),
      sitemaps: { checkedAt: ago(HOUR), summaries: [] },
    });
    expect(draftOf(result, "SEO_SITEMAP_MISSING")?.title).toBe(
      "No sitemap found",
    );
  });

  it("SH12 needs at least 20 pages and more than 5% bad", () => {
    const issues = base().issues!;
    const over = evaluateSearchHealth({
      ...base(),
      issues: { ...issues, sitemapCrawled: 20, sitemapBad: 2 },
    });
    expect(draftOf(over, "SEO_SITEMAP_HYGIENE")?.severity).toBe("WARN");
    const atEdge = evaluateSearchHealth({
      ...base(),
      issues: { ...issues, sitemapCrawled: 20, sitemapBad: 1 },
    });
    expect(draftOf(atEdge, "SEO_SITEMAP_HYGIENE")).toBeNull();
    const small = evaluateSearchHealth({
      ...base(),
      issues: { ...issues, sitemapCrawled: 19, sitemapBad: 5 },
    });
    expect(draftOf(small, "SEO_SITEMAP_HYGIENE")).toBeNull();
  });

  it("SH13 flags key pages Google has not crawled for 60 days", () => {
    const old = evaluateSearchHealth(
      withPages(page(), {
        ...PRICING,
        inspection: { ...PRICING.inspection!, lastCrawlTime: ago(61 * DAY) },
      }),
    );
    expect(draftOf(old, "GSC_STALE_CRAWL")?.severity).toBe("INFO");
    const recent = evaluateSearchHealth(
      withPages(page(), {
        ...PRICING,
        inspection: { ...PRICING.inspection!, lastCrawlTime: ago(59 * DAY) },
      }),
    );
    expect(draftOf(recent, "GSC_STALE_CRAWL")).toBeNull();
  });
});

describe("SH15 Core Web Vitals", () => {
  it("is WARN when poor or worsened and INFO when it needs improvement", () => {
    const cwv = base().cwv!;
    expect(
      draftOf(
        evaluateSearchHealth({ ...base(), cwv: { ...cwv, overall: "poor" } }),
        "SEO_CWV_POOR",
      )?.severity,
    ).toBe("WARN");
    expect(
      draftOf(
        evaluateSearchHealth({
          ...base(),
          cwv: { ...cwv, overall: "needs-improvement" },
        }),
        "SEO_CWV_POOR",
      )?.severity,
    ).toBe("INFO");
    expect(
      draftOf(
        evaluateSearchHealth({ ...base(), cwv: { ...cwv, worsened: true } }),
        "SEO_CWV_POOR",
      )?.severity,
    ).toBe("WARN");
  });
});

describe("SH19 orphan pages", () => {
  it("runs only after a DONE full crawl", () => {
    const input = base();
    const done = evaluateSearchHealth({
      ...input,
      issues: { ...input.issues!, counts: { TA13: 3 } },
      gsc: { ...input.gsc!, orphanPaths: ["/old-guide"] },
    });
    expect(draftOf(done, "SEO_ORPHAN_PAGES")?.severity).toBe("INFO");
    expect(draftOf(done, "GSC_ORPHAN_PAGES")?.detail).toContain("/old-guide");

    const partial = evaluateSearchHealth({
      ...input,
      lastFull: { ...input.lastFull!, status: "PARTIAL" },
      issues: { ...input.issues!, counts: { TA13: 3 } },
      gsc: { ...input.gsc!, orphanPaths: ["/old-guide"] },
    });
    expect(draftOf(partial, "SEO_ORPHAN_PAGES")).toBeNull();
    expect(draftOf(partial, "GSC_ORPHAN_PAGES")).toBeNull();
    expect(isEvaluated(partial, "SEO_ORPHAN_PAGES")).toBe(false);
  });
});

describe("SH24–SH27", () => {
  it("SH24 warns on a domain mismatch", () => {
    const result = evaluateSearchHealth(
      withGsc({ link: { ...base().gsc!.link, domainMatch: false } }),
    );
    expect(draftOf(result, "GSC_SITE_MISMATCH")?.severity).toBe("WARN");
  });

  it("SH25 describes the connection problem in user terms", () => {
    const result = evaluateSearchHealth(
      withGsc({ link: { ...base().gsc!.link, health: "NEEDS_PERMISSION" } }),
    );
    expect(draftOf(result, "GSC_CONNECTION")).toMatchObject({
      severity: "WARN",
      title: "Agentelse needs permission to read Search Console",
    });
    const degraded = evaluateSearchHealth(
      withGsc({ link: { ...base().gsc!.link, health: "DEGRADED" } }),
    );
    expect(draftOf(degraded, "GSC_CONNECTION")).toBeNull();
  });

  it("SH26 notes blocked AI search crawlers", () => {
    const result = evaluateSearchHealth(
      withRobots(
        "User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
      ),
    );
    const draft = draftOf(result, "SEO_AI_CRAWLERS_BLOCKED");
    expect(draft?.severity).toBe("INFO");
    expect(draft?.detail).toContain("OAI-SearchBot (OpenAI)");
    expect(draft?.detail).not.toContain("GPTBot");
    expect(draftOf(result, "SEO_ROBOTS_BLOCK")).toBeNull();
  });

  it("SH27 is CRITICAL for a lost key page or more than 10% of clicks", () => {
    const key = evaluateSearchHealth(
      withGsc({
        lostUrls: {
          rows: [{ fromPath: "/pricing", keyPage: true }],
          lostClicksShare: 0.01,
        },
      }),
    );
    expect(draftOf(key, "GSC_LOST_URLS")).toMatchObject({
      source: "GSC",
      severity: "CRITICAL",
    });
    const share = evaluateSearchHealth(
      withGsc({
        lostUrls: {
          rows: [{ fromPath: "/a", keyPage: false }],
          lostClicksShare: 0.11,
        },
      }),
    );
    expect(draftOf(share, "GSC_LOST_URLS")?.severity).toBe("CRITICAL");
    const minor = evaluateSearchHealth(
      withGsc({
        lostUrls: {
          rows: [{ fromPath: "/a", keyPage: false }],
          lostClicksShare: 0.05,
        },
      }),
    );
    expect(draftOf(minor, "GSC_LOST_URLS")?.severity).toBe("WARN");
  });

  it("SH27 flags a site migration from the crawl stats", () => {
    const input = base();
    const result = evaluateSearchHealth({
      ...input,
      lastFull: {
        ...input.lastFull!,
        pagesFetched: 60,
        newUrls: 20,
        knownRefetched: 40,
        knownNowRedirect: 8,
      },
    });
    expect(draftOf(result, "SEO_SITE_MIGRATION")?.severity).toBe("WARN");
  });

  it("notes when the site blocks our crawler", () => {
    const result = evaluateSearchHealth({ ...base(), crawlBlocked: true });
    expect(draftOf(result, "SEO_CRAWL_BLOCKED")?.severity).toBe("INFO");
  });
});

describe("evaluated kinds", () => {
  it("keeps kinds with stale input unevaluated", () => {
    const input = base();
    const result = evaluateSearchHealth({
      ...input,
      lastFullCrawlAt: ago(9 * DAY),
      sitemaps: { ...input.sitemaps!, checkedAt: ago(27 * HOUR) },
      cwv: { ...input.cwv!, checkedAt: ago(9 * DAY) },
      keyPages: input.keyPages!.map((row) => ({
        ...row,
        checkedAt: ago(13 * HOUR),
      })),
    });
    for (const kind of [
      "SEO_HTTPS",
      "SEO_BROKEN_LINKS",
      "SEO_SITEMAP_MISSING",
      "SEO_CWV_POOR",
      "SEO_KEY_PAGE_NOINDEX",
      "SEO_KEY_PAGE_ERROR",
      "GSC_LOST_URLS",
    ] as const) {
      expect(isEvaluated(result, kind)).toBe(false);
    }
  });

  it("keeps kinds whose input could not be read unevaluated", () => {
    const result = evaluateSearchHealth({
      ...base(),
      keyPages: null,
      issues: null,
      gsc: { ...base().gsc!, lostUrls: null, coverage: null },
    });
    expect(isEvaluated(result, "SEO_KEY_PAGE_NOINDEX")).toBe(false);
    expect(isEvaluated(result, "GSC_INDEX_LOST")).toBe(false);
    expect(isEvaluated(result, "SEO_HTTPS")).toBe(false);
    expect(isEvaluated(result, "GSC_LOST_URLS")).toBe(false);
    expect(isEvaluated(result, "GSC_COVERAGE_DROP")).toBe(false);
  });

  it("evaluates crawler kinds with no drafts when the crawl is off", () => {
    const input = base();
    const result = evaluateSearchHealth({
      ...input,
      crawlEnabled: false,
      keyPages: [page({ noindexMeta: true })],
      gsc: {
        ...input.gsc!,
        lostUrls: {
          rows: [{ fromPath: "/a", keyPage: true }],
          lostClicksShare: 0.5,
        },
      },
    });
    expect(
      result.drafts.filter(
        (draft) => draft.source === "SEO" && draft.kind !== "SEO_CWV_POOR",
      ),
    ).toEqual([]);
    expect(draftOf(result, "GSC_LOST_URLS")).toBeNull();
    for (const kind of [
      "SEO_KEY_PAGE_NOINDEX",
      "SEO_ROBOTS_BLOCK",
      "SEO_CRAWL_BLOCKED",
      "GSC_LOST_URLS",
      "GSC_COVERAGE_DROP",
    ] as const) {
      expect(isEvaluated(result, kind)).toBe(true);
    }
    expect(result.available.technical).toBe(false);
    expect(result.coveragePoint).toBeNull();
  });

  it("evaluates every GSC kind with no drafts without a GSC link", () => {
    const result = evaluateSearchHealth({ ...base(), gsc: null });
    expect(result.drafts.filter((draft) => draft.source === "GSC")).toEqual([]);
    expect(result.evaluated.GSC.length).toBe(
      SEARCH_ALERT_KIND_NAMES.filter((kind) => kind.startsWith("GSC_")).length,
    );
    expect(result.available.data).toBe(false);
    expect(result.available.indexing).toBe(false);
  });

  it("evaluates everything with no drafts for a paused project", () => {
    const result = evaluateSearchHealth({
      ...base(),
      projectStatus: "PAUSED",
      keyPages: [page({ noindexMeta: true })],
    });
    expect(result.drafts).toEqual([]);
    expect(evaluatedKinds(result).sort()).toEqual(
      [...SEARCH_ALERT_KIND_NAMES].sort(),
    );
  });
});
