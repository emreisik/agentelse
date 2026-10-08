import "server-only";

import sharp from "sharp";

import type { HeadlineZone } from "@/lib/layout-templates";
import {
  fitMode,
  keptShare,
  planCoverCrop,
  type Size,
} from "@/lib/photo-crop";

// A brand's real photo as the picture of a post: upright, cropped (or shown
// whole over a blurred copy of itself) to the canvas of the format, and nothing
// else. The logo, the words and the rest of the design are added afterwards by
// the same compositing every post goes through. The source bytes are only read.

export type PhotoFit = {
  buffer: Buffer;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  fit: "cover" | "extend";
  // The share of the photo's area the post shows (1 = all of it).
  kept: number;
};

const JPEG_QUALITY = 92;
const BACKDROP_BLUR = 28;
// How much of the photo's short side fades into the backdrop at an open edge.
const FEATHER = 0.22;

export async function fitPhotoToCanvas(input: {
  source: Buffer;
  canvas: Size;
  focal?: { x: number; y: number } | null;
  avoidZone?: HeadlineZone | null;
}): Promise<PhotoFit> {
  const { canvas } = input;
  // Upright first: every measurement below is on the photo as a person sees it.
  const upright = await sharp(input.source, { failOn: "none" })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const photo: Size = { width: upright.info.width, height: upright.info.height };
  const mode = fitMode(photo, canvas);

  if (mode === "cover") {
    const crop = planCoverCrop({
      photo,
      canvas,
      focal: input.focal,
      avoidZone: input.avoidZone,
    });
    // A photo whose subject is known is cropped around it; without that, the
    // image library picks the most eye-catching part.
    const pipeline = input.focal
      ? sharp(upright.data)
          .extract(crop)
          .resize(canvas.width, canvas.height, { fit: "fill" })
      : sharp(upright.data).resize(canvas.width, canvas.height, {
          fit: "cover",
          position: sharp.strategy.attention,
        });
    return {
      buffer: await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer(),
      mimeType: "image/jpeg",
      width: canvas.width,
      height: canvas.height,
      fit: "cover",
      kept: keptShare(photo, canvas),
    };
  }

  // The whole photo, as large as the canvas allows, over a soft blurred copy of
  // itself that fills the rest.
  const backdrop = await sharp(upright.data)
    .resize(canvas.width, canvas.height, { fit: "cover" })
    .blur(BACKDROP_BLUR)
    .modulate({ brightness: 0.94 })
    .toBuffer();
  const foreground = await sharp(upright.data)
    .resize(canvas.width, canvas.height, { fit: "inside" })
    .toBuffer({ resolveWithObject: true });
  const { width: fw, height: fh } = foreground.info;
  // The photo's edges fade into the backdrop on the sides that have slack, so
  // there is no hard seam where the sharp part ends.
  const feather = Math.round(Math.min(fw, fh) * FEATHER);
  const fadeX = canvas.width - fw > 2;
  const fadeY = canvas.height - fh > 2;
  // One mask per axis (librsvg has no blend modes): each fades the two ends of
  // its axis to nothing over `feather` pixels.
  const fadeMask = (vertical: boolean) => {
    const edge = feather / (vertical ? fh : fw);
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">
          <stop offset="0" stop-color="#000"/><stop offset="${edge}" stop-color="#fff"/>
          <stop offset="${1 - edge}" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
        </linearGradient></defs>
        <rect width="${fw}" height="${fh}" fill="url(#g)"/>
      </svg>`,
    );
  };
  let faded = sharp(foreground.data).ensureAlpha();
  for (const [needed, vertical] of [
    [fadeY, true],
    [fadeX, false],
  ] as const) {
    if (!needed) continue;
    faded = sharp(
      await faded
        .composite([{ input: fadeMask(vertical), blend: "dest-in" }])
        .png()
        .toBuffer(),
    );
  }
  const fadedBuffer = await faded.png().toBuffer();
  const buffer = await sharp(backdrop)
    .composite([
      {
        input: fadedBuffer,
        left: Math.round((canvas.width - fw) / 2),
        top: Math.round((canvas.height - fh) / 2),
      },
    ])
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return {
    buffer,
    mimeType: "image/jpeg",
    width: canvas.width,
    height: canvas.height,
    fit: "extend",
    kept: 1,
  };
}
