import { describe, expect, it } from "vitest";

import { summarizeGaLinks, type GaLinkHealthInput } from "./health-counters";

// Bu dosyanın kanıtladığı (GA-F2 bölüm 2, /health sayaçları): bağlar sağlık
// durumuna göre sayılır; gecikme bağın saat dilimiyle ölçülür; kota payları
// yalnız bugünün Pasifik gününden ve son bir saatten okunur, mock bağlar ve
// bozuk değerler hariç; ek geçmişler backfill.addons'tan okunur.

// 2026-10-06 03:30 UTC: İstanbul'da 6 Ekim, Los Angeles'ta hâlâ 5 Ekim.
const now = new Date("2026-10-06T03:30:00.000Z");

function link(overrides: Partial<GaLinkHealthInput> = {}): GaLinkHealthInput {
  return {
    health: "OK",
    isMock: false,
    consecutiveFailures: 0,
    rateLimitedUntil: null,
    lastDailyAt: new Date("2026-10-05T14:00:00.000Z"),
    backfillDoneAt: new Date("2026-09-01T00:00:00.000Z"),
    lastQuota: null,
    catalog: null,
    backfill: null,
    timeZone: "Europe/Istanbul",
    latestDay: "2026-10-05",
    ...overrides,
  };
}

function quota(
  atIso: string,
  daily: [number, number],
  hourly: [number, number] = [0, 40_000],
) {
  return {
    at: atIso,
    quota: {
      tokensPerDay: { consumed: daily[0], remaining: daily[1] },
      tokensPerHour: { consumed: hourly[0], remaining: hourly[1] },
    },
  };
}

describe("summarizeGaLinks", () => {
  it("returns zeros for no links", () => {
    expect(summarizeGaLinks([], now)).toEqual({
      links: { total: 0, mock: 0, byHealth: {} },
      sync: {
        failing: 0,
        rateLimited: 0,
        neverSynced: 0,
        lagOver2Days: 0,
        backfillPending: 0,
        addonsPending: 0,
        heartbeatMinutesAgo: null,
      },
      quota: { maxDailyShare: null, overHalfDaily: 0, overHalfHourly: 0 },
      catalog: {
        droppedReports: 0,
        linksWithDeprecated: 0,
        googleAdsEnabled: 0,
        searchConsoleEnabled: 0,
      },
    });
  });

  it("buckets links by health and sync state", () => {
    const summary = summarizeGaLinks(
      [
        link(),
        link({ health: "AUTH", consecutiveFailures: 2 }),
        link({ health: "AUTH" }),
        link({
          health: "DEGRADED",
          rateLimitedUntil: new Date(now.getTime() + 60_000),
        }),
        link({ rateLimitedUntil: new Date(now.getTime() - 60_000) }),
        link({ lastDailyAt: null, backfillDoneAt: null, latestDay: null }),
      ],
      now,
    );
    expect(summary.links).toEqual({
      total: 6,
      mock: 0,
      byHealth: { OK: 3, AUTH: 2, DEGRADED: 1 },
    });
    expect(summary.sync).toMatchObject({
      failing: 1,
      rateLimited: 1,
      neverSynced: 1,
      backfillPending: 1,
      lagOver2Days: 0,
    });
  });

  it("measures data lag in the link's own time zone", () => {
    // İstanbul'da bugün 6 Ekim: 3 Ekim sınırda, 2 Ekim geç.
    // Los Angeles'ta bugün 5 Ekim: 2 Ekim sınırda.
    const summary = summarizeGaLinks(
      [
        link({ latestDay: "2026-10-03" }),
        link({ latestDay: "2026-10-02" }),
        link({ latestDay: "2026-10-02", timeZone: "America/Los_Angeles" }),
        link({ latestDay: "2026-10-01", timeZone: "America/Los_Angeles" }),
        link({ latestDay: null }),
      ],
      now,
    );
    expect(summary.sync.lagOver2Days).toBe(2);
  });

  it("reads quota shares only from today's Pacific day and the last hour", () => {
    const recent = new Date(now.getTime() - 20 * 60_000).toISOString();
    // Pasifik saatiyle 4 Ekim: günlük pay sayılmaz.
    const yesterdayPacific = "2026-10-05T05:00:00.000Z";
    const summary = summarizeGaLinks(
      [
        link({ lastQuota: quota(recent, [120_000, 80_000], [30_000, 10_000]) }),
        link({ lastQuota: quota(recent, [20_000, 180_000]) }),
        link({
          lastQuota: quota(
            yesterdayPacific,
            [190_000, 10_000],
            [39_000, 1_000],
          ),
        }),
      ],
      now,
    );
    expect(summary.quota).toEqual({
      maxDailyShare: 60,
      overHalfDaily: 1,
      overHalfHourly: 1,
    });
  });

  it("leaves mock links out of the quota numbers", () => {
    const recent = new Date(now.getTime() - 5 * 60_000).toISOString();
    const summary = summarizeGaLinks(
      [
        link({
          isMock: true,
          lastQuota: quota(recent, [190_000, 10_000], [39_000, 1_000]),
        }),
      ],
      now,
    );
    expect(summary.links.mock).toBe(1);
    expect(summary.quota).toEqual({
      maxDailyShare: null,
      overHalfDaily: 0,
      overHalfHourly: 0,
    });
  });

  it("ignores malformed quota readings", () => {
    const recent = new Date(now.getTime() - 5 * 60_000).toISOString();
    const summary = summarizeGaLinks(
      [
        link({ lastQuota: "nope" }),
        link({ lastQuota: { at: "not a date", quota: {} } }),
        link({
          lastQuota: {
            at: recent,
            quota: { tokensPerDay: { consumed: "1", remaining: 2 } },
          },
        }),
        link({
          lastQuota: {
            at: recent,
            quota: { tokensPerDay: { consumed: 0, remaining: 0 } },
          },
        }),
        link({ lastQuota: { at: recent, quota: null } }),
      ],
      now,
    );
    expect(summary.quota).toEqual({
      maxDailyShare: null,
      overHalfDaily: 0,
      overHalfHourly: 0,
    });
  });

  it("counts pending add-on history from backfill.addons", () => {
    const addons = (
      next: Record<string, string>,
      doneAt: Record<string, string>,
    ) => ({
      v: 1,
      next: {},
      floor: {},
      startedAt: "2026-09-01T00:00:00.000Z",
      doneAt: "2026-09-02T00:00:00.000Z",
      addons: { v: 1, next, floor: {}, through: {}, doneAt },
    });
    const summary = summarizeGaLinks(
      [
        link({ backfill: addons({ "week:page": "2026-08-31" }, {}) }),
        link({
          backfill: addons(
            { "week:page": "2026-08-31" },
            { "week:page": "2026-09-20T00:00:00.000Z" },
          ),
        }),
        link({ backfill: { v: 1, next: {}, floor: {} } }),
      ],
      now,
    );
    expect(summary.sync.addonsPending).toBe(1);
  });

  it("sums dropped reports, deprecated fields and optional reports from the catalog", () => {
    const summary = summarizeGaLinks(
      [
        link({ catalog: { landing_page: { reason: "x", at: "2026-10-01" } } }),
        link({
          catalog: {
            v: 2,
            disabled: {
              page: { reason: "FIELD_MISSING: pagePath", at: "2026-10-01" },
              site_search: { reason: "y", at: "2026-10-01" },
            },
            check: {
              at: "2026-10-01T00:00:00.000Z",
              missing: {},
              deprecated: ["conversions"],
              blocked: [],
            },
            optional: {
              google_ads: { enabled: true, at: "2026-10-01", reason: null },
              search_console: { enabled: true, at: "2026-10-01", reason: null },
            },
          },
        }),
        link({
          catalog: {
            v: 2,
            disabled: {},
            check: null,
            optional: {
              google_ads: {
                enabled: false,
                at: "2026-10-01",
                reason: "NO_ADS_LINK",
              },
            },
          },
        }),
      ],
      now,
    );
    expect(summary.catalog).toEqual({
      droppedReports: 3,
      linksWithDeprecated: 1,
      googleAdsEnabled: 1,
      searchConsoleEnabled: 1,
    });
  });
});
