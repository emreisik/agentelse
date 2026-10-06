import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assetThumbnail,
  canResize,
  clearAssetThumbnailCache,
  parseAssetWidth,
} from "./asset-thumbnail";

// What this suite proves: only the allowed widths and still images are
// resized, the preview is a WebP no wider than asked (and never enlarged), and
// a second ask for the same preview does not read the file again.

const png = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: "#0b1f3a" },
  })
    .png()
    .toBuffer();

describe("asset thumbnails", () => {
  beforeEach(() => clearAssetThumbnailCache());

  it("accepts only the widths the app asks for", () => {
    expect(parseAssetWidth("320")).toBe(320);
    expect(parseAssetWidth("768")).toBe(768);
    expect(parseAssetWidth("1280")).toBe(1280);
    expect(parseAssetWidth("321")).toBeNull();
    expect(parseAssetWidth("abc")).toBeNull();
    expect(parseAssetWidth(null)).toBeNull();
  });

  it("resizes still raster images only", () => {
    expect(canResize("image/png")).toBe(true);
    expect(canResize("image/jpeg")).toBe(true);
    expect(canResize("image/svg+xml")).toBe(false);
    expect(canResize("image/gif")).toBe(false);
    expect(canResize("application/pdf")).toBe(false);
  });

  it("makes a WebP at the asked width, never larger than the original, once", async () => {
    const original = await png(1080, 1350);
    const read = vi.fn(async () => original);

    const preview = await assetThumbnail("a1", 320, read);
    const meta = await sharp(preview).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
    expect(preview.byteLength).toBeLessThan(original.byteLength);

    await assetThumbnail("a1", 320, read);
    expect(read).toHaveBeenCalledTimes(1);

    const small = await assetThumbnail("a2", 1280, async () => png(200, 100));
    expect((await sharp(small).metadata()).width).toBe(200);
  });

  it("serves a stored preview without reading the original, and stores a new one", async () => {
    const kept = Buffer.from("kept-preview");
    const read = vi.fn(async () => png(1080, 1350));
    const fromStore = await assetThumbnail("a3", 320, read, {
      read: async () => kept,
      write: vi.fn(async () => undefined),
    });
    expect(fromStore).toBe(kept);
    expect(read).not.toHaveBeenCalled();

    const write = vi.fn(async (preview: Buffer) => void preview);
    const made = await assetThumbnail("a4", 320, read, {
      read: async () => null,
      write,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(made);
  });
});
