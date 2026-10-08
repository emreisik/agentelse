import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addBrandPhoto: vi.fn(),
  analyze: vi.fn(),
  mediaFindFirst: vi.fn(),
  mediaUpdate: vi.fn(),
  mediaDelete: vi.fn(),
  assetFindFirst: vi.fn(),
  assetDelete: vi.fn(),
  deleteAsset: vi.fn(),
  record: vi.fn(),
  limited: vi.fn(),
  after: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: mocks.limited }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    brandMedia: {
      findFirst: mocks.mediaFindFirst,
      update: mocks.mediaUpdate,
      delete: mocks.mediaDelete,
    },
    asset: { findFirst: mocks.assetFindFirst, delete: mocks.assetDelete },
  },
}));
vi.mock("@/server/brand/media/store", () => ({ addBrandPhoto: mocks.addBrandPhoto }));
vi.mock("@/server/brand/media/analyze", () => ({ analyzeBrandMedia: mocks.analyze }));
vi.mock("@/server/storage/asset-storage", () => ({ deleteAsset: mocks.deleteAsset }));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.record },
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: async () => ({ userId: "u1" }),
  requireProjectAccess: async () => ({ workspaceId: "w1", defaultBrandId: "b1" }),
}));

import {
  archiveBrandMediaAction,
  deleteBrandMediaAction,
  reanalyzeBrandMediaAction,
  updateBrandMediaTagsAction,
  uploadBrandPhotoAction,
} from "./brand-media-actions";

const form = (over: Record<string, unknown> = {}) => {
  const data = new FormData();
  data.set("projectId", "p1");
  data.set("consent", "yes");
  data.set("file", new File([new Uint8Array([1, 2, 3])], "IMG_1.jpg", { type: "image/jpeg" }));
  for (const [key, value] of Object.entries(over)) {
    if (value === null) data.delete(key);
    else data.set(key, value as string | Blob);
  }
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.limited.mockReturnValue(false);
  mocks.record.mockResolvedValue(undefined);
  mocks.analyze.mockResolvedValue("ok");
  mocks.addBrandPhoto.mockResolvedValue({ ok: true, mediaId: "m1", assetId: "a1", duplicate: false });
  mocks.mediaFindFirst.mockResolvedValue({ id: "m1", assetId: "a1", useCount: 0 });
  mocks.mediaUpdate.mockResolvedValue({});
  mocks.mediaDelete.mockResolvedValue({});
  mocks.assetFindFirst.mockResolvedValue({ id: "a1", storageKey: "r2://a.jpg" });
  mocks.assetDelete.mockResolvedValue({});
  mocks.deleteAsset.mockResolvedValue(true);
});

describe("uploadBrandPhotoAction", () => {
  it("adds the photo to the caller's own project and has it read right away", async () => {
    const result = await uploadBrandPhotoAction(form());
    expect(result).toEqual({ ok: true, mediaId: "m1", duplicate: false });
    expect(mocks.addBrandPhoto.mock.calls[0]![0]).toMatchObject({
      scope: { workspaceId: "w1", projectId: "p1", brandId: "b1" },
      filename: "IMG_1.jpg",
    });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("needs the rights confirmation, and stores nothing without it", async () => {
    const result = await uploadBrandPhotoAction(form({ consent: null }));
    expect(result).toMatchObject({ ok: false });
    expect(mocks.addBrandPhoto).not.toHaveBeenCalled();
  });

  it("refuses an empty or oversized file and a flood of uploads", async () => {
    expect(await uploadBrandPhotoAction(form({ file: null }))).toMatchObject({ ok: false });
    const big = { size: 26 * 1024 * 1024, name: "big.jpg" };
    const data = form();
    // A File-like object over the limit.
    Object.defineProperty(data.get("file") as File, "size", { value: big.size });
    expect(await uploadBrandPhotoAction(data)).toMatchObject({ ok: false });
    mocks.limited.mockReturnValue(true);
    expect(await uploadBrandPhotoAction(form())).toMatchObject({ ok: false });
    expect(mocks.addBrandPhoto).not.toHaveBeenCalled();
  });

  it("names the file when it cannot be used, and does not read a photo that was already there", async () => {
    mocks.addBrandPhoto.mockResolvedValue({ ok: false, reason: "That file isn't a picture." });
    expect(await uploadBrandPhotoAction(form())).toEqual({
      ok: false,
      message: "IMG_1.jpg: That file isn't a picture.",
    });
    mocks.addBrandPhoto.mockResolvedValue({ ok: true, mediaId: "m1", assetId: "a1", duplicate: true });
    await uploadBrandPhotoAction(form());
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("still succeeds when the work cannot be deferred (the worker will read it)", async () => {
    mocks.after.mockImplementation(() => {
      throw new Error("outside a request");
    });
    expect(await uploadBrandPhotoAction(form())).toMatchObject({ ok: true });
  });
});

describe("the photo's own actions", () => {
  it("find the photo inside the caller's project only", async () => {
    await archiveBrandMediaAction("p1", "m1", true);
    expect(mocks.mediaFindFirst).toHaveBeenCalledWith({ where: { id: "m1", projectId: "p1" } });
    mocks.mediaFindFirst.mockResolvedValue(null);
    expect(await archiveBrandMediaAction("p1", "other", true)).toMatchObject({ ok: false });
    expect(await updateBrandMediaTagsAction("p1", "other", { tags: [] })).toMatchObject({ ok: false });
    expect(await deleteBrandMediaAction("p1", "other")).toMatchObject({ ok: false });
  });

  it("archives and restores", async () => {
    await archiveBrandMediaAction("p1", "m1", true);
    expect(mocks.mediaUpdate.mock.calls[0]![0].data.archivedAt).toBeInstanceOf(Date);
    await archiveBrandMediaAction("p1", "m1", false);
    expect(mocks.mediaUpdate.mock.calls[1]![0].data).toEqual({ archivedAt: null });
  });

  it("cleans the tags and keeps them through re-analysis", async () => {
    await updateBrandMediaTagsAction("p1", "m1", {
      tags: ["#Kahve", "KAHVE", " Latte Art "],
      description: "  A cup.  ",
    });
    expect(mocks.mediaUpdate.mock.calls[0]![0].data).toEqual({
      tags: ["kahve", "latte art"],
      tagsEdited: true,
      description: "A cup.",
    });
  });

  it("reads a photo again from the start", async () => {
    await reanalyzeBrandMediaAction("p1", "m1");
    expect(mocks.mediaUpdate.mock.calls[0]![0].data).toEqual({
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: null,
    });
    expect(mocks.after).toHaveBeenCalled();
  });
});

describe("deleteBrandMediaAction", () => {
  it("removes the row, the asset and the stored file", async () => {
    expect(await deleteBrandMediaAction("p1", "m1")).toEqual({ ok: true });
    expect(mocks.mediaDelete).toHaveBeenCalledWith({ where: { id: "m1" } });
    expect(mocks.assetDelete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(mocks.deleteAsset).toHaveBeenCalledWith("r2://a.jpg");
    expect(mocks.assetFindFirst.mock.calls[0]![0].where).toMatchObject({ projectId: "p1" });
  });

  it("will not delete a photo posts were made from: archive it instead", async () => {
    mocks.mediaFindFirst.mockResolvedValue({ id: "m1", assetId: "a1", useCount: 2 });
    const result = await deleteBrandMediaAction("p1", "m1");
    expect(result).toMatchObject({ ok: false });
    expect(mocks.mediaDelete).not.toHaveBeenCalled();
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });
});
