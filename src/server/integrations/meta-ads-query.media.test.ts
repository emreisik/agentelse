import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  images: vi.fn(),
  video: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/security/crypto", () => ({ decryptSecret: () => "tok" }));
vi.mock("@/server/integrations/meta-client", () => ({
  META_PROVIDER: { ads: "meta-ads" },
  listMetaCampaigns: vi.fn(),
  fetchMetaLevelInsights: vi.fn(),
  listMetaAdSets: vi.fn(),
  listMetaAds: vi.fn(),
  fetchMetaAdImageUrls: m.images,
  fetchMetaVideoPlayback: m.video,
}));

import { MetaAdsQuery } from "./meta-ads-query";
import type { MetaAdSummary } from "./meta-client";

const conn = { accessToken: "tok", adAccountId: "act_1" };

function ad(creative: MetaAdSummary["creative"]): MetaAdSummary {
  return {
    adId: "a1",
    name: "Ad",
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    thumbnailUrl: "https://cdn/thumb.jpg",
    creative,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.images.mockResolvedValue(new Map());
  m.video.mockResolvedValue({});
});

describe("MetaAdsQuery.adMedia", () => {
  it("returns the full-size picture of a single-image ad by its hash", async () => {
    m.images.mockResolvedValue(new Map([["h1", "https://cdn/full.jpg"]]));
    const media = await MetaAdsQuery.adMedia(
      conn,
      ad({ format: "SINGLE_IMAGE", imageHash: "h1" }),
    );
    expect(media.imageUrl).toBe("https://cdn/full.jpg");
    expect(m.images).toHaveBeenCalledWith({
      adAccountId: "act_1",
      accessToken: "tok",
      hashes: ["h1"],
    });
    expect(m.video).not.toHaveBeenCalled();
  });

  it("returns one picture per carousel card, in card order", async () => {
    m.images.mockResolvedValue(
      new Map([
        ["h1", "https://cdn/1.jpg"],
        ["h3", "https://cdn/3.jpg"],
      ]),
    );
    const media = await MetaAdsQuery.adMedia(
      conn,
      ad({
        format: "CAROUSEL",
        cards: [
          { link: "", name: "A", imageHash: "h1" },
          { link: "", name: "B", imageHash: "h2" },
          { link: "", name: "C", imageHash: "h3" },
        ],
      }),
    );
    expect(media.cardImageUrls).toEqual([
      "https://cdn/1.jpg",
      undefined,
      "https://cdn/3.jpg",
    ]);
  });

  it("returns the playable file and cover of a video ad", async () => {
    m.video.mockResolvedValue({
      sourceUrl: "https://cdn/v.mp4",
      posterUrl: "https://cdn/p.jpg",
    });
    const media = await MetaAdsQuery.adMedia(
      conn,
      ad({ format: "VIDEO", videoId: "v1" }),
    );
    expect(media).toEqual({
      videoUrl: "https://cdn/v.mp4",
      posterUrl: "https://cdn/p.jpg",
    });
  });

  it("finds a Reel's video through the creative's own video id, with its page", async () => {
    m.video.mockResolvedValue({
      sourceUrl: "https://cdn/reel.mp4",
      pageUrl: "https://www.facebook.com/reel/1",
    });
    const media = await MetaAdsQuery.adMedia(conn, {
      ...ad({ format: "SINGLE_IMAGE" }),
      videoId: "reel-video",
    });
    expect(m.video).toHaveBeenCalledWith({
      videoId: "reel-video",
      accessToken: "tok",
    });
    expect(media.videoUrl).toBe("https://cdn/reel.mp4");
    expect(media.videoPageUrl).toBe("https://www.facebook.com/reel/1");
  });

  it("keeps the Instagram post as the place to watch when Meta gives no file", async () => {
    m.video.mockRejectedValue(new Error("no source"));
    const media = await MetaAdsQuery.adMedia(conn, {
      ...ad(undefined),
      permalinkUrl: "https://www.instagram.com/reel/abc/",
    });
    expect(media).toEqual({
      videoPageUrl: "https://www.instagram.com/reel/abc/",
    });
  });

  it("degrades to no extra media when Meta refuses, instead of throwing", async () => {
    m.images.mockRejectedValue(new Error("boom"));
    m.video.mockRejectedValue(new Error("boom"));
    await expect(
      MetaAdsQuery.adMedia(conn, ad({ format: "SINGLE_IMAGE", imageHash: "h" })),
    ).resolves.toEqual({});
    await expect(
      MetaAdsQuery.adMedia(conn, ad({ format: "VIDEO", videoId: "v" })),
    ).resolves.toEqual({});
  });

  it("asks for nothing when the ad has no creative detail", async () => {
    await expect(MetaAdsQuery.adMedia(conn, ad(undefined))).resolves.toEqual({});
    expect(m.images).not.toHaveBeenCalled();
    expect(m.video).not.toHaveBeenCalled();
  });
});
