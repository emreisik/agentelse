import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: a Facebook Page post goes to the Page's own edge with
// the Page token — a photo post (the caption as its text) when there is an
// image, a plain feed post otherwise — and the post can be read back, edited
// and deleted with that token; a post deleted on Facebook is recognised as
// gone; the test button's Page read derives the Page token first; and only the
// Instagram route asks /me/accounts for the linked Instagram account.

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    META_APP_ID: "meta-app",
    META_APP_SECRET: "meta-secret",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  clearPageTokenCache();
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
  MetaApiError,
  clearPageTokenCache,
  deleteFacebookPagePost,
  fetchFacebookPagePost,
  fetchMetaPageList,
  fetchPageAccessToken,
  isMetaObjectMissing,
  isMetaRateLimit,
  publishFacebookPagePost,
  updateFacebookPagePost,
  verifyFacebookPageAccess,
} = await import("./meta-client");

function sentForm(call: number) {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return {
    url,
    method: init?.method,
    form: new URLSearchParams(String(init?.body)),
  };
}

describe("publishFacebookPagePost", () => {
  it("posts a photo to /{page}/photos with the caption as the post text", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ id: "photo-1", post_id: "page-1_post-1" }),
    );

    const result = await publishFacebookPagePost({
      pageId: "page-1",
      pageAccessToken: "page-token",
      message: "Hello Facebook",
      imageUrl: "https://cdn.example.com/a.png",
    });

    const { url, method, form } = sentForm(0);
    expect(url).toBe("https://graph.facebook.com/v26.0/page-1/photos");
    expect(method).toBe("POST");
    expect(form.get("url")).toBe("https://cdn.example.com/a.png");
    expect(form.get("caption")).toBe("Hello Facebook");
    expect(form.get("published")).toBe("true");
    expect(form.get("access_token")).toBe("page-token");
    // The feed post id, not the photo object's id.
    expect(result).toEqual({ postId: "page-1_post-1" });
  });

  it("posts text only to /{page}/feed when there is no image", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "page-1_post-2" }));

    const result = await publishFacebookPagePost({
      pageId: "page-1",
      pageAccessToken: "page-token",
      message: "Text only",
    });

    const { url, form } = sentForm(0);
    expect(url).toBe("https://graph.facebook.com/v26.0/page-1/feed");
    expect(form.get("message")).toBe("Text only");
    expect(form.has("url")).toBe(false);
    expect(result).toEqual({ postId: "page-1_post-2" });
  });

  it("surfaces Meta's error (e.g. a missing pages_manage_posts grant)", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { error: { message: "(#200) Requires pages_manage_posts", code: 200 } },
        403,
      ),
    );

    const failure = await publishFacebookPagePost({
      pageId: "page-1",
      pageAccessToken: "page-token",
      message: "x",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetaApiError);
    expect((failure as InstanceType<typeof MetaApiError>).metaErrorCode).toBe(
      200,
    );
  });
});

describe("verifyFacebookPageAccess", () => {
  it("derives the Page token from the user token, then reads the Page with it", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "page-token" }))
      .mockResolvedValueOnce(json({ name: "Web Health" }));

    expect(await verifyFacebookPageAccess("page-1", "user-token")).toBe(
      "Web Health",
    );

    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/page-1?fields=access_token&access_token=user-token",
    );
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/page-1?fields=name&access_token=page-token",
    );
  });
});

describe("reading, editing and deleting a Page post", () => {
  it("reads the post's text and link back with the Page token", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ message: "Hello", permalink_url: "https://www.facebook.com/p/1" }),
    );

    expect(await fetchFacebookPagePost("page-1_post-1", "page-token")).toEqual({
      message: "Hello",
      permalinkUrl: "https://www.facebook.com/p/1",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://graph.facebook.com/v26.0/page-1_post-1?fields=message,permalink_url&access_token=page-token",
    );
  });

  it("changes the text with a POST to the post itself", async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));

    await updateFacebookPagePost("page-1_post-1", "page-token", "New text");

    const { url, method, form } = sentForm(0);
    expect(url).toBe("https://graph.facebook.com/v26.0/page-1_post-1");
    expect(method).toBe("POST");
    expect(form.get("message")).toBe("New text");
    expect(form.get("access_token")).toBe("page-token");
  });

  it("deletes with a DELETE to the post", async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true }));

    await deleteFacebookPagePost("page-1_post-1", "page-token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://graph.facebook.com/v26.0/page-1_post-1?access_token=page-token",
    );
    expect(init.method).toBe("DELETE");
  });

  it("recognises 'object does not exist' (100/33) as a deleted post, and only that", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            message: "Unsupported get request. Object with ID 'x' does not exist",
            code: 100,
            error_subcode: 33,
          },
        },
        400,
      ),
    );
    const missing = await fetchFacebookPagePost("x", "t").catch((e: unknown) => e);
    expect(isMetaObjectMissing(missing)).toBe(true);

    expect(isMetaObjectMissing(new MetaApiError("bad token", 190))).toBe(false);
    expect(isMetaObjectMissing(new MetaApiError("other", 100))).toBe(false);
    expect(isMetaObjectMissing(new Error("network"))).toBe(false);
  });
});

describe("fetchMetaPageList fields", () => {
  it("asks for the linked Instagram account only on the Instagram route", async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: [{ id: "p1", name: "Web Health" }] }),
    );

    await fetchMetaPageList("user-token", { onlyWithInstagram: false });
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/me/accounts?fields=id,name&limit=100&access_token=user-token",
    );

    await fetchMetaPageList("user-token", { onlyWithInstagram: true });
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "fields=id,name,instagram_business_account{id,username}",
    );
  });
});

describe("fetchPageAccessToken", () => {
  it("fails clearly (not as an expired token) when Facebook leaves the Page token out", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "page-1" }));

    const failure = await fetchPageAccessToken("page-1", "user-token").catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MetaApiError);
    expect((failure as InstanceType<typeof MetaApiError>).metaErrorCode).toBeUndefined();
    expect((failure as Error).message).toContain("no longer manage it");
  });
});

describe("Page token reuse and Meta's request limit", () => {
  it("asks Meta for a Page token once, then reuses it for the same user token", async () => {
    fetchMock.mockImplementation(async () => json({ access_token: "page-token" }));

    expect(await fetchPageAccessToken("page-9", "user-token")).toBe("page-token");
    expect(await fetchPageAccessToken("page-9", "user-token")).toBe("page-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A reconnect (new user token) asks again.
    await fetchPageAccessToken("page-9", "new-user-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recognises Meta's throttling codes", () => {
    expect(isMetaRateLimit(new MetaApiError("Application request limit reached", 4))).toBe(true);
    expect(isMetaRateLimit(new MetaApiError("User request limit reached", 17))).toBe(true);
    expect(isMetaRateLimit(new MetaApiError("limit", 80004))).toBe(true);
    expect(isMetaRateLimit(new MetaApiError("expired", 190))).toBe(false);
    expect(isMetaRateLimit(new Error("x"))).toBe(false);
  });
});

describe("the Page list follows every page of /me/accounts", () => {
  it("collects Pages beyond the first response", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          data: [{ id: "p1", name: "One" }],
          paging: { next: "https://graph.facebook.com/v26.0/me/accounts?after=x" },
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ id: "p2", name: "Two" }] }));

    const result = await fetchMetaPageList("user-token", { onlyWithInstagram: false });

    expect(result.pages.map((p) => p.pageId)).toEqual(["p1", "p2"]);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://graph.facebook.com/v26.0/me/accounts?after=x",
    );
  });
});
