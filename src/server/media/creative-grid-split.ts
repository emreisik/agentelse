import "server-only";

import sharp from "sharp";

import { putAsset } from "@/server/storage/asset-storage";

// Instagram Grid Studio's split step (spec: izgara) — takes one source
// image and cuts it into a 3x1 or 3x3 "grid puzzle" set: N separate tile
// images that, posted in the right order (see creative-grid-actions.ts's
// reverse-order scheduling), reassemble into the original when viewed on
// an Instagram profile grid. The only precedent for cropping a sub-region
// in this codebase is creative-template.ts's single `.extract()` call
// (lines ~202-209 there) — but that one is sampling-only (feeds
// `.stats()` to pick a light/dark logo variant, the cropped buffer is
// never saved). This is the first place that actually persists crops as
// real output images.

export type GridLayout = "3x1" | "3x3";

const LAYOUT_GRID: Record<GridLayout, { cols: number; rows: number }> = {
  "3x1": { cols: 3, rows: 1 },
  "3x3": { cols: 3, rows: 3 },
};

export type GridTile = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  // 1..N, reading order (left-to-right, top-to-bottom) in the ASSEMBLED
  // image — not a publish-order field (see the schema comment on
  // Creative.gridPosition for why those are deliberately different).
  position: number;
};

// tileSize is one tile's target pixel size (e.g. Instagram FEED_SQUARE's
// 1080x1080 — the caller resolves this via getCreativePlatformFormat, this
// module doesn't know about platforms). The source is cover-fit to the
// FULL assembled canvas first (cols*width x rows*height) using the same
// attention-based crop as creative-image.ts's normalizeToTarget, so the
// subject isn't naively center-cropped before being sliced — then each
// tile is extracted from that canvas. Always outputs PNG (same "always
// normalize format" choice openai-image-client.ts makes), regardless of
// the source's original format.
export async function splitImageIntoGridTiles(
  sourceBuffer: Buffer,
  layout: GridLayout,
  tileSize: { width: number; height: number },
): Promise<GridTile[]> {
  const { cols, rows } = LAYOUT_GRID[layout];
  const canvasWidth = tileSize.width * cols;
  const canvasHeight = tileSize.height * rows;

  const canvas = await sharp(sourceBuffer)
    .resize(canvasWidth, canvasHeight, {
      fit: "cover",
      position: sharp.strategy.attention,
    })
    .png()
    .toBuffer();

  const tiles: GridTile[] = [];
  let position = 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileBuffer = await sharp(canvas)
        .extract({
          left: col * tileSize.width,
          top: row * tileSize.height,
          width: tileSize.width,
          height: tileSize.height,
        })
        .png()
        .toBuffer();
      const { storageKey, filename } = await putAsset(
        tileBuffer,
        "png",
        "image/png",
      );
      tiles.push({
        storageKey,
        filename,
        mimeType: "image/png",
        size: tileBuffer.byteLength,
        width: tileSize.width,
        height: tileSize.height,
        position,
      });
      position += 1;
    }
  }
  return tiles;
}
