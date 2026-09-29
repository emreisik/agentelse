import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { trimTransparentBorders } from "./logo-trim";

// A `w`x`h` transparent canvas with one opaque `block` rectangle.
async function padded(
  w: number,
  h: number,
  block: { left: number; top: number; width: number; height: number },
  alpha = 1,
) {
  const mark = await sharp({
    create: {
      width: block.width,
      height: block.height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, left: block.left, top: block.top }])
    .png()
    .toBuffer();
}

const dims = async (buffer: Buffer) => {
  const meta = await sharp(buffer).metadata();
  return { width: meta.width, height: meta.height };
};

describe("trimTransparentBorders", () => {
  it("crops empty padding down to the mark, whatever its shape", async () => {
    const input = await padded(400, 200, { left: 50, top: 30, width: 120, height: 60 });
    const out = await trimTransparentBorders(input);
    expect(await dims(out)).toEqual({ width: 120, height: 60 });

    // The crop is the mark itself: every pixel is opaque red.
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < info.width * info.height; i++) {
      expect(data.subarray(i * 4, i * 4 + 4)).toEqual(Buffer.from([255, 0, 0, 255]));
    }
  });

  it("leaves a logo with no padding untouched", async () => {
    const input = await padded(100, 50, { left: 0, top: 0, width: 100, height: 50 });
    expect(await trimTransparentBorders(input)).toBe(input);
  });

  it("does not bother with a sliver of padding", async () => {
    const input = await padded(102, 52, { left: 1, top: 1, width: 100, height: 50 });
    expect(await trimTransparentBorders(input)).toBe(input);
  });

  it("leaves opaque images (no alpha channel) untouched", async () => {
    const input = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "#123456" },
    })
      .jpeg()
      .toBuffer();
    expect(await trimTransparentBorders(input)).toBe(input);
  });

  it("leaves a fully transparent image alone: there is no mark to anchor on", async () => {
    const input = await sharp({
      create: { width: 60, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    expect(await trimTransparentBorders(input)).toBe(input);
  });

  it("ignores faint haze around the mark but keeps anything visible", async () => {
    // alpha 0.02 (~5/255) is haze; the real mark is opaque.
    const haze = await padded(300, 300, { left: 0, top: 0, width: 300, height: 300 }, 0.02);
    const mark = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const input = await sharp(haze).composite([{ input: mark, left: 100, top: 120 }]).png().toBuffer();

    expect(await dims(await trimTransparentBorders(input))).toEqual({ width: 40, height: 40 });
  });

  it("finds the mark in a large upload without decoding it at full size, never clipping it", async () => {
    const input = await padded(3000, 2000, { left: 900, top: 700, width: 1200, height: 500 });
    const out = await dims(await trimTransparentBorders(input));
    // Detected on a downscaled copy, rounded outwards: at least the mark, and
    // at most a few analysis-pixels of slack.
    expect(out.width!).toBeGreaterThanOrEqual(1200);
    expect(out.width!).toBeLessThanOrEqual(1200 + 12);
    expect(out.height!).toBeGreaterThanOrEqual(500);
    expect(out.height!).toBeLessThanOrEqual(500 + 12);
  });

  it("leaves SVG alone rather than rasterizing it", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="80" y="40" width="40" height="20"/></svg>',
    );
    expect(await trimTransparentBorders(svg)).toBe(svg);
  });

  it("returns the input when it is not an image at all", async () => {
    const junk = Buffer.from("not an image");
    expect(await trimTransparentBorders(junk)).toBe(junk);
  });
});
