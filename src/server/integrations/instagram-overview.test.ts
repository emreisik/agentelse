import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the Instagram card's loader reads the project's own
// connection through the right route, answers "not connected" / "expired"
// without calling Meta, keeps the profile and posts when only the insights
// permission is missing (so a connection made before that permission existed
// still shows something), and never throws into the page.

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique } },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: () => "stored-token",
}));
const fetchInstagramProfile = vi.fn();
const fetchInstagramPostStats = vi.fn();
const fetchInstagramAccountInsights = vi.fn();
const fetchPageAccessToken = vi.fn();
vi.mock("@/server/integrations/meta-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/meta-client")
  >()),
  fetchInstagramProfile,
  fetchInstagramPostStats,
  fetchInstagramAccountInsights,
  fetchPageAccessToken,
}));

const { loadInstagramOverview, clearInstagramOverviewCache } = await import(
  "./instagram-overview"
);
const { MetaApiError } = await import("./meta-client");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const instagramLogin = {
  status: "ACTIVE",
  encryptedSecret: "encrypted",
  metadata: {
    login: "instagram",
    instagramAccount: { id: "17841400", username: "webhealth" },
    pages: [],
    longLivedTokenExpiresAt: "2026-12-01T00:00:00Z",
  },
};
const profile = {
  username: null,
  name: "Web Health",
  pictureUrl: null,
  followers: 1000,
  follows: 10,
  posts: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearInstagramOverviewCache();
  fetchPageAccessToken.mockResolvedValue("page-token");
  fetchInstagramProfile.mockResolvedValue(profile);
  fetchInstagramPostStats.mockResolvedValue([]);
  fetchInstagramAccountInsights.mockResolvedValue({ reach: 5 });
  console.error = vi.fn();
});

describe("loadInstagramOverview", () => {
  it("is not connected without a credential, an active status or a usable account, and does not call Meta", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await loadInstagramOverview("p", NOW)).toEqual({
      ok: false,
      reason: "not_connected",
    });

    findUnique.mockResolvedValueOnce({ ...instagramLogin, status: "REVOKED" });
    expect(await loadInstagramOverview("p", NOW)).toEqual({
      ok: false,
      reason: "not_connected",
    });

    findUnique.mockResolvedValueOnce({
      ...instagramLogin,
      metadata: { login: "instagram", pages: [] },
    });
    expect(await loadInstagramOverview("p", NOW)).toEqual({
      ok: false,
      reason: "not_connected",
    });

    expect(fetchInstagramProfile).not.toHaveBeenCalled();
  });

  it("reports an Instagram Login token past its date as expired, without calling Meta", async () => {
    findUnique.mockResolvedValue({
      ...instagramLogin,
      metadata: {
        ...instagramLogin.metadata,
        longLivedTokenExpiresAt: "2026-10-01T00:00:00Z",
      },
    });

    expect(await loadInstagramOverview("p", NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(fetchInstagramProfile).not.toHaveBeenCalled();
  });

  it("reads profile, posts and a 28-day insights window with the account's own token", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    const posts = [
      {
        id: "1",
        caption: null,
        imageUrl: null,
        permalink: null,
        timestamp: null,
        likes: 1,
        comments: 2,
      },
    ];
    fetchInstagramPostStats.mockResolvedValue(posts);

    const result = await loadInstagramOverview("p", NOW);

    const call = {
      igUserId: "17841400",
      accessToken: "stored-token",
      api: "instagram",
    };
    expect(fetchInstagramProfile).toHaveBeenCalledWith(call);
    expect(fetchInstagramPostStats).toHaveBeenCalledWith({ ...call, limit: 6 });
    const until = Math.floor(NOW / 1000);
    expect(fetchInstagramAccountInsights).toHaveBeenCalledWith({
      ...call,
      since: until - 28 * 24 * 60 * 60,
      until,
    });
    expect(result).toEqual({
      ok: true,
      profile: { ...profile, username: "webhealth" },
      insights: { reach: 5 },
      insightsMissing: null,
      posts,
    });
  });

  it("on the Facebook route, reads the linked account with a Page token", async () => {
    findUnique.mockResolvedValue({
      status: "ACTIVE",
      encryptedSecret: "encrypted",
      metadata: {
        selectedPageId: "page-1",
        pages: [
          {
            pageId: "page-1",
            pageName: "Web Health",
            instagramBusinessAccountId: "ig-9",
            instagramUsername: "wh",
          },
        ],
      },
    });

    await loadInstagramOverview("p", NOW);

    expect(fetchPageAccessToken).toHaveBeenCalledWith("page-1", "stored-token");
    expect(fetchInstagramProfile).toHaveBeenCalledWith({
      igUserId: "ig-9",
      accessToken: "page-token",
      api: "facebook",
    });
  });

  it("keeps profile and posts when only the insights permission is missing", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    fetchInstagramAccountInsights.mockRejectedValue(
      new MetaApiError("(#10) Not enough permission", 10),
    );

    const result = await loadInstagramOverview("p", NOW);

    expect(result).toMatchObject({
      ok: true,
      insights: null,
      insightsMissing: "permission",
    });
  });

  it("keeps profile and posts when the insights call fails for another reason", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    fetchInstagramAccountInsights.mockRejectedValue(
      new MetaApiError("Meta API request timed out (8000ms)"),
    );

    expect(await loadInstagramOverview("p", NOW)).toMatchObject({
      ok: true,
      insights: null,
      insightsMissing: "error",
    });
  });

  it("reports a rejected token (code 190) as expired", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    fetchInstagramProfile.mockRejectedValue(
      new MetaApiError("Invalid OAuth access token", 190),
    );

    expect(await loadInstagramOverview("p", NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("never throws: any other failure becomes an error result", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    fetchInstagramProfile.mockRejectedValue(new Error("boom"));

    expect(await loadInstagramOverview("p", NOW)).toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("reuses a good read for a while instead of asking Meta again", async () => {
    findUnique.mockResolvedValue(instagramLogin);

    expect(await loadInstagramOverview("p", NOW)).toMatchObject({ ok: true });
    expect(await loadInstagramOverview("p", NOW + 60_000)).toMatchObject({ ok: true });
    expect(fetchInstagramProfile).toHaveBeenCalledTimes(1);

    // Later, it reads again.
    await loadInstagramOverview("p", NOW + 20 * 60_000);
    expect(fetchInstagramProfile).toHaveBeenCalledTimes(2);
  });

  it("on Meta's request limit, keeps the last good read and stops asking for a while", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    const limit = new MetaApiError("(#4) Application request limit reached", 4);

    // Nothing read yet: the card says the limit is reached.
    fetchInstagramProfile.mockRejectedValueOnce(limit);
    expect(await loadInstagramOverview("p", NOW)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    // Paused: no call to Meta at all.
    expect(await loadInstagramOverview("p", NOW + 60_000)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(fetchInstagramProfile).toHaveBeenCalledTimes(1);

    // After the pause, a good read is kept; a new limit then shows that read.
    expect(await loadInstagramOverview("p", NOW + 31 * 60_000)).toMatchObject({ ok: true });
    fetchInstagramProfile.mockRejectedValueOnce(limit);
    expect(await loadInstagramOverview("p", NOW + 47 * 60_000)).toMatchObject({ ok: true });
  });
});
