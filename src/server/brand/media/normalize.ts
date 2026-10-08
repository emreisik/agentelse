import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  MEDIA_ACCEPTED_TYPES,
  MEDIA_MAX_SIDE,
  MEDIA_MIN_SIDE,
} from "@/lib/brand-media";

// A brand photo as the library stores it: upright (EXIF applied), without its
// embedded metadata (GPS, device), no longer than MEDIA_MAX_SIDE on a side, and
// fingerprinted so the same photo is not added twice. The bytes are the
// library's own copy: posts never edit them in place.

const LIMIT_INPUT_PIXELS = 100_000_000;

export type NormalizedPhoto = {
  buffer: Buffer;
  mimeType: string;
  ext: string;
  width: number;
  height: number;
  hash: string;
};

export async function normalizeBrandPhoto(
  bytes: Buffer,
): Promise<
  { ok: true; image: NormalizedPhoto } | { ok: false; reason: string }
> {
  try {
    const source = sharp(bytes, {
      failOn: "none",
      limitInputPixels: LIMIT_INPUT_PIXELS,
    });
    const meta = await source.metadata();
    if (!meta.width || !meta.height || !meta.format) {
      return { ok: false, reason: "That file isn't a picture." };
    }
    // sharp names HEIC and AVIF alike "heif".
    const type = meta.format === "heif" ? "image/heif" : `image/${meta.format}`;
    if (!MEDIA_ACCEPTED_TYPES.has(type)) {
      return { ok: false, reason: "Use a JPG, PNG or WebP photo." };
    }

    const transparent = meta.hasAlpha === true;
    const pipeline = source.rotate().resize({
      width: MEDIA_MAX_SIDE,
      height: MEDIA_MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    });
    const { data, info } = await (
      transparent ? pipeline.png() : pipeline.jpeg({ quality: 90, mozjpeg: true })
    ).toBuffer({ resolveWithObject: true });

    if (Math.min(info.width, info.height) < MEDIA_MIN_SIDE) {
      return {
        ok: false,
        reason: `The photo is too small (at least ${MEDIA_MIN_SIDE}px on its short side).`,
      };
    }
    return {
      ok: true,
      image: {
        buffer: data,
        mimeType: transparent ? "image/png" : "image/jpeg",
        ext: transparent ? "png" : "jpg",
        width: info.width,
        height: info.height,
        hash: createHash("sha1").update(data).digest("hex"),
      },
    };
  } catch (error) {
    const heif =
      error instanceof Error && /heif|heic|bitstream|codec/i.test(error.message);
    return {
      ok: false,
      reason: heif
        ? "This iPhone photo format can't be read here yet. Export it as JPG and add it again."
        : "That file isn't a picture.",
    };
  }
}
