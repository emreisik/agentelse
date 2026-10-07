import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ assetFindFirst: vi.fn() }));
const meta = vi.hoisted(() => ({ uploadMetaAdVideo: vi.fn(), checkMetaVideoStatus: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: { asset: { findFirst: db.assetFindFirst } } }));
vi.mock("@/server/integrations/meta-client", () => meta);
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: vi.fn(async () => Buffer.from("video")),
  resolveDirectPublicUrl: (key: string) =>
    key.startsWith("r2://") ? `https://cdn.test/${key.slice(5)}` : null,
}));

import type { AdsLaunchSpec } from "@/lib/ads/launch-spec";

import { coverUrl, ensureVideos } from "./video";

const spec = {
  ads: [
    {
      name: "Ad",
      adSetIndex: 0,
      creative: {
        imageAssetId: "a1",
        message: "Hi",
        link: "https://x.test",
        callToAction: "LEARN_MORE",
        video: { assetId: "vid1" },
      },
      urlTags: "",
    },
  ],
} as unknown as AdsLaunchSpec;

const base = { projectId: "p1", adAccountId: "act_1", accessToken: "t" };

describe("ensureVideos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.assetFindFirst.mockResolvedValue({ storageKey: "local://v.mp4", mimeType: "video/mp4" });
    meta.uploadMetaAdVideo.mockResolvedValue({ videoId: "v1" });
  });

  it("does nothing for a launch without video", async () => {
    const plain = { ads: [{ creative: { imageAssetId: "a1" } }] } as unknown as AdsLaunchSpec;
    expect(await ensureVideos({ ...base, spec: plain, progress: {} })).toEqual({ state: "ready" });
    expect(meta.uploadMetaAdVideo).not.toHaveBeenCalled();
  });

  it("uploads once and keeps asking until Meta says ready", async () => {
    meta.checkMetaVideoStatus.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const progress = {};
    expect(await ensureVideos({ ...base, spec, progress })).toEqual({ state: "processing" });
    expect(await ensureVideos({ ...base, spec, progress })).toEqual({ state: "ready" });
    expect(meta.uploadMetaAdVideo).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({ videos: { "0": "v1" }, videoReady: { "0": true } });
    // Ready videos are never asked about again.
    await ensureVideos({ ...base, spec, progress });
    expect(meta.checkMetaVideoStatus).toHaveBeenCalledTimes(2);
  });

  it("only takes videos of this project", async () => {
    db.assetFindFirst.mockResolvedValue(null);
    const result = await ensureVideos({ ...base, spec, progress: {} });
    expect(result).toMatchObject({ state: "failed" });
    expect(db.assetFindFirst.mock.calls[0]![0].where).toMatchObject({
      id: "vid1",
      projectId: "p1",
      mimeType: { startsWith: "video/" },
    });
    expect(meta.uploadMetaAdVideo).not.toHaveBeenCalled();
  });

  it("turns Meta's processing error into a failure and forgets that upload", async () => {
    meta.checkMetaVideoStatus.mockRejectedValue(new Error("video_status: error"));
    const progress: { videos?: Record<string, string> } = {};
    const result = await ensureVideos({ ...base, spec, progress });
    expect(result).toMatchObject({ state: "failed" });
    expect(progress.videos).toEqual({});
  });
});

describe("coverUrl", () => {
  it("is the public address of the cover picture, or null without cloud storage", async () => {
    db.assetFindFirst.mockResolvedValueOnce({ storageKey: "r2://cover.png" });
    expect(await coverUrl("p1", "a1")).toBe("https://cdn.test/cover.png");
    db.assetFindFirst.mockResolvedValueOnce({ storageKey: "local://cover.png" });
    expect(await coverUrl("p1", "a1")).toBeNull();
    db.assetFindFirst.mockResolvedValueOnce(null);
    expect(await coverUrl("p1", "a1")).toBeNull();
  });
});
