import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  assetCreate: vi.fn(),
  mediaUpsert: vi.fn(),
  mediaUpdate: vi.fn(),
  mediaFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  putAsset: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    asset: { findFirst: mocks.assetFindFirst, create: mocks.assetCreate },
    brandMedia: {
      upsert: mocks.mediaUpsert,
      update: mocks.mediaUpdate,
      findUnique: mocks.mediaFindUnique,
    },
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("@/server/storage/asset-storage", () => ({ putAsset: mocks.putAsset }));

import { addBrandPhoto, adoptExistingPhotos, ensureMediaRow } from "./store";

const scope = { workspaceId: "w1", projectId: "p1", brandId: "b1" };
const photo = (width = 1200, height = 900) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 120, b: 60 } },
  })
    .jpeg()
    .toBuffer();

describe("addBrandPhoto", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assetFindFirst.mockResolvedValue(null);
    mocks.putAsset.mockResolvedValue({ storageKey: "r2://a.jpg", filename: "a.jpg" });
    mocks.assetCreate.mockResolvedValue({ id: "asset-1" });
    mocks.mediaUpsert.mockResolvedValue({ id: "media-1" });
    mocks.mediaUpdate.mockResolvedValue({});
  });

  it("stores the normalised copy once and queues it for analysis", async () => {
    const result = await addBrandPhoto({ scope, bytes: await photo(), filename: "IMG_1.jpg" });
    expect(result).toEqual({ ok: true, mediaId: "media-1", assetId: "asset-1", duplicate: false });
    expect(mocks.putAsset).toHaveBeenCalledTimes(1);
    expect(mocks.putAsset.mock.calls[0]![1]).toBe("jpg");
    expect(mocks.assetCreate.mock.calls[0]![0].data).toMatchObject({
      projectId: "p1",
      brandId: "b1",
      type: "IMAGE",
      source: "CUSTOMER_UPLOAD",
      mimeType: "image/jpeg",
      width: 1200,
      height: 900,
      hash: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(mocks.mediaUpsert.mock.calls[0]![0]).toMatchObject({
      where: { assetId: "asset-1" },
      create: { status: "PENDING", kind: "IMAGE", orientation: "landscape", projectId: "p1" },
    });
  });

  it("does not add the same photo twice: it returns the one already there and restores it if archived", async () => {
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-old" });
    const result = await addBrandPhoto({ scope, bytes: await photo(), filename: "again.jpg" });
    expect(result).toMatchObject({ ok: true, assetId: "asset-old", duplicate: true });
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.assetCreate).not.toHaveBeenCalled();
    expect(mocks.mediaUpdate).toHaveBeenCalledWith({
      where: { id: "media-1" },
      data: { archivedAt: null },
    });
    // The lookup is always inside the project.
    expect(mocks.assetFindFirst.mock.calls[0]![0].where).toMatchObject({ projectId: "p1", type: "IMAGE" });
  });

  it("refuses what is not a usable photo, storing nothing", async () => {
    const result = await addBrandPhoto({ scope, bytes: await photo(200, 200), filename: "tiny.jpg" });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.assetCreate).not.toHaveBeenCalled();
  });
});

describe("ensureMediaRow", () => {
  beforeEach(() => vi.resetAllMocks());

  it("finds the other upload's row when two uploads of one photo race", async () => {
    mocks.mediaUpsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }),
    );
    mocks.mediaFindUnique.mockResolvedValue({ id: "media-race" });
    expect(await ensureMediaRow(scope, "asset-1", {})).toEqual({ id: "media-race" });
  });

  it("lets any other error through", async () => {
    mocks.mediaUpsert.mockRejectedValue(new Error("db down"));
    await expect(ensureMediaRow(scope, "asset-1", {})).rejects.toThrow("db down");
  });
});

describe("adoptExistingPhotos", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mediaUpsert.mockResolvedValue({ id: "m" });
  });

  it("brings in library uploads that predate the media library, with their own project", async () => {
    mocks.queryRaw.mockResolvedValue([
      { id: "a1", workspaceId: "w1", projectId: "p1", brandId: "b1", width: 800, height: 1200 },
      { id: "a2", workspaceId: "w2", projectId: "p2", brandId: "b2", width: null, height: null },
    ]);
    expect(await adoptExistingPhotos()).toBe(2);
    expect(mocks.mediaUpsert.mock.calls[0]![0]).toMatchObject({
      where: { assetId: "a1" },
      create: { projectId: "p1", orientation: "portrait" },
    });
    expect(mocks.mediaUpsert.mock.calls[1]![0].create).toMatchObject({
      projectId: "p2",
      orientation: null,
    });
  });

  it("does nothing when there is nothing to bring in", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    expect(await adoptExistingPhotos()).toBe(0);
    expect(mocks.mediaUpsert).not.toHaveBeenCalled();
  });
});
