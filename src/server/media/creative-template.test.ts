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

// The accent bar overlay is intentionally semi-transparent (fill-opacity
// 0.85 — see creative-template.ts) so it reads as a soft overlay, not a hard
// block. Over a near-black (10,10,10) base, a pure-channel overlay blends to
// roughly 0.85*255+0.15*10 ≈ 218, not 255 — this tolerance is sized for that
// blend, not just JPEG/PNG rounding noise.
function isChannelDominant(actual: number, tolerance = 60): boolean {
  return Math.abs(actual - 0xff) <= tolerance;
}

describe("applyBrandTemplate", () => {
  let baseBuffer: Buffer;
  let logoBuffer: Buffer;
  let darkLogoBuffer: Buffer;

  beforeEach(async () => {
    vi.resetAllMocks();
    baseBuffer = await solidPng(WIDTH, HEIGHT, [10, 10, 10]); // near-black base
    logoBuffer = await solidPng(60, 60, [0, 200, 0]); // green light-variant logo
    darkLogoBuffer = await solidPng(60, 60, [200, 0, 0]); // red dark-variant logo
    storageMocks.readAsset.mockImplementation(async (key: string) => {
      if (key === "logo-key") return logoBuffer;
      if (key === "dark-logo-key") return darkLogoBuffer;
      return baseBuffer;
    });
    storageMocks.overwriteAsset.mockResolvedValue(undefined);
    prismaMocks.assetFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "dark-logo-1"
          ? { storageKey: "dark-logo-key" }
          : { storageKey: "logo-key" },
    );
  });

  it("returns null and does not composite when the template is disabled", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      template: { enabled: false },
    });
    expect(result).toBeNull();
    expect(storageMocks.overwriteAsset).not.toHaveBeenCalled();
  });

  it("returns null when there is no logo and the accent bar is off (nothing to draw)", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: null,
      template: { accentBarEnabled: false },
    });
    expect(result).toBeNull();
    expect(storageMocks.overwriteAsset).not.toHaveBeenCalled();
  });

  it("draws an accent bar even with no logo (relaxed from the old logo-required behavior)", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: null,
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
      lightLogoAssetId: null,
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
      lightLogoAssetId: null,
      legacyApprovedColors: [{ hex: "#0000ff", name: "Ocean" }],
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    const [r, g, b] = await pixelAt(outputBuffer, WIDTH / 2, HEIGHT - 5);
    expect(isChannelDominant(b)).toBe(true);
    expect(r).toBeLessThan(30);
    expect(g).toBeLessThan(30);
  });

  it("places the logo at the corner LogoPosition names, e.g. TOP_LEFT", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      template: { logoPosition: "TOP_LEFT", accentBarEnabled: false },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    // Logo starts right at the ~4%-of-width margin (16px for a 400px
    // canvas), no badge padding inset anymore; (40,40) lands inside the
    // logo itself (green) — proves something was composited there.
    const topLeft = await pixelAt(outputBuffer, 40, 40);
    const bottomRight = await pixelAt(outputBuffer, WIDTH - 15, HEIGHT - 15);
    expect(topLeft).not.toEqual([10, 10, 10]);
    expect(bottomRight).toEqual([10, 10, 10]); // untouched near-black base
  });

  it("does not draw a white badge behind the logo anymore", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      template: { logoPosition: "BOTTOM_RIGHT", accentBarEnabled: false },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    // The old implementation drew a ~88%-opaque white badge extending well
    // past the logo's own footprint (BOTTOM_RIGHT, 400px canvas: logo spans
    // x/y [320,384), the old badge spanned [296,384)). This point sits
    // inside where that badge used to extend to but outside the logo
    // itself — it must be the untouched near-black base now, not a
    // white/cream blend.
    const outsideLogoNearCorner = await pixelAt(outputBuffer, 305, 350);
    expect(outsideLogoNearCorner).toEqual([10, 10, 10]);
  });

  it("auto-selects the light logo variant over a dark background region when both variants are set", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      darkLogoAssetId: "dark-logo-1",
      template: { logoPosition: "BOTTOM_RIGHT", accentBarEnabled: false },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    const [r, g] = await pixelAt(outputBuffer, WIDTH - 40, HEIGHT - 40);
    // Green (light variant) chosen over the near-black base region.
    expect(isChannelDominant(g)).toBe(true);
    expect(r).toBeLessThan(60);
  });

  it("auto-selects the dark logo variant over a light background region when both variants are set", async () => {
    const lightBase = await solidPng(WIDTH, HEIGHT, [245, 245, 245]);
    storageMocks.readAsset.mockImplementation(async (key: string) => {
      if (key === "logo-key") return logoBuffer;
      if (key === "dark-logo-key") return darkLogoBuffer;
      return lightBase;
    });
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      darkLogoAssetId: "dark-logo-1",
      template: { logoPosition: "BOTTOM_RIGHT", accentBarEnabled: false },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    const [r, g] = await pixelAt(outputBuffer, WIDTH - 40, HEIGHT - 40);
    // Red (dark variant) chosen over the near-white base region.
    expect(isChannelDominant(r)).toBe(true);
    expect(g).toBeLessThan(60);
  });

  it("does not reserve extra offset for the accent bar when the logo is on the opposite edge (TOP_RIGHT logo, BOTTOM bar)", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      accentColors: [{ hex: "#ff00ff" }],
      template: { logoPosition: "TOP_RIGHT", accentBarPosition: "BOTTOM" },
    });
    expect(result).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    // The logo should sit right at the top margin (~4% of height = 16px for
    // a 400px canvas), not pushed down as if reserving room for the
    // (unrelated, bottom-edge) accent bar.
    const nearTopMargin = await pixelAt(outputBuffer, WIDTH - 40, 40);
    expect(nearTopMargin).not.toEqual([10, 10, 10]);
  });

  it("reserves space for the accent bar when the logo shares its edge (BOTTOM_RIGHT logo, BOTTOM bar)", async () => {
    const withBar = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      accentColors: [{ hex: "#ff00ff" }],
      template: { logoPosition: "BOTTOM_RIGHT", accentBarPosition: "BOTTOM" },
    });
    expect(withBar).not.toBeNull();
    const [, outputBuffer] = storageMocks.overwriteAsset.mock.calls[0]!;
    // Directly above the very bottom edge, away from the logo's
    // right-anchored horizontal span, should be the accent bar (magenta)
    // — confirms the bar itself renders full-width along the bottom edge.
    const justAboveBottomEdge = await pixelAt(outputBuffer, 10, HEIGHT - 5);
    expect(isChannelDominant(justAboveBottomEdge[0])).toBe(true);
    expect(isChannelDominant(justAboveBottomEdge[2])).toBe(true);
    // And the logo itself must have been pushed UP off the very bottom
    // edge (not overlapping the bar) — the bottom-right corner pixel,
    // which would be inside the logo if it weren't offset, should NOT be
    // the logo's green; it should be the accent bar's magenta instead.
    const bottomRightCorner = await pixelAt(
      outputBuffer,
      WIDTH - 5,
      HEIGHT - 5,
    );
    expect(isChannelDominant(bottomRightCorner[2])).toBe(true); // still magenta (bar), not logo green
  });

  it("centres the logo at the top for TOP_CENTER (layout templates)", async () => {
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      template: { logoPosition: "TOP_CENTER", accentBarEnabled: false },
    });
    expect(result).not.toBeNull();
    const [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
    // 400px canvas: margin 16, logo 64px wide -> spans x [168,232), y [16,80).
    const [r, g] = await pixelAt(out, 200, 40);
    expect(r).toBeLessThan(30);
    expect(g).toBeGreaterThan(150);
    expect(await pixelAt(out, 40, 40)).toEqual([10, 10, 10]);
    expect(await pixelAt(out, 360, 40)).toEqual([10, 10, 10]);
  });

  describe("brand band (logoOnBar)", () => {
    const band = {
      logoPosition: "BOTTOM_LEFT" as const,
      accentBarEnabled: true,
      accentBarPosition: "BOTTOM" as const,
      accentBarHeightPercent: 20, // 80px on a 400px canvas
      accentBarOpacity: 1,
      logoOnBar: true,
    };

    it("draws a solid band and seats the logo inside it, scaled to fit", async () => {
      await applyBrandTemplate({
        storageKey: "base-key",
        mimeType: "image/png",
        lightLogoAssetId: "logo-1",
        template: { ...band, accentBarColorHex: "#0b1f3a" },
      });
      const [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
      // Opaque band: exactly the brand colour, not a blend with the image.
      expect(await pixelAt(out, 300, 390)).toEqual([11, 31, 58]);
      // Band spans y [320,400). The 64px logo is scaled to 54px to fit, so it
      // sits at y [333,387), x [16,70): green inside...
      const [r, g] = await pixelAt(out, 43, 360);
      expect(r).toBeLessThan(30);
      expect(g).toBeGreaterThan(150);
      // ...and band colour just above and below it, base image above the band.
      expect(await pixelAt(out, 43, 325)).toEqual([11, 31, 58]);
      expect(await pixelAt(out, 43, 393)).toEqual([11, 31, 58]);
      expect(await pixelAt(out, 43, 300)).toEqual([10, 10, 10]);
    });

    it("picks the logo variant by the BAND colour, not the image behind it", async () => {
      // Dark band -> light (green) logo; the near-black image is irrelevant.
      await applyBrandTemplate({
        storageKey: "base-key",
        mimeType: "image/png",
        lightLogoAssetId: "logo-1",
        darkLogoAssetId: "dark-logo-1",
        template: { ...band, accentBarColorHex: "#0b1f3a" },
      });
      let [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
      let [r, g] = await pixelAt(out, 43, 360);
      expect(g).toBeGreaterThan(150);
      expect(r).toBeLessThan(60);

      // Light band over the SAME dark image -> dark (red) logo.
      storageMocks.overwriteAsset.mockClear();
      await applyBrandTemplate({
        storageKey: "base-key",
        mimeType: "image/png",
        lightLogoAssetId: "logo-1",
        darkLogoAssetId: "dark-logo-1",
        template: { ...band, accentBarColorHex: "#ffffff" },
      });
      [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
      [r, g] = await pixelAt(out, 43, 360);
      expect(r).toBeGreaterThan(150);
      expect(g).toBeLessThan(60);
    });

    it("falls back to a corner logo when the bar is too thin to hold it", async () => {
      await applyBrandTemplate({
        storageKey: "base-key",
        mimeType: "image/png",
        lightLogoAssetId: "logo-1",
        template: { ...band, accentBarHeightPercent: 5, accentBarColorHex: "#ff00ff" },
      });
      const [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
      // 5% = 20px bar (below the 8% needed): the logo stays ABOVE the bar as
      // an ordinary corner logo, y [300,364).
      const [r, g] = await pixelAt(out, 48, 330);
      expect(g).toBeGreaterThan(150);
      expect(r).toBeLessThan(30);
      expect(isChannelDominant((await pixelAt(out, 200, 395))[0])).toBe(true);
    });
  });

  it("a bar at full opacity is the exact colour; the default stays translucent", async () => {
    await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: null,
      template: { accentBarColorHex: "#ff0000", accentBarOpacity: 1 },
    });
    let [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
    expect(await pixelAt(out, 200, 395)).toEqual([255, 0, 0]);

    storageMocks.overwriteAsset.mockClear();
    await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: null,
      template: { accentBarColorHex: "#ff0000" },
    });
    [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
    const [r] = await pixelAt(out, 200, 395);
    expect(r).toBeLessThan(250); // 0.85 fill over near-black is not pure red
  });

  it("keeps corner logos out of the platform UI bands (safeZone, percent of height)", async () => {
    // Bottom: 20% of 400px = 80px reserved, so a BOTTOM_RIGHT logo moves up.
    await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      template: { logoPosition: "BOTTOM_RIGHT", accentBarEnabled: false },
      safeZone: { bottom: 20 },
    });
    let [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
    // Logo y [240,304) instead of [320,384).
    expect((await pixelAt(out, 368, 270))[1]).toBeGreaterThan(150);
    expect(await pixelAt(out, 368, 370)).toEqual([10, 10, 10]);

    // Top: 15% = 60px reserved, so a TOP_LEFT logo moves down: y [76,140).
    storageMocks.overwriteAsset.mockClear();
    await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      template: { logoPosition: "TOP_LEFT", accentBarEnabled: false },
      safeZone: { top: 15 },
    });
    [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
    expect(await pixelAt(out, 40, 40)).toEqual([10, 10, 10]);
    expect((await pixelAt(out, 40, 100))[1]).toBeGreaterThan(150);
  });

  describe("trimLogo (layouts)", () => {
    // 100x100 logo whose 50x50 green mark has 25px of transparent padding.
    async function useVisiblyPaddedLogo() {
      const mark = await solidPng(50, 50, [0, 200, 0]);
      logoBuffer = await sharp({
        create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([{ input: mark, left: 25, top: 25 }])
        .png()
        .toBuffer();
    }
    const cornerLogo = {
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "logo-1",
      // 400px canvas: margin 16px, logo box 80px -> box [304, 384) both ways.
      template: {
        logoPosition: "BOTTOM_RIGHT" as const,
        logoSizePercent: 20,
        logoMarginPercent: 4,
        accentBarEnabled: false,
      },
    };

    it("places a padded logo as stored by default, padding and all", async () => {
      await useVisiblyPaddedLogo();
      await applyBrandTemplate(cornerLogo);
      const [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
      // The 80px box holds a 40px mark inset by 20px: its corner is empty.
      expect(await pixelAt(out, 380, 380)).toEqual([10, 10, 10]);
      expect((await pixelAt(out, 344, 344))[1]).toBeGreaterThan(150);
    });

    it("crops the padding first, so the mark itself sits on the margin at the set size", async () => {
      await useVisiblyPaddedLogo();
      await applyBrandTemplate({ ...cornerLogo, trimLogo: true });
      const [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
      // The whole 80px box is now mark, flush with the 16px margin.
      expect((await pixelAt(out, 380, 380))[1]).toBeGreaterThan(150);
      expect((await pixelAt(out, 306, 306))[1]).toBeGreaterThan(150);
      expect(await pixelAt(out, 300, 300)).toEqual([10, 10, 10]);
      expect(await pixelAt(out, 388, 388)).toEqual([10, 10, 10]);
    });

    it("leaves a logo without padding exactly as it was", async () => {
      await applyBrandTemplate({ ...cornerLogo, trimLogo: true });
      const [, out] = storageMocks.overwriteAsset.mock.calls[0]!;
      expect((await pixelAt(out, 380, 380))[1]).toBeGreaterThan(150);
      expect((await pixelAt(out, 306, 306))[1]).toBeGreaterThan(150);
    });
  });

  it("returns null and does not throw when the referenced logo asset no longer exists", async () => {
    prismaMocks.assetFindUnique.mockResolvedValue(null);
    const result = await applyBrandTemplate({
      storageKey: "base-key",
      mimeType: "image/png",
      lightLogoAssetId: "missing-logo",
      template: { accentBarEnabled: false },
    });
    expect(result).toBeNull();
    expect(storageMocks.overwriteAsset).not.toHaveBeenCalled();
  });
});
