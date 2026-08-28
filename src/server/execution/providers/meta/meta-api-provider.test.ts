import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  credentialFindUnique: vi.fn(),
  assetFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findUnique: prismaMocks.credentialFindUnique },
    asset: { findFirst: prismaMocks.assetFindFirst },
  },
}));

const envMocks = vi.hoisted(() => ({ configured: true }));
vi.mock("@/lib/env", () => ({
  isIntegrationConfigured: () => envMocks.configured,
}));

vi.mock("@/server/security/crypto", () => ({
  decryptSecret: () => "decrypted-access-token",
}));

const storageMocks = vi.hoisted(() => ({
  readAsset: vi.fn(),
  resolveDirectPublicUrl: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: storageMocks.readAsset,
  resolveDirectPublicUrl: storageMocks.resolveDirectPublicUrl,
}));

const metaClientMocks = vi.hoisted(() => ({
  uploadMetaAdVideo: vi.fn(),
  checkMetaVideoStatus: vi.fn(),
  createMetaVideoAdCreative: vi.fn(),
  createMetaAd: vi.fn(),
  createMetaAdCreative: vi.fn(),
  createMetaCarouselAdCreative: vi.fn(),
  uploadMetaAdImage: vi.fn(),
  updateMetaAd: vi.fn(),
}));
vi.mock("@/server/integrations/meta-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/integrations/meta-client")>();
  return {
    ...actual,
    uploadMetaAdVideo: metaClientMocks.uploadMetaAdVideo,
    checkMetaVideoStatus: metaClientMocks.checkMetaVideoStatus,
    createMetaVideoAdCreative: metaClientMocks.createMetaVideoAdCreative,
    createMetaAd: metaClientMocks.createMetaAd,
    createMetaAdCreative: metaClientMocks.createMetaAdCreative,
    createMetaCarouselAdCreative: metaClientMocks.createMetaCarouselAdCreative,
    uploadMetaAdImage: metaClientMocks.uploadMetaAdImage,
    updateMetaAd: metaClientMocks.updateMetaAd,
  };
});

import { MetaApiProvider } from "@/server/execution/providers/meta/meta-api-provider";
import type {
  ExecutionPolicyContext,
  ExecutionRequest,
} from "@/server/execution/types";

const context: ExecutionPolicyContext = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  taskId: "task-1",
  capability: "INSTAGRAM_PUBLISH",
  riskLevel: "HIGH",
};

describe("MetaApiProvider.canExecute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
  });

  it("returns false when META env vars are not configured", async () => {
    envMocks.configured = false;
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("INSTAGRAM_PUBLISH", context)).toBe(false);
    expect(prismaMocks.credentialFindUnique).not.toHaveBeenCalled();
  });

  it("returns false for a capability it does not own", async () => {
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("WEB_RESEARCH", context)).toBe(false);
    expect(prismaMocks.credentialFindUnique).not.toHaveBeenCalled();
  });

  it("returns false when no active Meta credential exists for the project", async () => {
    prismaMocks.credentialFindUnique.mockResolvedValue(null);
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(false);
  });

  it("returns false when the credential is not ACTIVE", async () => {
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "EXPIRED",
      metadata: { selectedAdAccountId: "act_1" },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(false);
  });

  it("requires a selected ad account for campaign/adset/ad/analysis capabilities", async () => {
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { pages: [], adAccounts: [] },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(false);
    expect(await provider.canExecute("META_CAMPAIGN_CREATE", context)).toBe(
      false,
    );
    expect(await provider.canExecute("META_ADSET_CREATE", context)).toBe(false);
    expect(await provider.canExecute("META_ADSET_UPDATE", context)).toBe(false);
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(false);
  });

  it("allows campaign/adset/analysis capabilities once an ad account is selected", async () => {
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { pages: [], adAccounts: [], selectedAdAccountId: "act_1" },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("META_ADS_ANALYSIS", context)).toBe(true);
    expect(await provider.canExecute("META_CAMPAIGN_UPDATE", context)).toBe(
      true,
    );
    expect(await provider.canExecute("META_ADSET_CREATE", context)).toBe(true);
    expect(await provider.canExecute("META_ADSET_UPDATE", context)).toBe(true);
  });

  it("requires BOTH a selected ad account and a selected Page for META_AD_CREATE", async () => {
    const provider = new MetaApiProvider();

    // Ad account only, no Page selected — createAd() needs the Page to
    // build the AdCreative's object_story_spec.
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: { pages: [], adAccounts: [], selectedAdAccountId: "act_1" },
    });
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(false);

    // Page selected but no ad account.
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedPageId: "page-1",
        pages: [{ pageId: "page-1", pageName: "Test Page" }],
        adAccounts: [],
      },
    });
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(false);

    // Both selected.
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedAdAccountId: "act_1",
        selectedPageId: "page-1",
        pages: [{ pageId: "page-1", pageName: "Test Page" }],
        adAccounts: [],
      },
    });
    expect(await provider.canExecute("META_AD_CREATE", context)).toBe(true);
  });

  it("requires the selected page to have a linked Instagram business account for INSTAGRAM_PUBLISH", async () => {
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedPageId: "page-1",
        pages: [{ pageId: "page-1", pageName: "Test Page" }],
        adAccounts: [],
      },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("INSTAGRAM_PUBLISH", context)).toBe(false);
  });

  it("allows INSTAGRAM_PUBLISH once the selected page has a linked Instagram account", async () => {
    prismaMocks.credentialFindUnique.mockResolvedValue({
      status: "ACTIVE",
      metadata: {
        selectedPageId: "page-1",
        pages: [
          {
            pageId: "page-1",
            pageName: "Test Page",
            instagramBusinessAccountId: "ig-1",
          },
        ],
        adAccounts: [],
      },
    });
    const provider = new MetaApiProvider();
    expect(await provider.canExecute("INSTAGRAM_PUBLISH", context)).toBe(true);
  });
});

const activeCredential = {
  status: "ACTIVE",
  encryptedSecret: "encrypted",
  metadata: {
    selectedAdAccountId: "act_1",
    selectedPageId: "page-1",
    pages: [{ pageId: "page-1", pageName: "Test Page" }],
    adAccounts: [],
  },
};

function videoAdRequest(
  payload: Record<string, unknown> = {},
): ExecutionRequest {
  return {
    executionJobId: "job-1",
    correlationId: "corr-1",
    idempotencyKey: "idem-1",
    capability: "META_AD_CREATE",
    context,
    payload: {
      adSetId: "adset-1",
      name: "Video ad",
      message: "Check this out",
      link: "https://example.com",
      callToActionType: "LEARN_MORE",
      videoAssetId: "video-asset-1",
      thumbnailAssetId: "thumb-asset-1",
      status: "PAUSED",
      format: "VIDEO",
      ...payload,
    },
  };
}

// The video path is the one genuinely async capability MetaApiProvider
// implements (see meta-api-provider.ts's execute()/getStatus() special
// case) — everything else in this file resolves synchronously within one
// execute() call, so this is the one state machine actually worth testing
// tick-by-tick rather than input/output.
describe("MetaApiProvider video ad path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
    prismaMocks.credentialFindUnique.mockResolvedValue(activeCredential);
    prismaMocks.assetFindFirst.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === "video-asset-1") {
          return Promise.resolve({
            storageKey: "r2://video.mp4",
            mimeType: "video/mp4",
          });
        }
        if (where.id === "thumb-asset-1") {
          return Promise.resolve({ storageKey: "r2://thumb.jpg" });
        }
        return Promise.resolve(null);
      },
    );
    storageMocks.readAsset.mockResolvedValue(Buffer.from("video-bytes"));
    storageMocks.resolveDirectPublicUrl.mockReturnValue(
      "https://cdn.example.com/thumb.jpg",
    );
    metaClientMocks.uploadMetaAdVideo.mockResolvedValue({
      videoId: "video-1",
    });
    metaClientMocks.checkMetaVideoStatus.mockResolvedValue(false);
    metaClientMocks.createMetaVideoAdCreative.mockResolvedValue({
      creativeId: "creative-1",
    });
    metaClientMocks.createMetaAd.mockResolvedValue({ adId: "ad-1" });
  });

  it("execute() uploads the video and returns immediately without creating the ad", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(videoAdRequest());

    expect(result).toEqual({ executionReference: "corr-1", isMock: false });
    expect(metaClientMocks.uploadMetaAdVideo).toHaveBeenCalledOnce();
    expect(metaClientMocks.createMetaAd).not.toHaveBeenCalled();
  });

  it("getStatus() reports RUNNING while Meta is still processing the video", async () => {
    const provider = new MetaApiProvider();
    await provider.execute(videoAdRequest());
    metaClientMocks.checkMetaVideoStatus.mockResolvedValue(false);

    const status = await provider.getStatus("corr-1");

    expect(status).toEqual({ status: "RUNNING", isMock: false });
    expect(metaClientMocks.createMetaAd).not.toHaveBeenCalled();
  });

  it("getStatus() finishes the ad once Meta reports the video ready, and only then", async () => {
    const provider = new MetaApiProvider();
    await provider.execute(videoAdRequest());

    metaClientMocks.checkMetaVideoStatus.mockResolvedValue(false);
    expect(await provider.getStatus("corr-1")).toEqual({
      status: "RUNNING",
      isMock: false,
    });

    metaClientMocks.checkMetaVideoStatus.mockResolvedValue(true);
    const finalStatus = await provider.getStatus("corr-1");

    expect(finalStatus.status).toBe("COMPLETED");
    expect(finalStatus.rawResult).toMatchObject({
      adId: "ad-1",
      creativeId: "creative-1",
      videoId: "video-1",
    });
    expect(metaClientMocks.createMetaVideoAdCreative).toHaveBeenCalledOnce();
    expect(metaClientMocks.createMetaAd).toHaveBeenCalledOnce();

    // A second poll after completion must not repeat the finish steps — the
    // pending record was cleared, so this falls into the "unknown
    // reference" branch (matches OpenClawProvider's own post-terminal
    // behavior) rather than recreating a second ad.
    const secondPoll = await provider.getStatus("corr-1");
    expect(secondPoll.status).toBe("FAILED");
    expect(metaClientMocks.createMetaAd).toHaveBeenCalledOnce();
  });

  it("getStatus() fails the job when Meta reports a video processing error", async () => {
    const provider = new MetaApiProvider();
    await provider.execute(videoAdRequest());
    metaClientMocks.checkMetaVideoStatus.mockRejectedValue(
      new Error("Meta video could not be processed (video_status: error)"),
    );

    const status = await provider.getStatus("corr-1");

    expect(status.status).toBe("FAILED");
    expect(status.errorMessage).toContain("Video processing check failed");
    expect(metaClientMocks.createMetaAd).not.toHaveBeenCalled();
  });

  it("execute() stores a FAILED result immediately when required video fields are missing, without uploading anything", async () => {
    const provider = new MetaApiProvider();
    await provider.execute(videoAdRequest({ videoAssetId: undefined }));

    expect(metaClientMocks.uploadMetaAdVideo).not.toHaveBeenCalled();
    const status = await provider.getStatus("corr-1");
    expect(status.status).toBe("FAILED");
    expect(status.errorMessage).toContain("videoAssetId");
  });

  it("execute() fails without uploading when the thumbnail has no public URL", async () => {
    storageMocks.resolveDirectPublicUrl.mockReturnValue(null);
    const provider = new MetaApiProvider();
    await provider.execute(videoAdRequest());

    expect(metaClientMocks.uploadMetaAdVideo).not.toHaveBeenCalled();
    const status = await provider.getStatus("corr-1");
    expect(status.status).toBe("FAILED");
    expect(status.errorMessage).toContain("public URL");
  });
});

function carouselAdRequest(
  payload: Record<string, unknown> = {},
): ExecutionRequest {
  return {
    executionJobId: "job-2",
    correlationId: "corr-2",
    idempotencyKey: "idem-2",
    capability: "META_AD_CREATE",
    context,
    payload: {
      adSetId: "adset-1",
      name: "Carousel ad",
      message: "Swipe to see more",
      callToActionType: "SHOP_NOW",
      status: "PAUSED",
      format: "CAROUSEL",
      cards: [
        {
          link: "https://example.com/a",
          name: "Card A",
          imageAssetId: "img-a",
        },
        {
          link: "https://example.com/b",
          name: "Card B",
          imageAssetId: "img-b",
        },
      ],
      ...payload,
    },
  };
}

// Carousel resolves synchronously within one execute() call (like every
// non-video capability) — covered as input/output rather than tick-by-tick.
describe("MetaApiProvider carousel ad path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
    prismaMocks.credentialFindUnique.mockResolvedValue(activeCredential);
    prismaMocks.assetFindFirst.mockResolvedValue({
      storageKey: "r2://card.jpg",
    });
    storageMocks.readAsset.mockResolvedValue(Buffer.from("image-bytes"));
    metaClientMocks.uploadMetaAdImage.mockResolvedValue({
      imageHash: "hash-1",
    });
    metaClientMocks.createMetaCarouselAdCreative.mockResolvedValue({
      creativeId: "creative-carousel",
    });
    metaClientMocks.createMetaAd.mockResolvedValue({ adId: "ad-carousel" });
  });

  it("uploads one image per card and creates a carousel creative + ad", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(carouselAdRequest());
    const status = await provider.getStatus(result.executionReference);

    expect(metaClientMocks.uploadMetaAdImage).toHaveBeenCalledTimes(2);
    expect(metaClientMocks.createMetaCarouselAdCreative).toHaveBeenCalledWith(
      expect.objectContaining({
        cards: [
          expect.objectContaining({ imageHash: "hash-1", name: "Card A" }),
          expect.objectContaining({ imageHash: "hash-1", name: "Card B" }),
        ],
      }),
    );
    expect(status).toMatchObject({
      status: "COMPLETED",
      rawResult: { adId: "ad-carousel", cardCount: 2 },
    });
  });

  it("fails without calling Meta when fewer than 2 cards are given", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(
      carouselAdRequest({
        cards: [
          {
            link: "https://example.com/a",
            name: "Card A",
            imageAssetId: "img-a",
          },
        ],
      }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(status.status).toBe("FAILED");
    expect(metaClientMocks.uploadMetaAdImage).not.toHaveBeenCalled();
  });
});

function updateAdRequest(
  payload: Record<string, unknown> = {},
): ExecutionRequest {
  return {
    executionJobId: "job-3",
    correlationId: "corr-3",
    idempotencyKey: "idem-3",
    capability: "META_AD_UPDATE",
    context,
    payload: {
      adId: "ad-1",
      ...payload,
    },
  };
}

// updateAd is the one path that can either skip creative rebuilding
// entirely (pure name/status edit) or reuse an EXISTING image_hash instead
// of uploading — neither exists on the create side, so both get their own
// coverage here rather than relying on createAd's tests to imply they work.
describe("MetaApiProvider updateAd (non-video)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
    prismaMocks.credentialFindUnique.mockResolvedValue(activeCredential);
    metaClientMocks.updateMetaAd.mockResolvedValue(undefined);
  });

  it("skips creative rebuilding for a pure name/status edit", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(
      updateAdRequest({ name: "New name", status: "ACTIVE" }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(metaClientMocks.createMetaAdCreative).not.toHaveBeenCalled();
    expect(metaClientMocks.updateMetaAd).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: "ad-1",
        name: "New name",
        status: "ACTIVE",
      }),
    );
    expect(status.status).toBe("COMPLETED");
  });

  it("fails when neither name/status nor a format is given", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(updateAdRequest());
    const status = await provider.getStatus(result.executionReference);

    expect(status.status).toBe("FAILED");
    expect(metaClientMocks.updateMetaAd).not.toHaveBeenCalled();
  });

  it("uploads a new image when imageAssetId is given", async () => {
    prismaMocks.assetFindFirst.mockResolvedValue({ storageKey: "r2://a.jpg" });
    storageMocks.readAsset.mockResolvedValue(Buffer.from("bytes"));
    metaClientMocks.uploadMetaAdImage.mockResolvedValue({
      imageHash: "fresh-hash",
    });
    metaClientMocks.createMetaAdCreative.mockResolvedValue({
      creativeId: "creative-new",
    });

    const provider = new MetaApiProvider();
    const result = await provider.execute(
      updateAdRequest({
        format: "SINGLE_IMAGE",
        message: "Updated text",
        link: "https://example.com",
        imageAssetId: "img-1",
      }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(metaClientMocks.uploadMetaAdImage).toHaveBeenCalledOnce();
    expect(metaClientMocks.createMetaAdCreative).toHaveBeenCalledWith(
      expect.objectContaining({ imageHash: "fresh-hash" }),
    );
    expect(metaClientMocks.updateMetaAd).toHaveBeenCalledWith(
      expect.objectContaining({ adId: "ad-1", creativeId: "creative-new" }),
    );
    expect(status.status).toBe("COMPLETED");
  });

  it("reuses the existing image hash without uploading when no new image is given", async () => {
    metaClientMocks.createMetaAdCreative.mockResolvedValue({
      creativeId: "creative-reused",
    });

    const provider = new MetaApiProvider();
    const result = await provider.execute(
      updateAdRequest({
        format: "SINGLE_IMAGE",
        message: "Only the text changed",
        link: "https://example.com",
        existingImageHash: "old-hash",
      }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(metaClientMocks.uploadMetaAdImage).not.toHaveBeenCalled();
    expect(prismaMocks.assetFindFirst).not.toHaveBeenCalled();
    expect(metaClientMocks.createMetaAdCreative).toHaveBeenCalledWith(
      expect.objectContaining({ imageHash: "old-hash" }),
    );
    expect(status.status).toBe("COMPLETED");
  });

  it("fails when a carousel card has neither a new image nor an existing hash", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(
      updateAdRequest({
        format: "CAROUSEL",
        message: "Swipe to see more",
        cards: [
          { link: "https://example.com/a", name: "Card A" },
          {
            link: "https://example.com/b",
            name: "Card B",
            existingImageHash: "hash-b",
          },
        ],
      }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(status.status).toBe("FAILED");
    expect(metaClientMocks.createMetaCarouselAdCreative).not.toHaveBeenCalled();
  });
});

function updateVideoAdRequest(
  payload: Record<string, unknown> = {},
): ExecutionRequest {
  return {
    executionJobId: "job-4",
    correlationId: "corr-4",
    idempotencyKey: "idem-4",
    capability: "META_AD_UPDATE",
    context,
    payload: {
      adId: "ad-1",
      message: "New video message",
      link: "https://example.com",
      callToActionType: "LEARN_MORE",
      videoAssetId: "video-asset-1",
      thumbnailAssetId: "thumb-asset-1",
      format: "VIDEO",
      ...payload,
    },
  };
}

// The video path's async state machine (see the "video ad path" describe
// block above) is shared between create and update via PendingVideoAd's
// `mode` field — this covers the finish step actually calling updateMetaAd
// (not createMetaAd) once the video is ready.
describe("MetaApiProvider updateAd video path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
    prismaMocks.credentialFindUnique.mockResolvedValue(activeCredential);
    prismaMocks.assetFindFirst.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === "video-asset-1") {
          return Promise.resolve({
            storageKey: "r2://video.mp4",
            mimeType: "video/mp4",
          });
        }
        if (where.id === "thumb-asset-1") {
          return Promise.resolve({ storageKey: "r2://thumb.jpg" });
        }
        return Promise.resolve(null);
      },
    );
    storageMocks.readAsset.mockResolvedValue(Buffer.from("video-bytes"));
    storageMocks.resolveDirectPublicUrl.mockReturnValue(
      "https://cdn.example.com/thumb.jpg",
    );
    metaClientMocks.uploadMetaAdVideo.mockResolvedValue({
      videoId: "video-2",
    });
    metaClientMocks.checkMetaVideoStatus.mockResolvedValue(true);
    metaClientMocks.createMetaVideoAdCreative.mockResolvedValue({
      creativeId: "creative-video-update",
    });
    metaClientMocks.updateMetaAd.mockResolvedValue(undefined);
  });

  it("finishes by calling updateMetaAd, never createMetaAd", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(updateVideoAdRequest());
    const status = await provider.getStatus(result.executionReference);

    expect(metaClientMocks.updateMetaAd).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: "ad-1",
        creativeId: "creative-video-update",
      }),
    );
    expect(metaClientMocks.createMetaAd).not.toHaveBeenCalled();
    expect(status.status).toBe("COMPLETED");
  });

  it("requires adId for a video update", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(
      updateVideoAdRequest({ adId: undefined }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(status.status).toBe("FAILED");
    expect(metaClientMocks.uploadMetaAdVideo).not.toHaveBeenCalled();
  });
});

// Reusing the CURRENT video (no new file) is fully synchronous — Meta's
// already-processed video needs no upload and no async wait, unlike every
// other video path above.
describe("MetaApiProvider updateAd reusing an existing video", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    envMocks.configured = true;
    prismaMocks.credentialFindUnique.mockResolvedValue(activeCredential);
    prismaMocks.assetFindFirst.mockResolvedValue({
      storageKey: "r2://thumb.jpg",
    });
    storageMocks.resolveDirectPublicUrl.mockReturnValue(
      "https://cdn.example.com/thumb.jpg",
    );
    metaClientMocks.createMetaVideoAdCreative.mockResolvedValue({
      creativeId: "creative-reused-video",
    });
    metaClientMocks.updateMetaAd.mockResolvedValue(undefined);
  });

  it("resolves synchronously without uploading a video or waiting", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(
      updateAdRequest({
        format: "VIDEO",
        message: "Same video, new text",
        link: "https://example.com",
        existingVideoId: "video-existing-1",
        thumbnailAssetId: "thumb-asset-1",
      }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(metaClientMocks.uploadMetaAdVideo).not.toHaveBeenCalled();
    expect(metaClientMocks.checkMetaVideoStatus).not.toHaveBeenCalled();
    expect(metaClientMocks.createMetaVideoAdCreative).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: "video-existing-1" }),
    );
    expect(status.status).toBe("COMPLETED");
  });

  it("fails when neither a new video nor existingVideoId is given", async () => {
    const provider = new MetaApiProvider();
    const result = await provider.execute(
      updateAdRequest({
        format: "VIDEO",
        message: "Missing video reference",
        link: "https://example.com",
        thumbnailAssetId: "thumb-asset-1",
      }),
    );
    const status = await provider.getStatus(result.executionReference);

    expect(status.status).toBe("FAILED");
    expect(metaClientMocks.createMetaVideoAdCreative).not.toHaveBeenCalled();
  });
});
