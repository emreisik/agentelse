import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const prismaMocks = vi.hoisted(() => ({ assetFindUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { asset: { findUnique: prismaMocks.assetFindUnique } },
}));
const storage = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  written: null as Buffer | null,
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: async (key: string) => storage.files.get(key)!,
  overwriteAsset: async (_key: string, buffer: Buffer) => {
    storage.written = buffer;
  },
}));

import { applyBrandTemplate } from "@/server/media/creative-template";

async function solid(w: number, h: number, color: string) {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .png()
    .toBuffer();
}
async function pixel(buffer: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at]!, data[at + 1]!, data[at + 2]!];
}
// Bounding box of pixels that differ from a flat background.
async function logoBox(buffer: Buffer, background: [number, number, number]) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let [minX, minY, maxX, maxY] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const at = (y * info.width + x) * info.channels;
      const differs =
        Math.abs(data[at]! - background[0]) > 30 ||
        Math.abs(data[at + 1]! - background[1]) > 30 ||
        Math.abs(data[at + 2]! - background[2]) > 30;
      if (differs) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

const BASE = { width: 1000, height: 1000 };
const template = {
  enabled: true as const,
  logoPosition: "TOP_LEFT" as const,
  logoSizePercent: 16,
  logoMarginPercent: 4,
  accentBarEnabled: false,
  accentBarColorHex: null,
};

describe("applyBrandTemplate with a shape-fitted logo", () => {
  beforeEach(() => {
    storage.files.clear();
    storage.written = null;
    prismaMocks.assetFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ storageKey: where.id }),
    );
  });

  async function run(logo: Buffer, cfg: Record<string, unknown>, base = "#808080") {
    storage.files.set("base", await solid(BASE.width, BASE.height, base));
    storage.files.set("logo", logo);
    await applyBrandTemplate({
      storageKey: "base",
      mimeType: "image/png",
      lightLogoAssetId: "logo",
      template: { ...template, ...cfg },
      trimLogo: true,
    });
    return storage.written!;
  }

  it("draws a wide wordmark wider and a square emblem narrower than a plain percent would", async () => {
    const wordmark = await run(await solid(400, 100, "#ff0000"), { logoFit: "shape" });
    const emblem = await run(await solid(200, 200, "#ff0000"), { logoFit: "shape" });
    const plain = await run(await solid(400, 100, "#ff0000"), {});
    const grey: [number, number, number] = [128, 128, 128];
    const w = await logoBox(wordmark, grey);
    const e = await logoBox(emblem, grey);
    const p = await logoBox(plain, grey);
    expect(p.width).toBe(160); // 16% of 1000: the old behaviour, unchanged
    expect(w.width).toBeGreaterThan(p.width);
    expect(e.width).toBeLessThan(p.width);
    // The emblem is still a square, not squashed.
    expect(Math.abs(e.width - e.height)).toBeLessThanOrEqual(2);
  });

  it("repaints a one-colour logo that would vanish on the picture", async () => {
    // Near-black mark on a near-black picture.
    const dark = await solid(300, 90, "#101010");
    const fitted = await run(dark, { logoFit: "shape" }, "#141414");
    const plain = await run(dark, {}, "#141414");
    const inside = [60, 60] as const;
    const [r] = await pixel(fitted, ...inside);
    expect(r).toBeGreaterThan(200); // repainted white
    const [r2] = await pixel(plain, ...inside);
    expect(r2).toBeLessThan(40); // as stored: invisible
  });

  it("leaves a logo that already reads alone", async () => {
    const red = await solid(300, 90, "#cc0000");
    const out = await run(red, { logoFit: "shape" }, "#f2f2f2");
    const [r, g] = await pixel(out, 60, 60);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(60);
  });
});
