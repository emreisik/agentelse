import sharp from "sharp";

// Logos are often exported with empty padding around the mark. A layout's
// "size" and "margin" are meant for the mark itself, so the padding is cropped
// off before placing it — otherwise a padded logo comes out smaller than set
// and sits further from the edge than the margin says.

// Alpha (0-255) at or below which a pixel counts as empty: keeps out the
// faint anti-aliasing / shadow haze that exporters leave far from the mark.
const EMPTY_ALPHA = 8;
// Detection runs on a copy no larger than this; the crop is mapped back to the
// original, so a huge upload is never decoded to raw at full size.
const ANALYSIS_EDGE = 512;
// Less than this much to remove in total along either axis (px, original
// size) is not worth a re-encode.
const MIN_TRIM_PX = 4;

export async function trimTransparentBorders(input: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(input).metadata();
    // Only rasters with an alpha channel carry transparent padding. SVG is
    // left alone: cropping would rasterize it at screen density.
    if (
      !meta.hasAlpha ||
      !meta.width ||
      !meta.height ||
      meta.format === "svg"
    ) {
      return input;
    }

    const { data, info } = await sharp(input)
      .resize({
        width: ANALYSIS_EDGE,
        height: ANALYSIS_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * info.channels + info.channels - 1]! > EMPTY_ALPHA) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // Nothing visible: no mark to anchor on, keep it as is.
    if (maxX < 0) return input;

    // Analysis-space box -> original pixels, rounded outwards so the mark is
    // never clipped.
    const scaleX = meta.width / info.width;
    const scaleY = meta.height / info.height;
    const left = Math.max(0, Math.floor(minX * scaleX));
    const top = Math.max(0, Math.floor(minY * scaleY));
    const right = Math.min(meta.width, Math.ceil((maxX + 1) * scaleX));
    const bottom = Math.min(meta.height, Math.ceil((maxY + 1) * scaleY));
    const width = right - left;
    const height = bottom - top;

    if (
      meta.width - width < MIN_TRIM_PX &&
      meta.height - height < MIN_TRIM_PX
    ) {
      return input;
    }
    return await sharp(input)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
  } catch {
    return input;
  }
}
