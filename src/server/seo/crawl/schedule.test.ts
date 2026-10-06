import { describe, expect, it } from "vitest";

import {
  CRAWL_MIN_RELEASE_MS,
  REGRESSION_EVERY_MS,
  ROBOTS_BACKOFF_BASE_MS,
  ROBOTS_BACKOFF_MAX_MS,
  ROBOTS_CACHE_MS,
  SITEMAP_EVERY_MS,
} from "@/lib/seo/audit-constants";

import {
  inNightWindow,
  nextCrawlAt,
  nextLocalHour,
  type NextCrawlInput,
} from "./schedule";

// Bu dosyanın kanıtladığı: bırakış zamanı duraklatmaya, robots geri
// çekilmesine ve gece penceresine uyar, hiçbir zaman now + 1 dk'dan erken
// değildir ve boştaki/hatalı/gündüz bekleyen siteler sağlıklı sitenin 6
// saatlik bekçisini aç bırakmaz.

const HOUR = 3_600_000;
const MINUTE = 60_000;

function input(overrides: Partial<NextCrawlInput> = {}): NextCrawlInput {
  const now = overrides.now ?? new Date("2026-10-06T09:00:00Z");
  return {
    now,
    pausedUntil: null,
    robotsRetryAt: null,
    regressionDueAt: new Date(now.getTime() + 6 * HOUR),
    robotsFetchedAt: now,
    sitemapsCheckedAt: now,
    fullCrawlDueAt: new Date(now.getTime() + 3 * 24 * HOUR),
    fullRunning: false,
    crawlBlocked: false,
    hasFullCrawl: true,
    timezone: "Europe/Istanbul",
    ...overrides,
  };
}

describe("nextCrawlAt", () => {
  it("waits for a pause (429/503) before anything else", () => {
    const base = input();
    const pausedUntil = new Date(base.now.getTime() + 2 * HOUR);
    expect(
      nextCrawlAt({
        ...base,
        pausedUntil,
        regressionDueAt: new Date(base.now.getTime() - HOUR),
      }),
    ).toEqual(pausedUntil);
  });

  it("waits for the robots back-off while robots is failing", () => {
    const base = input();
    const robotsRetryAt = new Date(base.now.getTime() + 30 * MINUTE);
    expect(
      nextCrawlAt({
        ...base,
        robotsRetryAt,
        regressionDueAt: new Date(base.now.getTime() - HOUR),
      }),
    ).toEqual(robotsRetryAt);
  });

  it("moves a due full crawl outside the night to the next local 01:00 (Istanbul)", () => {
    // 09:00Z = 12:00 Istanbul; bir sonraki 01:00 = 22:00Z.
    const base = input({
      fullCrawlDueAt: new Date("2026-10-01T00:00:00Z"),
      regressionDueAt: new Date("2026-10-07T09:00:00Z"),
    });
    expect(nextCrawlAt(base)).toEqual(new Date("2026-10-06T22:00:00Z"));
  });

  it("moves a due full crawl outside the night to the next local 01:00 (Los Angeles)", () => {
    // 19:00Z = 12:00 PDT; bir sonraki 01:00 PDT = ertesi gün 08:00Z.
    const now = new Date("2026-10-06T19:00:00Z");
    const base = input({
      now,
      timezone: "America/Los_Angeles",
      robotsFetchedAt: now,
      sitemapsCheckedAt: now,
      fullCrawlDueAt: new Date("2026-10-01T00:00:00Z"),
      regressionDueAt: new Date("2026-10-08T00:00:00Z"),
    });
    expect(nextCrawlAt(base)).toEqual(new Date("2026-10-07T08:00:00Z"));
  });

  it("keeps a due full crawl at its due time inside the night window", () => {
    // 23:30Z = 02:30 Istanbul (gece penceresi): vade (geçmiş) → now + 1 dk.
    const now = new Date("2026-10-06T23:30:00Z");
    const base = input({
      now,
      robotsFetchedAt: now,
      sitemapsCheckedAt: now,
      fullCrawlDueAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(inNightWindow(now, "Europe/Istanbul")).toBe(true);
    expect(nextCrawlAt(base)).toEqual(
      new Date(now.getTime() + CRAWL_MIN_RELEASE_MS),
    );
  });

  it("continues a running full crawl a minute later", () => {
    const base = input({ fullRunning: true });
    expect(nextCrawlAt(base)).toEqual(new Date(base.now.getTime() + MINUTE));
  });

  it("excludes the full-crawl term while the crawl is blocked", () => {
    const base = input({
      crawlBlocked: true,
      fullRunning: true,
      fullCrawlDueAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(nextCrawlAt(base)).toEqual(base.regressionDueAt);
  });

  it("is never earlier than now + 1 minute (null terms count as now)", () => {
    const now = new Date("2026-10-06T09:00:00Z");
    const result = nextCrawlAt(
      input({
        now,
        regressionDueAt: null,
        robotsFetchedAt: null,
        sitemapsCheckedAt: null,
        fullCrawlDueAt: null,
        hasFullCrawl: false,
        pausedUntil: new Date(now.getTime() - HOUR),
        robotsRetryAt: new Date(now.getTime() - HOUR),
      }),
    );
    expect(result).toEqual(new Date(now.getTime() + CRAWL_MIN_RELEASE_MS));
  });

  it("uses the robots cache and sitemap terms", () => {
    const now = new Date("2026-10-06T09:00:00Z");
    const fetched = new Date(now.getTime() - ROBOTS_CACHE_MS + 2 * HOUR);
    expect(
      nextCrawlAt(
        input({
          now,
          robotsFetchedAt: fetched,
          sitemapsCheckedAt: new Date(
            now.getTime() - SITEMAP_EVERY_MS + 3 * HOUR,
          ),
        }),
      ),
    ).toEqual(new Date(now.getTime() + 2 * HOUR));
  });
});

describe("nextLocalHour", () => {
  it("returns the next local 01:00 strictly after now", () => {
    expect(
      nextLocalHour(new Date("2026-10-06T22:00:00Z"), "Europe/Istanbul", 1),
    ).toEqual(new Date("2026-10-07T22:00:00Z"));
    expect(
      nextLocalHour(new Date("2026-10-06T21:59:00Z"), "Europe/Istanbul", 1),
    ).toEqual(new Date("2026-10-06T22:00:00Z"));
  });

  it("falls back to UTC for an invalid timezone", () => {
    expect(
      nextLocalHour(new Date("2026-10-06T09:00:00Z"), "Not/AZone", 1),
    ).toEqual(new Date("2026-10-07T01:00:00Z"));
  });
});

// Koşucunun aday sorgusu ve site koşusunun sade bir modeli: crawlNextAt
// NOT NULL ≤ now, crawlNextAt'e göre sıralı, tick başına en çok `limit`.
type SimSite = {
  name: string;
  kind: "idle" | "robots500" | "dayFull" | "healthy";
  crawlNextAt: Date | null;
  robotsRetryAt: Date | null;
  robotsFailures: number;
  regressionDueAt: Date | null;
  robotsFetchedAt: Date | null;
  sitemapsCheckedAt: Date | null;
  fullCrawlDueAt: Date | null;
  fullRunningTicks: number;
  hasFullCrawl: boolean;
  regressions: number[];
};

function simSite(
  name: string,
  kind: SimSite["kind"],
  now: Date,
  overrides: Partial<SimSite> = {},
): SimSite {
  return {
    name,
    kind,
    crawlNextAt: kind === "idle" ? null : now,
    robotsRetryAt: null,
    robotsFailures: 0,
    regressionDueAt: null,
    robotsFetchedAt: null,
    sitemapsCheckedAt: null,
    fullCrawlDueAt: null,
    fullRunningTicks: 0,
    hasFullCrawl: false,
    regressions: [],
    ...overrides,
  };
}

const TIMEZONE = "Europe/Istanbul";

function simulateRun(site: SimSite, now: Date) {
  const t = now.getTime();
  if (site.kind === "robots500") {
    site.robotsFailures += 1;
    site.robotsRetryAt = new Date(
      t +
        Math.min(
          ROBOTS_BACKOFF_BASE_MS * 2 ** (site.robotsFailures - 1),
          ROBOTS_BACKOFF_MAX_MS,
        ),
    );
  } else {
    const regressionDue =
      !site.regressionDueAt || site.regressionDueAt.getTime() <= t;
    if (
      regressionDue ||
      !site.robotsFetchedAt ||
      t - site.robotsFetchedAt.getTime() >= ROBOTS_CACHE_MS
    ) {
      site.robotsFetchedAt = now;
    }
    if (
      !site.sitemapsCheckedAt ||
      t - site.sitemapsCheckedAt.getTime() >= SITEMAP_EVERY_MS
    ) {
      site.sitemapsCheckedAt = now;
    }
    if (regressionDue) {
      site.regressions.push(t);
      site.regressionDueAt = new Date(t + REGRESSION_EVERY_MS);
    }
    if (site.fullRunningTicks > 0) {
      site.fullRunningTicks -= 1;
      if (site.fullRunningTicks === 0) {
        site.hasFullCrawl = true;
        site.fullCrawlDueAt = new Date(t + 7 * 24 * HOUR);
      }
    } else {
      const due = !site.fullCrawlDueAt || site.fullCrawlDueAt.getTime() <= t;
      if (due && (!site.hasFullCrawl || inNightWindow(now, TIMEZONE))) {
        site.fullRunningTicks = 2;
      }
    }
  }
  site.crawlNextAt = nextCrawlAt({
    now,
    pausedUntil: null,
    robotsRetryAt: site.robotsRetryAt,
    regressionDueAt: site.regressionDueAt,
    robotsFetchedAt: site.robotsFetchedAt,
    sitemapsCheckedAt: site.sitemapsCheckedAt,
    fullCrawlDueAt: site.fullCrawlDueAt,
    fullRunning: site.fullRunningTicks > 0,
    crawlBlocked: false,
    hasFullCrawl: site.hasFullCrawl,
    timezone: TIMEZONE,
  });
}

describe("scheduling without starvation", () => {
  it("runs the healthy site's watchdog at least every 6 hours", () => {
    // 09:00Z = 12:00 Istanbul: gündüz vadesi gelmiş tam tarama bekler.
    const start = new Date("2026-10-06T09:00:00Z");
    const sites: SimSite[] = [
      simSite("idle-a", "idle", start),
      simSite("idle-b", "idle", start),
      simSite("robots-500", "robots500", start),
      simSite("day-full", "dayFull", start, {
        hasFullCrawl: true,
        fullCrawlDueAt: new Date("2026-10-01T00:00:00Z"),
      }),
      simSite("healthy", "healthy", start, {
        hasFullCrawl: true,
        fullCrawlDueAt: new Date(start.getTime() + 3 * 24 * HOUR),
      }),
    ];
    const limit = 3;
    for (let tick = 0; tick < 20; tick += 1) {
      const now = new Date(start.getTime() + tick * HOUR);
      const due = sites
        .filter(
          (site) =>
            site.crawlNextAt !== null &&
            site.crawlNextAt.getTime() <= now.getTime(),
        )
        .sort((a, b) => a.crawlNextAt!.getTime() - b.crawlNextAt!.getTime())
        .slice(0, limit);
      for (const site of due) simulateRun(site, now);
      for (const site of sites) {
        if (site.crawlNextAt) {
          expect(site.crawlNextAt.getTime()).toBeGreaterThanOrEqual(
            now.getTime() + CRAWL_MIN_RELEASE_MS,
          );
        }
      }
    }
    const healthy = sites.find((site) => site.name === "healthy")!;
    expect(healthy.regressions.length).toBeGreaterThanOrEqual(4);
    for (let index = 1; index < healthy.regressions.length; index += 1) {
      expect(
        healthy.regressions[index]! - healthy.regressions[index - 1]!,
      ).toBeLessThanOrEqual(REGRESSION_EVERY_MS);
    }
    const end = start.getTime() + 19 * HOUR;
    expect(
      end - healthy.regressions[healthy.regressions.length - 1]!,
    ).toBeLessThanOrEqual(REGRESSION_EVERY_MS);
    // Boştakiler hiç koşmaz; gündüz bekleyen tam tarama gece (01:00) başlar.
    expect(
      sites
        .filter((site) => site.kind === "idle")
        .every((site) => site.crawlNextAt === null),
    ).toBe(true);
    const dayFull = sites.find((site) => site.name === "day-full")!;
    expect(dayFull.fullCrawlDueAt!.getTime()).toBeGreaterThan(start.getTime());
  });
});
