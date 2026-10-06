import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the card reads each account from the record that
// really decides it (GA4 and Search Console count only with a property / site
// chosen, the Facebook Page only when one was selected in the Facebook integration), nothing is claimed for
// an inactive credential, and a failure is "no rows", never an error.

const credentialFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findMany: credentialFindMany } },
}));
const getChannelConnections = vi.fn();
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections,
}));

const { loadConnectedAccounts } = await import("./connected-accounts");

const connections = (over: Record<string, unknown> = {}) => ({
  instagram: { connected: false },
  ads: { connected: false },
  tiktok: { connected: false },
  linkedin: { connected: false },
  x: { connected: false },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getChannelConnections.mockResolvedValue(connections());
  credentialFindMany.mockResolvedValue([]);
});

const byKey = async (website: string | null = null) =>
  Object.fromEntries(
    (await loadConnectedAccounts("proj-1", website)).map((a) => [a.key, a]),
  );

describe("loadConnectedAccounts", () => {
  it("reads this project's Instagram, Facebook, Meta Ads, GA4 and Search Console credentials only", async () => {
    await loadConnectedAccounts("proj-1", null);
    expect(credentialFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "proj-1",
        provider: {
          in: [
            "instagram",
            "facebook",
            "meta_ads",
            "google_analytics",
            "google_search_console",
          ],
        },
      },
      select: { provider: true, status: true, metadata: true },
    });
  });

  it("a brand with nothing linked: everything off, the website active when set", async () => {
    const accounts = await byKey("webhealth.com.tr");
    expect(accounts.instagram?.state).toBe("off");
    expect(accounts.facebook?.state).toBe("off");
    expect(accounts["meta-ads"]?.state).toBe("off");
    expect(accounts.ga4?.state).toBe("off");
    expect(accounts["search-console"]?.state).toBe("off");
    expect(accounts.website).toMatchObject({
      state: "active",
      detail: "webhealth.com.tr",
    });
  });

  it("Instagram and Meta Ads come from the shared channel connections", async () => {
    getChannelConnections.mockResolvedValue(
      connections({
        instagram: { connected: true, accountLabel: "@webhealth" },
        ads: { connected: true, accountLabel: "Web Health Ads" },
      }),
    );
    const accounts = await byKey();
    expect(accounts.instagram).toMatchObject({
      state: "connected",
      detail: "@webhealth",
    });
    expect(accounts["meta-ads"]).toMatchObject({
      state: "connected",
      detail: "Web Health Ads",
    });
  });

  it("the Facebook Page comes from the Facebook integration, once a Page is selected", async () => {
    credentialFindMany.mockResolvedValue([
      {
        provider: "facebook",
        status: "ACTIVE",
        metadata: { selectedPageId: "p1", selectedPageName: "Web Health" },
      },
    ]);
    expect((await byKey()).facebook).toMatchObject({
      state: "connected",
      detail: "Web Health",
    });

    // Connected but no Page chosen yet: nothing to claim.
    credentialFindMany.mockResolvedValue([
      { provider: "facebook", status: "ACTIVE", metadata: { pages: [] } },
    ]);
    expect((await byKey()).facebook?.state).toBe("off");

    // A revoked connection claims nothing.
    credentialFindMany.mockResolvedValue([
      {
        provider: "facebook",
        status: "REVOKED",
        metadata: { selectedPageId: "p1" },
      },
    ]);
    expect((await byKey()).facebook?.state).toBe("off");
  });

  it("a Page picked in the Instagram or Meta Ads connection does not make Facebook connected", async () => {
    credentialFindMany.mockResolvedValue([
      {
        provider: "instagram",
        status: "ACTIVE",
        metadata: { selectedPageId: "p1", selectedPageName: "Web Health" },
      },
      {
        provider: "meta_ads",
        status: "ACTIVE",
        metadata: {
          selectedPageId: "p9",
          selectedPageName: "Web Health Ads Page",
        },
      },
    ]);
    expect((await byKey()).facebook?.state).toBe("off");
  });

  it("GA4 and Search Console need a property / site chosen", async () => {
    credentialFindMany.mockResolvedValue([
      {
        provider: "google_analytics",
        status: "ACTIVE",
        metadata: {
          selectedGa4PropertyId: "123",
          selectedGa4PropertyName: "Web Health",
        },
      },
      { provider: "google_search_console", status: "ACTIVE", metadata: {} },
    ]);
    const accounts = await byKey();
    expect(accounts.ga4).toMatchObject({
      state: "connected",
      detail: "Web Health",
    });
    expect(accounts["search-console"]?.state).toBe("setup");
  });

  it("an inactive credential is not a connection", async () => {
    credentialFindMany.mockResolvedValue([
      {
        provider: "google_analytics",
        status: "ERROR",
        metadata: { selectedGa4PropertyId: "123" },
      },
    ]);
    expect((await byKey()).ga4?.state).toBe("off");
  });

  it("a Google connection gone EXPIRED is shown as needing a reconnect", async () => {
    credentialFindMany.mockResolvedValue([
      {
        provider: "google_search_console",
        status: "EXPIRED",
        metadata: { selectedSearchConsoleSite: "sc-domain:webhealth.com.tr" },
      },
    ]);
    const accounts = await byKey();
    expect(accounts["search-console"]?.state).toBe("reconnect");
    expect(accounts.ga4?.state).toBe("off");
  });

  it("a failure is no rows, never an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    credentialFindMany.mockRejectedValue(new Error("db down"));
    expect(await loadConnectedAccounts("proj-1", null)).toEqual([]);
  });
});
