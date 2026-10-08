import { createHash } from "node:crypto";

import sharp from "sharp";

import { Lru } from "@/lib/lru";

import { trimTransparentBorders } from "@/server/media/logo-trim";

// Logos arrive as people export them: often a JPEG or a PNG on a solid white
// square. Placed on a photo that square shows as a box. This turns a logo on a
// plain light background into a transparent mark, trims its empty border and
// can say how bright the mark itself is, so the compositor can size it, place
// it and check it reads against the photo. Everything is best-effort: any
// doubt returns the logo untouched.

// Never decode more than this many pixels to raw RGBA.
const MAX_PIXELS = 6_000_000;
const WORK_EDGE = 2048;
// A corner pixel counts as "paper" at or above this brightness (0-255) and at
// or below this colour spread.
const PAPER_MIN_LUMINANCE = 236;
const PAPER_MAX_SPREAD = 18;
const INK_MAX_LUMINANCE = 24;
// All four corners must agree this closely (max channel difference).
const CORNERS_AGREE = 14;
// Pixels this close to the paper are fully removed, this far fully kept.
const KEEP_FROM = 64;
const REMOVE_UNTIL = 12;
// The mark must be a believable share of the picture.
const MIN_MARK_SHARE = 0.012;
const MAX_MARK_SHARE = 0.85;
// A logo whose alpha channel has this much transparency already has one.
const REAL_TRANSPARENCY = 0.02;

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The plain backdrops it may remove: paper (white) always; black only when the
// caller knows the logo was made on it (an AI-generated light logo), because an
// uploaded dark badge is usually meant to stay a badge.
export type BackdropTone = "light" | "dark";

export async function knockoutLightBackground(
  input: Buffer,
  tones: readonly BackdropTone[] = ["light"],
): Promise<Buffer> {
  try {
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height || meta.format === "svg") return input;

    let pipeline = sharp(input, { limitInputPixels: 40_000_000 });
    if (meta.width * meta.height > MAX_PIXELS) {
      pipeline = pipeline.resize({
        width: WORK_EDGE,
        height: WORK_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const { data, info } = await pipeline
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const total = width * height;

    let see = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 250) see += 1;
    }
    if (see / total > REAL_TRANSPARENCY) return input;

    // The paper colour: the average of a small patch in each corner.
    const patch = Math.max(
      1,
      Math.min(4, Math.floor(Math.min(width, height) / 20)),
    );
    const corners = [
      [0, 0],
      [width - patch, 0],
      [0, height - patch],
      [width - patch, height - patch],
    ].map(([x0, y0]) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0!; y < y0! + patch; y++) {
        for (let x = x0!; x < x0! + patch; x++) {
          const at = (y * width + x) * 4;
          r += data[at]!;
          g += data[at + 1]!;
          b += data[at + 2]!;
        }
      }
      const n = patch * patch;
      return { r: r / n, g: g / n, b: b / n };
    });
    const bg = {
      r: corners.reduce((sum, c) => sum + c.r, 0) / 4,
      g: corners.reduce((sum, c) => sum + c.g, 0) / 4,
      b: corners.reduce((sum, c) => sum + c.b, 0) / 4,
    };
    const spread = Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b);
    const agree = corners.every(
      (c) =>
        Math.max(
          Math.abs(c.r - bg.r),
          Math.abs(c.g - bg.g),
          Math.abs(c.b - bg.b),
        ) <= CORNERS_AGREE,
    );
    const paperLuminance = luminance(bg.r, bg.g, bg.b);
    const lightPaper =
      tones.includes("light") && paperLuminance >= PAPER_MIN_LUMINANCE;
    const darkPaper =
      tones.includes("dark") && paperLuminance <= INK_MAX_LUMINANCE;
    if (!agree || spread > PAPER_MAX_SPREAD || !(lightPaper || darkPaper)) {
      return input;
    }

    const out = Buffer.alloc(total * 4);
    let kept = 0;
    for (let i = 0; i < total; i++) {
      const at = i * 4;
      const r = data[at]!;
      const g = data[at + 1]!;
      const b = data[at + 2]!;
      const distance = Math.max(
        Math.abs(r - bg.r),
        Math.abs(g - bg.g),
        Math.abs(b - bg.b),
      );
      const alpha =
        distance <= REMOVE_UNTIL
          ? 0
          : distance >= KEEP_FROM
            ? 1
            : (distance - REMOVE_UNTIL) / (KEEP_FROM - REMOVE_UNTIL);
      if (alpha > 0.5) kept += 1;
      // The edge pixel is a blend of the mark and the paper: undo the blend so
      // the mark does not keep a white fringe.
      const restore = (value: number, paper: number) =>
        alpha >= 1
          ? value
          : Math.max(
              0,
              Math.min(
                255,
                Math.round(paper + (value - paper) / Math.max(alpha, 0.05)),
              ),
            );
      out[at] = restore(r, bg.r);
      out[at + 1] = restore(g, bg.g);
      out[at + 2] = restore(b, bg.b);
      out[at + 3] = Math.round(alpha * 255);
    }

    const share = kept / total;
    if (share < MIN_MARK_SHARE || share > MAX_MARK_SHARE) return input;

    return await sharp(out, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  } catch {
    return input;
  }
}

// Cleaning decodes the logo to raw pixels and walks them: worth doing once per
// logo, not once per post. Remembered by the logo's bytes, so a replaced logo is
// cleaned afresh and an unchanged one never is.
const cleaned = new Lru<string, Promise<Buffer>>(24);

// A logo ready to be placed: no plain light backdrop, no empty border.
export async function cleanLogo(input: Buffer): Promise<Buffer> {
  const key = createHash("sha1").update(input).digest("hex");
  let result = cleaned.get(key);
  if (!result) {
    result = trimTransparentBorders(await knockoutLightBackground(input));
    cleaned.set(key, result);
    // A failure is not remembered.
    result.catch(() => cleaned.delete(key));
  }
  return result;
}

// Mean brightness (0-255) of the mark itself, weighted by opacity: tells a
// dark logo from a light one whatever the empty space around it. Null when
// the picture has no visible mark.
export async function logoForegroundLuminance(
  input: Buffer,
): Promise<number | null> {
  try {
    const { data } = await sharp(input)
      .resize({ width: 96, height: 96, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let weight = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]! / 255;
      if (alpha < 0.1) continue;
      weight += alpha;
      sum += alpha * luminance(data[i]!, data[i + 1]!, data[i + 2]!);
    }
    return weight > 0 ? sum / weight : null;
  } catch {
    return null;
  }
}

// A mark drawn in one colour (a wordmark, a single-colour emblem) can be
// repainted white or black when it would vanish against the picture; a
// multi-colour logo cannot, and gets a plate behind it instead.
export async function isMonochromeLogo(input: Buffer): Promise<boolean> {
  try {
    const { data } = await sharp(input)
      .resize({ width: 96, height: 96, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let n = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! < 200) continue;
      n += 1;
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
    }
    if (n < 8) return false;
    const mean = { r: r / n, g: g / n, b: b / n };
    let deviation = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! < 200) continue;
      deviation +=
        Math.abs(data[i]! - mean.r) +
        Math.abs(data[i + 1]! - mean.g) +
        Math.abs(data[i + 2]! - mean.b);
    }
    // Mean absolute deviation per channel, over the opaque pixels.
    return deviation / (n * 3) < 28;
  } catch {
    return false;
  }
}

// The same mark in one flat colour, keeping its shape and edges.
export async function tintLogo(input: Buffer, hex: string): Promise<Buffer> {
  try {
    const value = hex.replace(/^#/, "");
    const [r, g, b] = [0, 2, 4].map((at) =>
      parseInt(value.slice(at, at + 2), 16),
    );
    const { data, info } = await sharp(input)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r!;
      data[i + 1] = g!;
      data[i + 2] = b!;
    }
    return await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
  } catch {
    return input;
  }
}

// A logo as it should be stored: decoded for real (never trusting the
// Content-Type), no larger than needed, the plain backdrop gone and the empty
// border trimmed, so the stored file IS the mark and its measured size is the
// mark's. Null when it is not a usable image.
export async function normalizeLogoUpload(
  input: Buffer,
  tones: readonly BackdropTone[] = ["light"],
): Promise<{ png: Buffer; width: number; height: number } | null> {
  try {
    const meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
    if (!meta.width || !meta.height) return null;
    if (meta.width < 24 || meta.height < 24) return null;
    if (meta.width > 8000 || meta.height > 8000) return null;

    const resized = await sharp(input, {
      limitInputPixels: 40_000_000,
      failOn: "error",
      density: 300,
    })
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const cleaned = await trimTransparentBorders(
      await knockoutLightBackground(resized, tones),
    );
    const cleanedMeta = await sharp(cleaned).metadata();
    const usable =
      cleanedMeta.width !== undefined &&
      cleanedMeta.height !== undefined &&
      cleanedMeta.width >= 12 &&
      cleanedMeta.height >= 12;
    const png = usable ? cleaned : resized;
    const finalMeta = await sharp(png).metadata();
    return { png, width: finalMeta.width!, height: finalMeta.height! };
  } catch {
    return null;
  }
}
