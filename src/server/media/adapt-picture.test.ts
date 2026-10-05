import { beforeEach, describe, expect, it, vi } from "vitest";

// Another format of a post is laid out from the post's picture. When the
// post's words were typeset by us, the clean picture (before the words, logo
// and band) is used and the words come along to be set again; otherwise the
// finished picture is adapted, words and all, as before.

const db = vi.hoisted(() => ({
  assetFindUnique: vi.fn(),
  versionFindFirst: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    asset: { findUnique: db.assetFindUnique },
    creativeVersion: { findFirst: db.versionFindFirst },
  },
}));
const storage = vi.hoisted(() => ({ readAsset: vi.fn(), putAsset: vi.fn() }));
vi.mock("@/server/storage/asset-storage", () => storage);

const { adaptPicturePrompt, keepCleanPicture, readPictureForAdapting } =
  await import("@/server/media/adapt-picture");

const words = { headline: "Pazar kahvaltısı", lines: ["Rezervasyon profilde"] };

beforeEach(() => {
  vi.clearAllMocks();
  db.assetFindUnique.mockResolvedValue({
    storageKey: "r2://post.png",
    mimeType: "image/png",
  });
  db.versionFindFirst.mockResolvedValue({
    generationMetadata: {
      layoutTemplate: { id: "headline-top", name: "Headline on top" },
      onImageText: words,
      cleanPicture: { storageKey: "r2://clean.webp", mimeType: "image/webp" },
    },
  });
  storage.readAsset.mockImplementation(async (key: string) =>
    Buffer.from(`bytes:${key}`),
  );
});

describe("readPictureForAdapting", () => {
  it("gives the clean picture and the post's words", async () => {
    const picture = await readPictureForAdapting("asset-1");
    expect(db.versionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { assetId: "asset-1" } }),
    );
    expect(picture).toEqual({
      data: Buffer.from("bytes:r2://clean.webp").toString("base64"),
      mimeType: "image/webp",
      text: words,
    });
  });

  it("a post without typeset words adapts its finished picture", async () => {
    db.versionFindFirst.mockResolvedValue({
      generationMetadata: { layoutTemplate: null },
    });
    expect(await readPictureForAdapting("asset-1")).toEqual({
      data: Buffer.from("bytes:r2://post.png").toString("base64"),
      mimeType: "image/png",
    });
  });

  it("a clean copy that is gone falls back to the finished picture, without words to set again", async () => {
    storage.readAsset.mockImplementation(async (key: string) => {
      if (key === "r2://clean.webp") throw new Error("gone");
      return Buffer.from(`bytes:${key}`);
    });
    const picture = await readPictureForAdapting("asset-1");
    expect(picture?.mimeType).toBe("image/png");
    expect(picture).not.toHaveProperty("text");
  });

  it("an unknown picture is undefined", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    expect(await readPictureForAdapting("nope")).toBeUndefined();
  });
});

describe("keepCleanPicture", () => {
  it("stores a copy of the render before anything is set on it", async () => {
    storage.putAsset.mockResolvedValue({
      storageKey: "r2://copy.png",
      filename: "copy.png",
    });
    expect(
      await keepCleanPicture({
        storageKey: "r2://render.png",
        mimeType: "image/png",
      }),
    ).toEqual({ storageKey: "r2://copy.png", mimeType: "image/png" });
    expect(storage.putAsset).toHaveBeenCalledWith(
      Buffer.from("bytes:r2://render.png"),
      "png",
      "image/png",
    );
  });

  it("is best-effort", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    storage.putAsset.mockRejectedValue(new Error("R2 is not configured"));
    expect(
      await keepCleanPicture({
        storageKey: "r2://render.png",
        mimeType: "image/png",
      }),
    ).toBeUndefined();
  });
});

describe("adaptPicturePrompt", () => {
  const base = {
    pixelSize: { width: 1080, height: 1920 },
    aspectRatio: "9:16",
    formatLabel: "Story (9:16)",
  };

  it("keeps the picture textless when its words are set again afterwards", () => {
    const prompt = adaptPicturePrompt({
      ...base,
      textArea: "centered in the middle of the frame",
    });
    expect(prompt).toContain(
      "The picture carries no text and must stay that way",
    );
    expect(prompt).toContain(
      "typeset afterwards centered in the middle of the frame",
    );
    expect(prompt).not.toContain("Keep every word");
  });

  it("keeps the words of a picture that already carries them", () => {
    expect(adaptPicturePrompt(base)).toContain(
      "Keep every word of on-image text exactly as written",
    );
  });
});
