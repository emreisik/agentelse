import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const prismaMocks = vi.hoisted(() => ({
  assetFindUnique: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { asset: { findUnique: prismaMocks.assetFindUnique } },
}));

const storageMocks = vi.hoisted(() => ({
  readAsset: vi.fn(),
  overwriteAsset: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: storageMocks.readAsset,
  overwriteAsset: storageMocks.overwriteAsset,
}));

import { applyBrandTemplate } from "@/server/media/creative-template";

const WIDTH = 400;
const HEIGHT = 400;

async function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: rgb[0], g: rgb[1], b: rgb[2] },
    },
  })
    .png()
    .toBuffer();
}

// Samples the pixel at (x, y) in a PNG buffer as [r, g, b].
async function pixelAt(
  buffer: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const { data, info } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx]!, data[idx + 1]!, data[idx + 2]!];
}

// The composited overlays are intentionally semi-transparent (accent bar
// fill-opacity 0.85, badge 0.88 — see creative-template.ts) so they read as
// a soft overlay, not a hard block. Over a near-black (10,10,10) base, a
// pure-channel overlay blends to roughly 0.85*255+0.15*10 ≈ 218, not 255 —
// this tolerance is sized for that blend, not just JPEG/PNG rounding noise.
function isChannelDominant(actual: number, tolerance = 60): boolean {
  return Math.abs(actual - 0xff) <= tolerance;
}

describe("applyBrandTemplate", () => {
  let baseBuffer: Buffer;
  let logoBuffer: Buffer;

  beforeEach(async () => {
    vi.resetAllMocks();
    baseBuffer = await solidPng(WIDTH, HEIGHT, [10, 10, 10]); // near-black base
    logoBuffer = await solidPng(60, 60, [0, 200, 0]); // green logo
    storageMocks.readAsset.mockImplementation(async (key: string) =>
      key === "logo-key" ? logoBuffer : baseBuffer,
    );
    storageMocks.overwriteAsset.mockResolvedValue(undefined);
    prismaMocks.assetFindUnique.mockResolvedValue({ storageKey: "logo-key" });
  });

  it("returns null and does not composite when the template is disabled", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: "logo-1",
      template: { enabled: false },
    });
    expect(result).toBeNull();
    expect(storageMocks.overwriteAsset).not.toHaveBeenCalled();
  });

  it("returns null when there is no logo and the accent bar is off (nothing to draw)", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: null,
      template: { accentBarEnabled: false },
    });
    expect(result).toBeNull();
    expect(storageMocks.overwriteAsset).not.toHaveBeenCalled();
  });

  it("draws an accent bar even with no logo (relaxed from the old logo-required behavior)", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: null,
      accentColors: [{ hex: "#ff0000" }],
      template: { logoPosition: "BOTTOM_RIGHT" },
    });
    expect(result).not.toBeNull();
    expect(storageMocks.overwriteAsset).toHaveBeenCalledTimes(1);
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    const [r, g, b] = await pixelAt(outputBuffer, WIDTH / 2, HEIGHT - 5);
    expect(isChannelDominant(r)).toBe(true); // red accent bar at the bottom
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });

  it("resolves accent color with the right precedence: explicit hex > accentColors > legacy approvedColors", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: null,
      accentColors: [{ hex: "#00ff00" }],
      legacyApprovedColors: ["#0000ff"],
      template: { accentBarColorHex: "#ff0000" },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    const [r, g, b] = await pixelAt(outputBuffer, WIDTH / 2, HEIGHT - 5);
    expect(isChannelDominant(r)).toBe(true);
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });

  it("falls back to legacy approvedColors when no structured accent color is set", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: null,
      legacyApprovedColors: [{ hex: "#0000ff", name: "Ocean" }],
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    const [r, g, b] = await pixelAt(outputBuffer, WIDTH / 2, HEIGHT - 5);
    expect(isChannelDominant(b)).toBe(true);
    expect(r).toBeLessThan(30);
    expect(g).toBeLessThan(30);
  });

  it("places the logo badge at the corner LogoPosition names, e.g. TOP_LEFT", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: "logo-1",
      template: { logoPosition: "TOP_LEFT", accentBarEnabled: false },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    // Badge+logo start at the ~4%-of-width margin (16px for a 400px
    // canvas); (40,40) lands inside the logo itself (green), not its white
    // badge margin — either way, "not the untouched near-black base"
    // proves something was composited there.
    const topLeft = await pixelAt(outputBuffer, 40, 40);
    const bottomRight = await pixelAt(outputBuffer, WIDTH - 15, HEIGHT - 15);
    expect(topLeft).not.toEqual([10, 10, 10]);
    expect(bottomRight).toEqual([10, 10, 10]); // untouched near-black base
  });

  it("does not reserve extra offset for the accent bar when the logo is on the opposite edge (TOP_RIGHT logo, BOTTOM bar)", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: "logo-1",
      accentColors: [{ hex: "#ff00ff" }],
      template: { logoPosition: "TOP_RIGHT", accentBarPosition: "BOTTOM" },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    // The badge+logo should sit right at the top margin (~4% of height =
    // 16px for a 400px canvas), not pushed down as if reserving room for
    // the (unrelated, bottom-edge) accent bar.
    const nearTopMargin = await pixelAt(outputBuffer, WIDTH - 40, 40);
    expect(nearTopMargin).not.toEqual([10, 10, 10]);
  });

  it("reserves space for the accent bar when the logo shares its edge (BOTTOM_RIGHT logo, BOTTOM bar)", async () => {
    const withBar = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: "logo-1",
      accentColors: [{ hex: "#ff00ff" }],
      template: { logoPosition: "BOTTOM_RIGHT", accentBarPosition: "BOTTOM" },
    });
    expect(withBar).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    // Directly above the very bottom edge, away from the badge's
    // right-anchored horizontal span, should be the accent bar (magenta)
    // — confirms the bar itself renders full-width along the bottom edge.
    const justAboveBottomEdge = await pixelAt(outputBuffer, 10, HEIGHT - 5);
    expect(isChannelDominant(justAboveBottomEdge[0])).toBe(true);
    expect(isChannelDominant(justAboveBottomEdge[2])).toBe(true);
    // And the badge itself must have been pushed UP off the very bottom
    // edge (not overlapping the bar) — the bottom-right corner pixel,
    // which would be inside the badge if it weren't offset, should NOT be
    // badge-white; it should be the accent bar's magenta instead.
    const bottomRightCorner = await pixelAt(
      outputBuffer,
      WIDTH - 5,
      HEIGHT - 5,
    );
    expect(isChannelDominant(bottomRightCorner[2])).toBe(true); // still magenta (bar), not white badge
  });

  it("returns null and does not throw when the referenced logo asset no longer exists", async () => {
    prismaMocks.assetFindUnique.mockResolvedValue(null);
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      logoAssetId: "missing-logo",
      template: { accentBarEnabled: false },
    });
    expect(result).toBeNull();
    expect(storageMocks.overwriteAsset).not.toHaveBeenCalled();
  });
});
