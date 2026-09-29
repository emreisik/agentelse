import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { analyzeLogo, dominantColors, prepareLogo } from "./image-colors";

type Rgba = { r: number; g: number; b: number; alpha?: number };

// A logo-ish test image: a centred rectangle ("the mark") on a background.
async function logo(options: {
  background: Rgba;
  mark: Rgba;
  width?: number;
  height?: number;
}): Promise<Buffer> {
  const width = options.width ?? 160;
  const height = options.height ?? 80;
  const markBuffer = await sharp({
    create: {
      width: Math.round(width * 0.5),
      height: Math.round(height * 0.4),
      channels: 4,
      background: { ...options.mark, alpha: options.mark.alpha ?? 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { ...options.background, alpha: options.background.alpha ?? 1 },
    },
  })
    .composite([{ input: markBuffer, gravity: "centre" }])
    .png()
    .toBuffer();
}

describe("analyzeLogo", () => {
  it("dark mark on a transparent background -> dark logo, no solid background", async () => {
    const png = await logo({
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      mark: { r: 11, g: 31, b: 58 },
    });
    expect(await analyzeLogo(png)).toEqual({ tone: "dark", hasSolidBackground: false });
  });

  it("white mark on a transparent background -> light logo", async () => {
    const png = await logo({
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      mark: { r: 255, g: 255, b: 255 },
    });
    expect(await analyzeLogo(png)).toEqual({ tone: "light", hasSolidBackground: false });
  });

  it("mid-tone brand colour (teal) still counts as a dark logo for light backgrounds", async () => {
    const png = await logo({
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      mark: { r: 13, g: 148, b: 136 },
    });
    expect((await analyzeLogo(png)).tone).toBe("dark");
  });

  it("dark wordmark on an opaque WHITE background is dark, not light", async () => {
    const png = await logo({
      background: { r: 255, g: 255, b: 255 },
      mark: { r: 20, g: 20, b: 20 },
    });
    expect(await analyzeLogo(png)).toEqual({ tone: "dark", hasSolidBackground: true });
  });

  it("white mark on an opaque navy block is light", async () => {
    const png = await logo({
      background: { r: 11, g: 31, b: 58 },
      mark: { r: 255, g: 255, b: 255 },
    });
    expect(await analyzeLogo(png)).toEqual({ tone: "light", hasSolidBackground: true });
  });

  it("falls back safely on garbage input", async () => {
    expect(await analyzeLogo(Buffer.from("not an image"))).toEqual({
      tone: "dark",
      hasSolidBackground: false,
    });
  });
});

describe("prepareLogo / dominantColors", () => {
  it("re-encodes to a PNG within 512px and rejects non-images and tiny images", async () => {
    const big = await logo({ background: { r: 0, g: 0, b: 0, alpha: 0 }, mark: { r: 200, g: 30, b: 30 }, width: 1600, height: 800 });
    const prepared = await prepareLogo(big);
    expect(prepared).not.toBeNull();
    expect(Math.max(prepared!.width, prepared!.height)).toBeLessThanOrEqual(512);
    expect((await sharp(prepared!.png).metadata()).format).toBe("png");

    expect(await prepareLogo(Buffer.from("<html>nope</html>"))).toBeNull();
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#f00" } }).png().toBuffer();
    expect(await prepareLogo(tiny)).toBeNull();
  });

  it("crops the transparent padding off, so the stored logo is the mark itself", async () => {
    const mark = await sharp({
      create: { width: 200, height: 80, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const padded = await sharp({
      create: { width: 500, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: mark, left: 150, top: 160 }])
      .png()
      .toBuffer();

    const prepared = await prepareLogo(padded);
    expect(prepared).toEqual({ png: expect.any(Buffer), width: 200, height: 80 });
    expect(await sharp(prepared!.png).metadata()).toMatchObject({ width: 200, height: 80 });
  });

  it("keeps the whole image when cropping would leave a speck", async () => {
    const dot = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const canvas = await sharp({
      create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: dot, left: 150, top: 150 }])
      .png()
      .toBuffer();

    const prepared = await prepareLogo(canvas);
    expect(prepared).toMatchObject({ width: 300, height: 300 });
  });

  it("finds the brand colour and ignores neutrals / transparency", async () => {
    const png = await logo({
      background: { r: 255, g: 255, b: 255 },
      mark: { r: 13, g: 148, b: 136 },
    });
    const colors = await dominantColors(png, 2);
    expect(colors[0]).toBe("#0d9488");
    expect(colors).toHaveLength(1);
  });
});
