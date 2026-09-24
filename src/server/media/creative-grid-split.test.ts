import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const putAssetMock = vi.fn(
  async (buffer: Buffer, ext: string, mimeType: string) => ({
    storageKey: `r2://fake-${Math.random().toString(36).slice(2)}.${ext}`,
    filename: `fake.${ext}`,
  }),
);
vi.mock("@/server/storage/asset-storage", () => ({
  putAsset: (...args: Parameters<typeof putAssetMock>) => putAssetMock(...args),
}));

import { splitImageIntoGridTiles } from "@/server/media/creative-grid-split";

async function pixelAt(
  buffer: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx]!, data[idx + 1]!, data[idx + 2]!];
}

// A 300x100 canvas built as three solid-color 100x100 bands side by side
// (red | green | blue) — already exactly the "3x1" canvas size for a
// 100x100 tile, so the split's own cover-fit resize is a no-op and each
// tile's color is deterministic, letting the test assert on exact extract
// offsets rather than just dimensions/counts.
async function threeBandSource(): Promise<Buffer> {
  const band = (rgb: [number, number, number]) =>
    sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: rgb[0], g: rgb[1], b: rgb[2] },
      },
    })
      .png()
      .toBuffer();
  const [red, green, blue] = await Promise.all([
    band([255, 0, 0]),
    band([0, 255, 0]),
    band([0, 0, 255]),
  ]);
  return sharp({
    create: {
      width: 300,
      height: 100,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      { input: red, left: 0, top: 0 },
      { input: green, left: 100, top: 0 },
      { input: blue, left: 200, top: 0 },
    ])
    .png()
    .toBuffer();
}

describe("splitImageIntoGridTiles", () => {
  beforeEach(() => {
    putAssetMock.mockClear();
  });

  it("3x1: produces 3 tiles, correctly ordered left-to-right", async () => {
    const source = await threeBandSource();
    const tiles = await splitImageIntoGridTiles(source, "3x1", {
      width: 100,
      height: 100,
    });

    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => t.position)).toEqual([1, 2, 3]);
    expect(tiles.every((t) => t.width === 100 && t.height === 100)).toBe(true);
    expect(putAssetMock).toHaveBeenCalledTimes(3);

    // Re-fetch each tile's actual bytes from the mocked putAsset calls to
    // confirm the extract offsets landed on the right band.
    const buffers = putAssetMock.mock.calls.map((call) => call[0] as Buffer);
    expect(await pixelAt(buffers[0]!, 50, 50)).toEqual([255, 0, 0]);
    expect(await pixelAt(buffers[1]!, 50, 50)).toEqual([0, 255, 0]);
    expect(await pixelAt(buffers[2]!, 50, 50)).toEqual([0, 0, 255]);
  });

  it("3x3: produces 9 tiles in row-major reading order", async () => {
    const source = await threeBandSource();
    const tiles = await splitImageIntoGridTiles(source, "3x3", {
      width: 60,
      height: 60,
    });

    expect(tiles).toHaveLength(9);
    expect(tiles.map((t) => t.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tiles.every((t) => t.width === 60 && t.height === 60)).toBe(true);
    expect(putAssetMock).toHaveBeenCalledTimes(9);
  });
});
