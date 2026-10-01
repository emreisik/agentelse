import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: Instagram Login talks to Instagram's own hosts with
// its own app credentials (not Facebook's), reads both shapes of the token
// response, publishes through graph.instagram.com with the account's own token,
// and the target resolver tells the two stored routes apart so nothing derives a
// Page token for an account that has no Page.

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    META_APP_ID: "meta-app",
    META_APP_SECRET: "meta-secret",
    INSTAGRAM_APP_ID: "ig-app",
    INSTAGRAM_APP_SECRET: "ig-secret",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const {
  exchangeInstagramAuthCode,
  exchangeInstagramLongLivedToken,
  fetchInstagramLoginProfile,
  publishInstagramPost,
  verifyInstagramAccess,
} = await import("./meta-client");
const { resolveInstagramTarget, instagramAccessFor } = await import(
  "./instagram-target"
);

describe("Instagram Login token exchange", () => {
  it("posts the code to Instagram's token endpoint with the Instagram app credentials", async () => {
    fetchMock.mockResolvedValue(
      json({ access_token: "short", user_id: 178414 }),
    );
    const result = await exchangeInstagramAuthCode("abc123#_");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.instagram.com/oauth/access_token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("client_id")).toBe("ig-app");
    expect(body.get("client_secret")).toBe("ig-secret");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(
      "https://app.example.com/api/integrations/meta/callback",
    );
    // The "#_" Instagram appends to the code is not part of it.
    expect(body.get("code")).toBe("abc123");
    expect(result).toEqual({ accessToken: "short", userId: "178414" });
  });

  it("reads the response whether it is flat or wrapped in a data array", async () => {
    fetchMock.mockResolvedValue(
      json({ data: [{ access_token: "wrapped", user_id: "99" }] }),
    );
    expect(await exchangeInstagramAuthCode("c")).toEqual({
      accessToken: "wrapped",
      userId: "99",
    });
  });

  it("says so when Instagram returns no token, and surfaces its own error wording", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(exchangeInstagramAuthCode("c")).rejects.toThrow(
      "Instagram did not return an access token",
    );

    fetchMock.mockResolvedValueOnce(
      json({ error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" }, 400),
    );
    await expect(exchangeInstagramAuthCode("c")).rejects.toMatchObject({
      message: "Invalid authorization code",
      metaErrorCode: 400,
    });
  });

  it("exchanges for a 60-day token on graph.instagram.com with the Instagram secret", async () => {
    fetchMock.mockResolvedValue(json({ access_token: "long", expires_in: 5184000 }));
    const result = await exchangeInstagramLongLivedToken("short");
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(url.searchParams.get("client_secret")).toBe("ig-secret");
    expect(url.searchParams.get("access_token")).toBe("short");
    expect(result).toEqual({ accessToken: "long", expiresIn: 5184000 });
  });

  it("turns Meta's 'Unsupported request' into the likely cause: a tester invite still pending", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "Unsupported request - method type: get", code: 100 } }, 400),
    );
    await expect(exchangeInstagramLongLivedToken("short")).rejects.toMatchObject({
      metaErrorCode: 100,
      message: expect.stringMatching(
        /Unsupported request - method type: get\. .*pending tester.*Tester invites/,
      ),
    });
    // One documented GET, no guessing with other methods.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "https://graph.instagram.com/access_token?",
    );
  });

  it("leaves other failures such as a bad token untouched", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "Invalid OAuth access token", code: 190 } }, 400),
    );
    await expect(exchangeInstagramLongLivedToken("short")).rejects.toMatchObject({
      message: "Invalid OAuth access token",
      metaErrorCode: 190,
    });
  });

  it("assumes 60 days when Instagram leaves expires_in out", async () => {
    fetchMock.mockResolvedValue(json({ access_token: "long" }));
    expect((await exchangeInstagramLongLivedToken("s")).expiresIn).toBe(5184000);
  });

  it("identifies the account by user_id (the id publishing is addressed to), not the app-scoped id", async () => {
    fetchMock.mockResolvedValue(
      json({ id: "app-scoped", user_id: "17841400", username: "webhealth", account_type: "BUSINESS" }),
    );
    expect(await fetchInstagramLoginProfile("tok")).toEqual({
      id: "17841400",
      username: "webhealth",
      accountType: "BUSINESS",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("https://graph.instagram.com/");
  });
});

describe("publishing", () => {
  // A Response body can be read once, so each test gets fresh ones.
  const stubPublishFlow = () =>
    fetchMock
      .mockResolvedValueOnce(json({ id: "container-1" }))
      .mockResolvedValueOnce(json({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(json({ id: "post-1" }));

  it("on Instagram Login goes through graph.instagram.com with the account's own token", async () => {
    stubPublishFlow();

    const result = await publishInstagramPost({
      instagramBusinessAccountId: "17841400",
      pageAccessToken: "ig-token",
      imageUrl: "https://cdn.example.com/a.png",
      caption: "Hello",
      api: "instagram",
    });

    expect(result).toEqual({ postId: "post-1" });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/17841400\/media$/);
    expect(urls[1]).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/container-1\?fields=status_code/);
    expect(urls[2]).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/17841400\/media_publish$/);
    const createBody = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(createBody.get("access_token")).toBe("ig-token");
    expect(createBody.get("caption")).toBe("Hello");
  });

  it("without `api` keeps going through graph.facebook.com (the Facebook route)", async () => {
    stubPublishFlow();
    await publishInstagramPost({
      instagramBusinessAccountId: "ig-1",
      pageAccessToken: "page-token",
      imageUrl: "https://cdn.example.com/a.png",
      caption: "Hello",
    });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("https://graph.facebook.com/");
    }
  });

  it("a story carries no caption on either route", async () => {
    stubPublishFlow();
    await publishInstagramPost({
      instagramBusinessAccountId: "17841400",
      pageAccessToken: "ig-token",
      imageUrl: "https://cdn.example.com/a.png",
      caption: "ignored",
      mediaType: "STORIES",
      api: "instagram",
    });
    const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(body.get("media_type")).toBe("STORIES");
    expect(body.has("caption")).toBe(false);
  });

  it("the connection test reads the username from the right host", async () => {
    fetchMock.mockResolvedValue(json({ username: "webhealth" }));
    expect(await verifyInstagramAccess("17841400", "ig-token", "instagram")).toBe("webhealth");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("https://graph.instagram.com/");
  });
});

describe("resolveInstagramTarget", () => {
  it("Instagram Login: the account itself, no Page", () => {
    expect(
      resolveInstagramTarget({
        login: "instagram",
        instagramAccount: { id: "17841400", username: "webhealth" },
        pages: [],
      }),
    ).toEqual({ login: "instagram", igUserId: "17841400", username: "webhealth" });
  });

  it("Instagram Login without an account id is not a target", () => {
    expect(resolveInstagramTarget({ login: "instagram", pages: [] })).toBeNull();
  });

  it("Facebook route: the selected Page's linked Instagram account", () => {
    expect(
      resolveInstagramTarget({
        selectedPageId: "p1",
        pages: [
          { pageId: "p1", pageName: "Web Health", instagramBusinessAccountId: "ig-1", instagramUsername: "wh" },
          { pageId: "p2", pageName: "Other", instagramBusinessAccountId: "ig-2" },
        ],
      }),
    ).toEqual({
      login: "facebook",
      igUserId: "ig-1",
      username: "wh",
      pageId: "p1",
      pageName: "Web Health",
    });
  });

  it("Facebook route: no selected Page, or a Page without an Instagram account, is not a target", () => {
    expect(resolveInstagramTarget({ pages: [{ pageId: "p1", pageName: "x", instagramBusinessAccountId: "ig-1" }] })).toBeNull();
    expect(
      resolveInstagramTarget({ selectedPageId: "p1", pages: [{ pageId: "p1", pageName: "x" }] }),
    ).toBeNull();
    expect(resolveInstagramTarget(null)).toBeNull();
  });
});

describe("instagramAccessFor", () => {
  it("Instagram Login uses the stored token as it is and never asks for a Page token", async () => {
    const access = await instagramAccessFor(
      { login: "instagram", igUserId: "17841400" },
      "stored",
    );
    expect(access).toEqual({ accessToken: "stored", api: "instagram" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the Facebook route derives the Page token from the user token", async () => {
    fetchMock.mockResolvedValue(json({ access_token: "page-token" }));
    const access = await instagramAccessFor(
      { login: "facebook", igUserId: "ig-1", pageId: "p1" },
      "user-token",
    );
    expect(access).toEqual({ accessToken: "page-token", api: "facebook" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("https://graph.facebook.com/");
  });
});
