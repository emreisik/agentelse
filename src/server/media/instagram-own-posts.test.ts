import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the style import reads only the project's own
// connected Instagram account, through the official API with that
// connection's token (either route), refuses without a working connection,
// and skips posts that have no picture to analyse.

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique } },
}));
vi.mock("@/server/security/crypto", () => ({
  decryptSecret: () => "stored-token",
}));
const fetchInstagramRecentMedia = vi.fn();
const fetchPageAccessToken = vi.fn();
vi.mock("@/server/integrations/meta-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server/integrations/meta-client")
  >()),
  fetchInstagramRecentMedia,
  fetchPageAccessToken,
}));

const { loadOwnInstagramPosts } = await import("./instagram-own-posts");

const instagramLogin = {
  status: "ACTIVE",
  encryptedSecret: "encrypted",
  metadata: {
    login: "instagram",
    instagramAccount: { id: "17841400", username: "webhealth" },
    pages: [],
  },
};
const facebookRoute = {
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
};
const post = (id: string, imageUrl: string | null) => ({
  id,
  caption: `Caption ${id}`,
  imageUrl,
  permalink: `https://www.instagram.com/p/${id}/`,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchPageAccessToken.mockResolvedValue("page-token");
});

describe("loadOwnInstagramPosts", () => {
  it("reads the Instagram Login account's posts with its own token, keeping only posts with a picture", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    fetchInstagramRecentMedia.mockResolvedValue([
      post("1", "https://cdn/1.jpg"),
      post("2", null),
      post("3", "https://cdn/3.jpg"),
      post("4", "https://cdn/4.jpg"),
    ]);

    const result = await loadOwnInstagramPosts("proj-1", 2);

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        projectId_provider: { projectId: "proj-1", provider: "instagram" },
      },
    });
    expect(fetchInstagramRecentMedia).toHaveBeenCalledWith({
      igUserId: "17841400",
      accessToken: "stored-token",
      api: "instagram",
      limit: 12,
    });
    expect(result).toEqual({
      ok: true,
      username: "webhealth",
      posts: [post("1", "https://cdn/1.jpg"), post("3", "https://cdn/3.jpg")],
    });
  });

  it("on the Facebook route, reads the linked account with a Page token", async () => {
    findUnique.mockResolvedValue(facebookRoute);
    fetchInstagramRecentMedia.mockResolvedValue([
      post("1", "https://cdn/1.jpg"),
    ]);

    await loadOwnInstagramPosts("proj-1", 5);

    expect(fetchPageAccessToken).toHaveBeenCalledWith("page-1", "stored-token");
    expect(fetchInstagramRecentMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        igUserId: "ig-9",
        accessToken: "page-token",
        api: "facebook",
      }),
    );
  });

  it("refuses without a working connection, never calling Instagram", async () => {
    const expired = {
      ...instagramLogin,
      metadata: {
        ...instagramLogin.metadata,
        longLivedTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    };
    for (const row of [
      null,
      { ...instagramLogin, status: "REVOKED" },
      expired,
    ]) {
      findUnique.mockResolvedValue(row);
      expect(await loadOwnInstagramPosts("proj-1", 5)).toEqual({
        ok: false,
        reason: "Connect your Instagram account in Connectors first.",
      });
    }
    expect(fetchInstagramRecentMedia).not.toHaveBeenCalled();
  });

  it("says so when no post has a picture", async () => {
    findUnique.mockResolvedValue(instagramLogin);
    fetchInstagramRecentMedia.mockResolvedValue([post("1", null)]);
    expect(await loadOwnInstagramPosts("proj-1", 5)).toEqual({
      ok: false,
      reason: "Your Instagram account has no posts with an image yet.",
    });
  });
});
