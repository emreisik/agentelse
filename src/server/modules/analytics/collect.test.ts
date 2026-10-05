import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: a report is collected from the sources' real answers
// (mapped to the report's metrics, rates in percent, Instagram capped to its
// 30-day window), every source is read on its own so one that fails becomes
// its section's reason while the rest still report, and only the asked
// sources are read.

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique } },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: () => "stored-token",
}));

const fetchInstagramAccountInsights = vi.fn();
const fetchInstagramProfile = vi.fn();
vi.mock("@/server/integrations/meta-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/meta-client")
  >()),
  fetchInstagramAccountInsights,
  fetchInstagramProfile,
}));

const resolveConnection = vi.fn();
vi.mock("@/server/integrations/meta-ads-query", () => ({
  MetaAdsQuery: { resolveConnection },
}));

const findActiveGoogleConnections = vi.fn();
vi.mock("@/server/integrations/google-connections", () => ({
  findActiveGoogleConnections,
}));
const getFreshGoogleAccessToken = vi.fn();
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken,
}));
const fetchSearchConsoleReport = vi.fn();
const fetchSearchConsoleQueryRows = vi.fn();
vi.mock("@/server/integrations/google-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/google-client")
  >()),
  fetchSearchConsoleReport,
  fetchSearchConsoleQueryRows,
}));

const { collectReport } = await import("./collect");
const { MetaApiError } = await import("@/server/integrations/meta-client");
const { GoogleApiError } = await import("@/server/integrations/google-client");

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

const instagramCredential = {
  status: "ACTIVE",
  encryptedSecret: "encrypted",
  metadata: {
    login: "instagram",
    instagramAccount: { id: "17841400", username: "biduniq" },
    pages: [],
    longLivedTokenExpiresAt: "2026-12-01T00:00:00Z",
  },
};

const googleConnections = {
  analytics: {
    credential: { id: "ga", encryptedSecret: "x" },
    propertyId: "123",
  },
  searchConsole: {
    credential: { id: "gsc", encryptedSecret: "y" },
    siteUrl: "sc-domain:biduniq.com",
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function routeFetch(ga4: Response) {
  fetchMock.mockImplementation(async (url) => {
    if (url.includes("analyticsdata.googleapis.com")) return ga4.clone();
    if (url.includes("level=account")) {
      return json({
        data: [
          {
            account_currency: "TRY",
            account_name: "Biduniq Ads",
            spend: "1500.50",
            impressions: "80000",
            reach: "30000",
            clicks: "1200",
            ctr: "1.5",
            cpc: "1.25",
          },
        ],
      });
    }
    if (url.includes("level=campaign")) {
      return json({
        data: [
          {
            campaign_id: "c1",
            campaign_name: "Spring leads",
            objective: "OUTCOME_LEADS",
            spend: "900",
            actions: [
              { action_type: "link_click", value: "500" },
              { action_type: "lead", value: "30" },
            ],
          },
          {
            campaign_id: "c2",
            campaign_name: "Traffic",
            objective: "OUTCOME_TRAFFIC",
            spend: "600.50",
            actions: [{ action_type: "link_click", value: "700" }],
          },
          {
            campaign_id: "c3",
            campaign_name: "Paused",
            objective: "OUTCOME_TRAFFIC",
            spend: "0",
            actions: [],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  console.error = vi.fn();
  findUnique.mockResolvedValue(instagramCredential);
  fetchInstagramAccountInsights.mockResolvedValue({
    reach: 12000,
    views: 45000,
    accounts_engaged: 900,
    total_interactions: 2100,
  });
  fetchInstagramProfile.mockResolvedValue({
    username: "biduniq",
    name: null,
    pictureUrl: null,
    followers: 5400,
    follows: 10,
    posts: 99,
  });
  resolveConnection.mockResolvedValue({
    status: "READY",
    accessToken: "ads-token",
    adAccountId: "act_1",
  });
  findActiveGoogleConnections.mockResolvedValue(googleConnections);
  getFreshGoogleAccessToken.mockResolvedValue("google-token");
  fetchSearchConsoleReport.mockResolvedValue({
    clicks: 320,
    impressions: 12000,
    ctr: 0.0267,
    position: 8.4,
  });
  fetchSearchConsoleQueryRows.mockResolvedValue([
    {
      keys: ["running shoes"],
      clicks: 120,
      impressions: 4000,
      ctr: 0.03,
      position: 3.2,
    },
    { keys: [""], clicks: 1, impressions: 2, ctr: 0.5, position: 1 },
  ]);
  routeFetch(
    json(
      {
        error: {
          code: 403,
          message: "User does not have sufficient permissions.",
          status: "PERMISSION_DENIED",
        },
      },
      403,
    ),
  );
});

describe("collectReport", () => {
  it("reads every asked source on its own: one failing source is its section's reason", async () => {
    const report = await collectReport(
      "p1",
      90,
      ["searchConsole", "ga4", "metaAds", "instagram"],
      NOW,
    );
    expect(report.period).toBe(90);
    expect(report.builtAt).toBe("2026-10-05T12:00:00.000Z");
    expect(report.summary).toBeNull();
    // Report order, whatever order they were asked in.
    expect(report.sections.map((section) => section.source)).toEqual([
      "instagram",
      "metaAds",
      "ga4",
      "searchConsole",
    ]);
    const [instagram, metaAds, ga4, searchConsole] = report.sections;

    // Instagram: its totals over at most 30 days, plus today's followers.
    expect(instagram).toMatchObject({
      ok: true,
      account: "@biduniq",
      days: 30,
      metrics: [
        { key: "ig.reach", value: 12000 },
        { key: "ig.views", value: 45000 },
        { key: "ig.accountsEngaged", value: 900 },
        { key: "ig.interactions", value: 2100 },
        { key: "ig.followers", value: 5400 },
      ],
    });
    const window = fetchInstagramAccountInsights.mock.calls[0]![0] as {
      since: number;
      until: number;
    };
    expect(window.until - window.since).toBe(30 * 24 * 60 * 60);

    // Meta Ads: the account's own totals, the results per kind and the top
    // campaigns by spend (a leads campaign reports its leads).
    expect(metaAds).toMatchObject({
      ok: true,
      account: "Biduniq Ads",
      currency: "TRY",
      days: 90,
      metrics: [
        { key: "ads.spend", value: 1500.5 },
        { key: "ads.impressions", value: 80000 },
        { key: "ads.reach", value: 30000 },
        { key: "ads.clicks", value: 1200 },
        { key: "ads.ctr", value: 1.5 },
        { key: "ads.cpc", value: 1.25 },
      ],
      results: [
        { label: "Leads", count: 30, costPerResult: 30 },
        { label: "Link Clicks", count: 700 },
      ],
      campaigns: [
        { name: "Spring leads", spend: 900, resultLabel: "Leads", results: 30 },
        {
          name: "Traffic",
          spend: 600.5,
          resultLabel: "Link Clicks",
          results: 700,
        },
      ],
    });
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("date_preset=last_90d"))).toBe(true);

    // Google Analytics said no: its reason, nothing else is lost.
    expect(ga4).toEqual({ source: "ga4", ok: false, reason: "permission" });

    // Search Console: rates in percent, the top searches without blanks.
    expect(searchConsole).toMatchObject({
      ok: true,
      account: "biduniq.com",
      metrics: [
        { key: "sc.clicks", value: 320 },
        { key: "sc.impressions", value: 12000 },
        { key: "sc.ctr", value: 2.67 },
        { key: "sc.position", value: 8.4 },
      ],
      queries: [
        {
          query: "running shoes",
          clicks: 120,
          impressions: 4000,
          ctr: 3,
          position: 3.2,
        },
      ],
    });
  });

  it("maps GA4's answer to the report's metrics over whole days", async () => {
    routeFetch(
      json({
        metricHeaders: [
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "engagementRate" },
          { name: "averageSessionDuration" },
        ],
        rows: [
          {
            metricValues: [
              { value: "800" },
              { value: "500" },
              { value: "1100" },
              { value: "3000" },
              { value: "0.625" },
              { value: "95.5" },
            ],
          },
        ],
      }),
    );
    const report = await collectReport("p1", 7, ["ga4"], NOW);
    expect(report.sections).toEqual([
      {
        source: "ga4",
        ok: true,
        account: null,
        days: 7,
        currency: null,
        metrics: [
          { key: "ga.activeUsers", value: 800 },
          { key: "ga.newUsers", value: 500 },
          { key: "ga.sessions", value: 1100 },
          { key: "ga.views", value: 3000 },
          { key: "ga.engagementRate", value: 62.5 },
          { key: "ga.avgSessionDuration", value: 95.5 },
        ],
        results: [],
        campaigns: [],
        queries: [],
      },
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      dateRanges: unknown;
    };
    expect(body.dateRanges).toEqual([
      { startDate: "7daysAgo", endDate: "yesterday" },
    ]);
    // Only the asked source was read.
    expect(findUnique).not.toHaveBeenCalled();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it("turns each failure into an honest reason and never throws", async () => {
    findUnique.mockRejectedValue(new Error("database down"));
    resolveConnection.mockResolvedValue({
      status: "READY",
      accessToken: "ads-token",
      adAccountId: "act_1",
    });
    fetchMock.mockImplementation(async () =>
      json({ error: { message: "Session expired", code: 190 } }, 400),
    );
    getFreshGoogleAccessToken.mockRejectedValue(
      new GoogleApiError("Token revoked", "invalid_grant"),
    );
    findActiveGoogleConnections.mockResolvedValue({
      analytics: null,
      searchConsole: googleConnections.searchConsole,
    });

    const report = await collectReport(
      "p1",
      28,
      ["instagram", "metaAds", "ga4", "searchConsole"],
      NOW,
    );
    expect(report.sections).toEqual([
      { source: "instagram", ok: false, reason: "error" },
      { source: "metaAds", ok: false, reason: "expired" },
      { source: "ga4", ok: false, reason: "not_connected" },
      { source: "searchConsole", ok: false, reason: "expired" },
    ]);
  });

  it("says a Meta rate limit and an unfinished setup plainly", async () => {
    fetchInstagramAccountInsights.mockRejectedValue(
      new MetaApiError("Application request limit reached", 4),
    );
    resolveConnection.mockResolvedValue({ status: "NO_AD_ACCOUNT" });
    const report = await collectReport("p1", 28, ["instagram", "metaAds"], NOW);
    expect(report.sections).toEqual([
      { source: "instagram", ok: false, reason: "rate_limited" },
      { source: "metaAds", ok: false, reason: "setup" },
    ]);
  });
});
