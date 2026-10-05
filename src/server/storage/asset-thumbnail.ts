import sharp from "sharp";

import { ALLOWED_ASSET_WIDTHS } from "@/lib/asset-url";

// Resized previews for /api/assets/<id>?w=. Only still raster images are
// resized (an SVG is already small and scales, a GIF may be animated); the
// result is WebP, never wider than the original. Each (asset, width) is made
// once per process and kept in a small LRU, since assets never change.

const RESIZABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);

export function parseAssetWidth(raw: string | null): number | null {
  if (!raw) return null;
  const width = Number(raw);
  return ALLOWED_ASSET_WIDTHS.includes(width) ? width : null;
}

export function canResize(mimeType: string): boolean {
  return RESIZABLE.has(mimeType);
}

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let cachedBytes = 0;

function remember(key: string, value: Buffer) {
  cache.set(key, value);
  cachedBytes += value.byteLength;
  for (const [oldKey, oldValue] of cache) {
    if (cachedBytes <= MAX_CACHE_BYTES) break;
    cache.delete(oldKey);
    cachedBytes -= oldValue.byteLength;
  }
}

// Previews being made right now. The same picture is often asked for by
// several cards at once (chat, Outputs, Calendar): they share one download of
// the original and one resize instead of each doing both.
const inFlight = new Map<string, Promise<Buffer>>();

export async function assetThumbnail(
  assetId: string,
  width: number,
  readOriginal: () => Promise<Buffer>,
): Promise<Buffer> {
  const key = `${assetId}:${width}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes to the end of the Map (the LRU order).
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const making = (async () => {
    const resized = await sharp(await readOriginal())
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    remember(key, resized);
    return resized;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, making);
  return making;
}

export function clearAssetThumbnailCache() {
  cache.clear();
  inFlight.clear();
  cachedBytes = 0;
}
