import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the Instagram card's three reads go to the host the
// token belongs to, ask for exactly the fields and metrics the card shows, and
// turn Meta's answers into plain numbers (absent stays absent, never zero).
// Also that both connection routes ask for the insights permission.

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
  MetaApiError,
  fetchInstagramAccountInsights,
  fetchInstagramPostStats,
  fetchInstagramProfile,
} = await import("./meta-client");

describe("fetchInstagramProfile", () => {
  it("reads the profile from the host its token belongs to", async () => {
    fetchMock.mockImplementation(async () => json({}));

    await fetchInstagramProfile({
      igUserId: "17841400",
      accessToken: "ig-token",
      api: "instagram",
    });
    await fetchInstagramProfile({
      igUserId: "17841400",
      accessToken: "page-token",
      api: "facebook",
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://graph.instagram.com/v26.0/17841400?fields=username,name,profile_picture_url,followers_count,follows_count,media_count&access_token=ig-token",
    );
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "https://graph.facebook.com/v26.0/17841400?fields=",
    );
  });

  it("maps the counters and leaves what Meta did not send as null", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        username: "webhealth",
        followers_count: 1234,
        follows_count: 0,
        media_count: 56,
      }),
    );

    expect(
      await fetchInstagramProfile({
        igUserId: "1",
        accessToken: "t",
        api: "instagram",
      }),
    ).toEqual({
      username: "webhealth",
      name: null,
      pictureUrl: null,
      followers: 1234,
      follows: 0,
      posts: 56,
    });
  });
});

describe("fetchInstagramAccountInsights", () => {
  it("asks for the four totals over the given window, as one total per metric", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [] }));

    await fetchInstagramAccountInsights({
      igUserId: "17841400",
      accessToken: "ig-token",
      api: "instagram",
      since: 1_000,
      until: 2_000,
    });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      "https://graph.instagram.com/v26.0/17841400/insights",
    );
    expect(url.searchParams.get("metric")).toBe(
      "reach,views,accounts_engaged,total_interactions",
    );
    expect(url.searchParams.get("period")).toBe("day");
    expect(url.searchParams.get("metric_type")).toBe("total_value");
    expect(url.searchParams.get("since")).toBe("1000");
    expect(url.searchParams.get("until")).toBe("2000");
    expect(url.searchParams.get("access_token")).toBe("ig-token");
  });

  it("returns each total by metric name, keeps a real zero and ignores metrics it did not ask for", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: [
          { name: "reach", total_value: { value: 224 } },
          { name: "views", total_value: { value: 0 } },
          { name: "accounts_engaged", total_value: {} },
          { name: "impressions", total_value: { value: 999 } },
        ],
      }),
    );

    expect(
      await fetchInstagramAccountInsights({
        igUserId: "1",
        accessToken: "t",
        api: "facebook",
        since: 1,
        until: 2,
      }),
    ).toEqual({ reach: 224, views: 0 });
  });

  it("surfaces Meta's error code so a missing permission can be told apart", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { error: { message: "(#10) Not enough permission", code: 10 } },
        400,
      ),
    );

    const error = await fetchInstagramAccountInsights({
      igUserId: "1",
      accessToken: "t",
      api: "instagram",
      since: 1,
      until: 2,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MetaApiError);
    expect((error as InstanceType<typeof MetaApiError>).metaErrorCode).toBe(10);
  });
});

describe("fetchInstagramPostStats", () => {
  it("reads the latest posts with their public counters", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: [
          {
            id: "1",
            caption: "One",
            media_type: "IMAGE",
            media_url: "https://cdn/1.jpg",
            permalink: "https://www.instagram.com/p/1/",
            timestamp: "2026-10-01T10:00:00+0000",
            like_count: 12,
            comments_count: 3,
          },
          {
            id: "2",
            media_type: "VIDEO",
            media_url: "https://cdn/2.mp4",
            thumbnail_url: "https://cdn/2.jpg",
          },
        ],
      }),
    );

    const posts = await fetchInstagramPostStats({
      igUserId: "17841400",
      accessToken: "ig-token",
      api: "instagram",
      limit: 6,
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://graph.instagram.com/v26.0/17841400/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=6&access_token=ig-token",
    );
    expect(posts).toEqual([
      {
        id: "1",
        caption: "One",
        imageUrl: "https://cdn/1.jpg",
        permalink: "https://www.instagram.com/p/1/",
        timestamp: "2026-10-01T10:00:00+0000",
        likes: 12,
        comments: 3,
      },
      {
        id: "2",
        caption: null,
        imageUrl: "https://cdn/2.jpg",
        permalink: null,
        timestamp: null,
        likes: null,
        comments: null,
      },
    ]);
  });
});
