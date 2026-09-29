import "server-only";

import sharp from "sharp";

import { trimTransparentBorders } from "@/server/media/logo-trim";

import { isNeutral, rgbToHex, type Rgb } from "./extract";

// Pixel limits keep a hostile "logo" (a decompression bomb, a 100-megapixel
// PNG) from exhausting memory: sharp refuses inputs above this.
const LIMIT_INPUT_PIXELS = 40_000_000;
const LOGO_MAX_EDGE = 512;
const MIN_EDGE = 24;
const MAX_EDGE = 8000;
// Shortest side a logo may have after its padding is cropped off.
const MIN_TRIMMED_EDGE = 12;

export type PreparedLogo = {
  png: Buffer;
  width: number;
  height: number;
};

// Validates and normalizes anything that claims to be a logo (png / jpeg /
// webp / gif / svg): real decode via sharp (never trust the Content-Type),
// sane dimensions, re-encoded as a transparent PNG no larger than 512px with
// its empty transparent padding cropped off (so the stored logo IS the mark,
// and a layout's size / margin apply to it). Also rasterizes SVG; sanitized
// SVG never reaches here with external references.
export async function prepareLogo(input: Buffer): Promise<PreparedLogo | null> {
  try {
    const source = sharp(input, {
      limitInputPixels: LIMIT_INPUT_PIXELS,
      failOn: "error",
      density: 300,
    });
    const meta = await source.metadata();
    if (!meta.width || !meta.height) return null;
    if (meta.width < MIN_EDGE || meta.height < MIN_EDGE) return null;
    if (meta.width > MAX_EDGE || meta.height > MAX_EDGE) return null;

    const { data, info } = await source
      .resize({
        width: LOGO_MAX_EDGE,
        height: LOGO_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });

    // A mark that shrinks to a speck when cropped is more likely a stray dot
    // on a big canvas than a logo: keep the uncropped image in that case.
    const cropped = await trimTransparentBorders(data);
    if (cropped !== data) {
      const croppedMeta = await sharp(cropped).metadata();
      if (
        croppedMeta.width &&
        croppedMeta.height &&
        croppedMeta.width >= MIN_TRIMMED_EDGE &&
        croppedMeta.height >= MIN_TRIMMED_EDGE
      ) {
        return {
          png: cropped,
          width: croppedMeta.width,
          height: croppedMeta.height,
        };
      }
    }
    return { png: data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

// Downscaled JPEG for the vision model: enough to judge style and mood, far
// smaller (and cheaper) than the original.
export async function prepareVisionImage(input: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS, failOn: "error" })
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    return null;
  }
}

// Dominant chromatic colours of an image, by 4-bit-per-channel buckets.
// Transparent pixels and neutrals (white/black/grey backgrounds) are skipped,
// because for a logo the brand colour is what is left after the background.
// Edge pixels (whose neighbours differ noticeably) are skipped too: they are
// anti-aliasing blends of two real colours and would show up as phantom
// "colours" like a pale tint of the brand colour.
const EDGE_DISTANCE = 28;
const MERGE_DISTANCE = 36;

type Bucket = { count: number; r: number; g: number; b: number };

function bucketColors(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  skipEdges: boolean,
): Map<number, Bucket> {
  const px = (x: number, y: number): Rgb => {
    const i = (y * width + x) * channels;
    return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
  };
  const far = (a: Rgb, b: Rgb) =>
    Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2) > EDGE_DISTANCE;

  const buckets = new Map<number, Bucket>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      if (data[i + 3]! < 200) continue;
      const rgb = px(x, y);
      if (isNeutral(rgb)) continue;
      if (skipEdges) {
        const neighbours: [number, number][] = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        const onEdge = neighbours.some(([nx, ny]) => {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
          // A transparent neighbour is the logo's outline against nothing.
          if (data[(ny * width + nx) * channels + 3]! < 200) return true;
          return far(rgb, px(nx, ny));
        });
        if (onEdge) continue;
      }
      const key = ((rgb.r >> 4) << 8) | ((rgb.g >> 4) << 4) | (rgb.b >> 4);
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += rgb.r;
      bucket.g += rgb.g;
      bucket.b += rgb.b;
      buckets.set(key, bucket);
    }
  }
  return buckets;
}

export async function dominantColors(input: Buffer, limit = 3): Promise<string[]> {
  try {
    const { data, info } = await sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS, density: 96 })
      .resize({ width: 64, height: 64, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let buckets = bucketColors(data, info.width, info.height, info.channels, true);
    // A hairline logo has almost no flat interior: count everything instead.
    const interior = [...buckets.values()].reduce((n, b) => n + b.count, 0);
    if (interior < 6) {
      buckets = bucketColors(data, info.width, info.height, info.channels, false);
    }

    // Fold buckets close to a heavier one into it; the colour reported for a
    // group is its HEAVIEST bucket's own mean, so it does not drift.
    const merged: { count: number; r: number; g: number; b: number }[] = [];
    for (const bucket of [...buckets.values()].sort((a, b) => b.count - a.count)) {
      const mean = { r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count };
      const target = merged.find(
        (m) =>
          Math.sqrt((m.r - mean.r) ** 2 + (m.g - mean.g) ** 2 + (m.b - mean.b) ** 2) <= MERGE_DISTANCE,
      );
      if (target) target.count += bucket.count;
      else merged.push({ count: bucket.count, ...mean });
    }
    return merged
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((m) => rgbToHex({ r: m.r, g: m.g, b: m.b }));
  } catch {
    return [];
  }
}

export type LogoTone = "light" | "dark";

export type LogoAnalysis = {
  // "light": the mark itself is light-coloured (legible on dark backgrounds,
  // the app's `logoAssetId` slot). "dark": dark / mid-tone mark, legible on
  // light backgrounds (the `darkLogoAssetId` slot).
  tone: LogoTone;
  // true when the image has no transparency — a logo baked onto a solid
  // background will show that background as a box when composited on a post.
  hasSolidBackground: boolean;
};

// Foreground luminance at or above this counts as a "light" logo. Deliberately
// high: a mid-tone brand colour (a teal, a red) is still a logo to place on
// LIGHT backgrounds.
const LIGHT_LOGO_LUMINANCE = 170;
const FOREGROUND_DISTANCE = 42;

function lum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Decides which logo slot an image belongs in. Transparent logos are judged
// by their opaque pixels; a logo on a solid background is judged by the pixels
// that differ from that background (estimated from the four corners), so a
// dark wordmark on white is "dark", not "light" because most pixels are white.
export async function analyzeLogo(png: Buffer): Promise<LogoAnalysis> {
  try {
    const { data, info } = await sharp(png, { limitInputPixels: LIMIT_INPUT_PIXELS })
      .resize({ width: 96, height: 96, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const at = (x: number, y: number) => (y * width + x) * channels;

    let transparent = 0;
    for (let i = 0; i < data.length; i += channels) {
      if (data[i + 3]! < 128) transparent += 1;
    }
    const total = width * height;
    const hasSolidBackground = transparent / total < 0.02;

    let bg: { r: number; g: number; b: number } | null = null;
    if (hasSolidBackground) {
      const corners = [
        at(0, 0),
        at(width - 1, 0),
        at(0, height - 1),
        at(width - 1, height - 1),
      ];
      bg = {
        r: corners.reduce((n, i) => n + data[i]!, 0) / 4,
        g: corners.reduce((n, i) => n + data[i + 1]!, 0) / 4,
        b: corners.reduce((n, i) => n + data[i + 2]!, 0) / 4,
      };
    }

    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const alpha = data[i + 3]!;
      if (bg) {
        const d = Math.sqrt((r - bg.r) ** 2 + (g - bg.g) ** 2 + (b - bg.b) ** 2);
        if (d < FOREGROUND_DISTANCE) continue;
      } else if (alpha < 128) {
        continue;
      }
      sum += lum(r, g, b);
      count += 1;
    }

    // Nothing stands out from the background (a blank / flat image): fall
    // back to the background's own tone.
    const mean = count > 0 ? sum / count : bg ? lum(bg.r, bg.g, bg.b) : 0;
    return {
      tone: mean >= LIGHT_LOGO_LUMINANCE ? "light" : "dark",
      hasSolidBackground,
    };
  } catch {
    return { tone: "dark", hasSolidBackground: false };
  }
}
