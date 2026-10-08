import "server-only";

import sharp from "sharp";

import { prisma } from "@/lib/prisma";
import { parseColorSwatches } from "@/lib/color-swatches";
import type { TextPlacement } from "@/lib/layout-templates";
import { readAsset, overwriteAsset } from "@/server/storage/asset-storage";
import { fitLogoBox } from "@/lib/logo-fit";
import {
  cleanLogo,
  isMonochromeLogo,
  logoForegroundLuminance,
  tintLogo,
} from "@/server/media/logo-clean";
import {
  renderTextLayer,
  type OnImageText,
  type Rect,
} from "@/server/media/creative-text";

export type LogoPositionValue =
  "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | "CENTER_BOTTOM";

export type AccentBarPositionValue = "TOP" | "BOTTOM";

export type TemplateConfig = {
  enabled: boolean;
  logoPosition: LogoPositionValue;
  logoSizePercent: number;
  logoMarginPercent: number;
  accentBarEnabled: boolean;
  accentBarColorHex: string | null;
  accentBarHeightPercent: number;
  accentBarPosition: AccentBarPositionValue;
  // Optional so the defaults below (and every stored template) keep meaning
  // exactly what they always did.
  // Fill opacity of the bar. The thin accent stripe is slightly translucent
  // (0.85, today's look); a brand band is solid (1).
  accentBarOpacity?: number;
  // Put the logo INSIDE the bar, centred on it — the "brand band" layout.
  logoOnBar?: boolean;
  // "shape": the size is a presence level, turned into a box that fits the
  // logo's own proportions (src/lib/logo-fit.ts), and the logo is checked to
  // read against the picture. Absent: the size is a plain percent of the
  // width, as it always was.
  logoFit?: "shape";
};

// What applyBrandTemplate() accepts. The layout templates
// (src/lib/layout-templates.ts) can also centre the logo at the top, which
// the legacy Prisma enum behind LogoPositionValue cannot express — so the
// stored/legacy TemplateConfig keeps its five positions and only this
// call-time shape widens them.
export type AppliedTemplateConfig = Omit<TemplateConfig, "logoPosition"> & {
  logoPosition: LogoPositionValue | "TOP_CENTER";
};

// The post's on-image words and how the layout sets them (creative-text.ts).
export type TemplateText = OnImageText & {
  placement: TextPlacement;
  // The brand kit's font (a Google Fonts family); Inter when absent/unknown.
  fontFamily?: string | null;
  // The brand's dark colour for words on a light picture, and its accent for
  // highlighted words.
  darkInk?: string | null;
  accentHex?: string | null;
  // Percent of the height the platform's own UI covers (Story / Reel). Kept
  // apart from `safeZone` below, which only a saved layout's logo uses.
  safeZone?: { top?: number; bottom?: number };
};

// Matches BrandVisualIdentity's schema.prisma defaults exactly — a brand
// that never opens the Visual Identity settings gets byte-for-byte the
// same output this module always produced (bottom-right badge, bottom
// accent stripe, same proportions).
export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  enabled: true,
  logoPosition: "BOTTOM_RIGHT",
  logoSizePercent: 16,
  logoMarginPercent: 4,
  accentBarEnabled: true,
  accentBarColorHex: null,
  accentBarHeightPercent: 5,
  accentBarPosition: "BOTTOM",
};

// There's no write flow for legacy approved colors (BrandDossier.
// approvedColors is still free-form Json) — this defensively extracts the
// first valid hex code from the array, or a single hex string. Returns
// null when none is found.
function extractAccentColorHex(approvedColors: unknown): string | null {
  const HEX = /^#[0-9a-fA-F]{3,8}$/;
  if (typeof approvedColors === "string" && HEX.test(approvedColors)) {
    return approvedColors;
  }
  const swatch = parseColorSwatches(approvedColors)[0];
  return swatch?.hex ?? null;
}

// Instead of leaving it to the AI's free interpretation, this overlays the
// brand's ACTUAL logo (pixel-accurate, undistorted) and an accent color bar
// onto the generated creative image, in the position/size the brand's
// Visual Identity settings specify (see BrandVisualIdentity, brand-style-
// context.ts) — the SAME layout on every single generation regardless of
// which provider (OpenAI/OpenClaw) produced the base image. The post's words,
// when it has any, are typeset here too (creative-text.ts). This is
// the one place in the pipeline that GUARANTEES visual consistency; prompt
// text alone can only nudge a stochastic model, never guarantee it.
//
// Best-effort: if there's nothing to draw, or compositing fails for any
// reason, the file is left as-is — creative generation must never fail
// because of visual templating.
// Luminance threshold (0-255, ITU-R BT.709 weights) below which a sampled
// region counts as "dark" -> the light logo variant is legible there.
const DARK_REGION_LUMINANCE_THRESHOLD = 128;

// Contrast (1-21, WCAG-style) a logo needs against what is behind it before it
// is repainted or given a plate: lower on a photo (its brightness varies under
// the logo) than on a flat brand band.
const READABLE_ON_PICTURE = 2.4;
const READABLE_ON_BAND = 3;

function logoContrast(a: number, b: number): number {
  const light = (value: number) => Math.pow(Math.max(0, value) / 255, 2.2);
  const [hi, lo] = [light(a), light(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const DEFAULT_BAR_OPACITY = 0.85;
// A logo goes inside the bar only when the bar is at least this tall
// (fraction of the image height)...
const ON_BAR_MIN_HEIGHT_RATIO = 0.08;
// ...and is then scaled down to at most this fraction of the bar's height.
const ON_BAR_LOGO_FILL = 0.68;

// Same weights and 0-255 scale as the region sampling below, for a solid
// colour (the band the logo will sit on).
function hexLuminance(hex: string): number {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}/.test(h)) return 255;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The compositing itself, on pictures in memory: used by applyBrandTemplate
// (which reads and writes the stored files) and by the design previews, which
// must show exactly what a post gets and so run the very same code.
export async function composeBrandTemplate(input: {
  base: Buffer;
  // Light-colored logo (legible on dark backgrounds) and dark-colored logo
  // (legible on light backgrounds) — when both are set, the region behind
  // the logo's placement is sampled for brightness and the matching variant
  // is picked automatically, no artificial backdrop needed. When only one
  // is set, that one is always used (today's single-logo behavior).
  lightLogo?: Buffer | null;
  darkLogo?: Buffer | null;
  // Structured accent colors (role-labeled) from BrandVisualIdentity —
  // used when template.accentBarColorHex isn't explicitly set. Legacy
  // approvedColors (BrandDossier, untyped Json) is the final fallback for
  // brands that haven't configured Visual Identity yet.
  accentColors?: { hex: string; name?: string }[];
  legacyApprovedColors?: unknown;
  template?: Partial<AppliedTemplateConfig>;
  // Percent of the image height the platform's own UI covers at the top /
  // bottom (Story / Reel controls). A corner logo is kept out of those bands;
  // the bar stays on the edge.
  safeZone?: { top?: number; bottom?: number };
  // Crop the empty padding off the logo before placing it, so its size and
  // margin apply to the mark itself. Set together with a saved post layout;
  // without it logos are placed as stored (the behaviour before layouts).
  trimLogo?: boolean;
  // The post's words, typeset in the layout's headline zone, clear of the
  // logo, the bar and the platform's UI. Absent = a picture without words.
  text?: TemplateText;
}): Promise<{ buffer: Buffer; textDrawn?: boolean } | null> {
  const cfg: AppliedTemplateConfig = {
    ...DEFAULT_TEMPLATE_CONFIG,
    ...input.template,
  };
  // The words are the post's content, not its branding: they are set even
  // where the brand switched its logo / bar compositing off.
  const text = input.text?.headline.trim() ? input.text : undefined;
  if (!cfg.enabled && !text) return null;
  const branded = cfg.enabled;

  const accentHex =
    branded && cfg.accentBarEnabled
      ? (cfg.accentBarColorHex ??
        input.accentColors?.[0]?.hex ??
        extractAccentColorHex(input.legacyApprovedColors))
      : null;

  // Relaxed from the original "no logo -> bail out entirely": a brand with
  // no logo yet can still get a consistent accent-bar treatment. Only skip
  // when there's truly nothing to draw.
  const lightBuffer = branded ? (input.lightLogo ?? null) : null;
  const darkBuffer = branded ? (input.darkLogo ?? null) : null;
  const hasLogo = Boolean(lightBuffer || darkBuffer);
  if (!hasLogo && !accentHex && !text) return null;

  const lightLogoStorageKey = lightBuffer ? "light" : null;
  const darkLogoStorageKey = darkBuffer ? "dark" : null;

  const readLogo = async (which: string) => {
    const buffer = which === "light" ? lightBuffer! : darkBuffer!;
    // Cleaned: a plain light backdrop removed, the empty border trimmed.
    return input.trimLogo ? cleanLogo(buffer) : buffer;
  };

  const baseBuffer = input.base;
  const baseMeta = await sharp(baseBuffer).metadata();
  const width = baseMeta.width ?? 1024;
  const height = baseMeta.height ?? 1024;

  const barHeight = accentHex
    ? Math.round(height * (cfg.accentBarHeightPercent / 100))
    : 0;
  const barOnTop = Boolean(accentHex) && cfg.accentBarPosition === "TOP";
  const barOnBottom = Boolean(accentHex) && cfg.accentBarPosition === "BOTTOM";

  const composites: { input: Buffer; left: number; top: number }[] = [];
  // Where the logo landed (null on the band, or no logo): the words keep clear.
  let logoRect: Rect | null = null;

  if (accentHex && barHeight > 0) {
    const barSvg = `<svg width="${width}" height="${barHeight}"><rect width="${width}" height="${barHeight}" fill="${accentHex}" fill-opacity="${cfg.accentBarOpacity ?? DEFAULT_BAR_OPACITY}"/></svg>`;
    composites.push({
      input: Buffer.from(barSvg),
      left: 0,
      top: cfg.accentBarPosition === "TOP" ? 0 : height - barHeight,
    });
  }

  if (lightLogoStorageKey || darkLogoStorageKey) {
    // Geometry (size/position) is computed from whichever variant exists —
    // when both are set they're expected to be the same mark just
    // recolored, so either's aspect ratio is equivalent for sizing.
    const referenceStorageKey = lightLogoStorageKey ?? darkLogoStorageKey!;
    const referenceBuffer = await readLogo(referenceStorageKey);
    const margin = Math.round(width * (cfg.logoMarginPercent / 100));

    // The logo sits INSIDE the bar only when there is a real bar tall enough
    // to hold it; a hairline stripe falls back to the corner.
    const onBar =
      Boolean(cfg.logoOnBar) &&
      Boolean(accentHex) &&
      barHeight >= Math.round(height * ON_BAR_MIN_HEIGHT_RATIO);

    let logoWidth = Math.round(width * (cfg.logoSizePercent / 100));
    if (cfg.logoFit === "shape") {
      const referenceMeta = await sharp(referenceBuffer).metadata();
      if (referenceMeta.width && referenceMeta.height) {
        logoWidth = fitLogoBox({
          aspect: referenceMeta.width / referenceMeta.height,
          canvas: { width, height },
          sizePercent: cfg.logoSizePercent,
        }).width;
      }
    }
    let referenceResized = await sharp(referenceBuffer)
      .resize({ width: logoWidth, withoutEnlargement: false })
      .toBuffer();
    let logoHeight =
      (await sharp(referenceResized).metadata()).height ?? logoWidth;

    if (onBar) {
      // A wide logo would overflow a slim band: scale it down to fit.
      const maxLogoHeight = Math.max(
        1,
        Math.round(barHeight * ON_BAR_LOGO_FILL),
      );
      if (logoHeight > maxLogoHeight) {
        logoWidth = Math.max(
          1,
          Math.round((logoWidth * maxLogoHeight) / logoHeight),
        );
        referenceResized = await sharp(referenceBuffer)
          .resize({ width: logoWidth, withoutEnlargement: false })
          .toBuffer();
        logoHeight =
          (await sharp(referenceResized).metadata()).height ?? maxLogoHeight;
      }
    }

    const safeTop = Math.round(height * ((input.safeZone?.top ?? 0) / 100));
    const safeBottom = Math.round(
      height * ((input.safeZone?.bottom ?? 0) / 100),
    );

    // Reserve space for the accent bar only when the logo shares its edge
    // (top-anchored logo + top bar, or bottom-anchored logo + bottom bar) —
    // a logo on the opposite edge from the bar never needs the offset.
    // Corner logos also stay clear of the platform's UI bands (safeZone).
    let left: number;
    let top: number;
    if (onBar) {
      const barTop = cfg.accentBarPosition === "TOP" ? 0 : height - barHeight;
      top = barTop + Math.round((barHeight - logoHeight) / 2);
      switch (cfg.logoPosition) {
        case "TOP_LEFT":
        case "BOTTOM_LEFT":
          left = margin;
          break;
        case "TOP_RIGHT":
        case "BOTTOM_RIGHT":
          left = width - margin - logoWidth;
          break;
        default:
          left = Math.round((width - logoWidth) / 2);
          break;
      }
    } else {
      switch (cfg.logoPosition) {
        case "TOP_LEFT":
          left = margin;
          top = margin + (barOnTop ? barHeight : 0) + safeTop;
          break;
        case "TOP_CENTER":
          left = Math.round((width - logoWidth) / 2);
          top = margin + (barOnTop ? barHeight : 0) + safeTop;
          break;
        case "TOP_RIGHT":
          left = width - margin - logoWidth;
          top = margin + (barOnTop ? barHeight : 0) + safeTop;
          break;
        case "BOTTOM_LEFT":
          left = margin;
          top =
            height -
            margin -
            logoHeight -
            (barOnBottom ? barHeight : 0) -
            safeBottom;
          break;
        case "CENTER_BOTTOM":
          left = Math.round((width - logoWidth) / 2);
          top =
            height -
            margin -
            logoHeight -
            (barOnBottom ? barHeight : 0) -
            safeBottom;
          break;
        case "BOTTOM_RIGHT":
        default:
          left = width - margin - logoWidth;
          top =
            height -
            margin -
            logoHeight -
            (barOnBottom ? barHeight : 0) -
            safeBottom;
          break;
      }
    }

    // Pick the variant that reads clearly at this exact spot by sampling
    // the destination region's brightness — light logo for a dark region,
    // dark logo for a light region. On a solid band the band's own colour
    // decides instead. Only one variant present -> always use it (today's
    // behavior). No backdrop/badge is drawn behind the logo anymore; this
    // sampling IS the contrast strategy that replaces it.
    let regionLuminance: number | null = null;
    const sampleRegionLuminance = async (): Promise<number> => {
      if (regionLuminance !== null) return regionLuminance;
      {
        const sampleLeft = Math.max(0, Math.min(left, width - 1));
        const sampleTop = Math.max(0, Math.min(top, height - 1));
        const sampleWidth = Math.max(
          1,
          Math.min(logoWidth, width - sampleLeft),
        );
        const sampleHeight = Math.max(
          1,
          Math.min(logoHeight, height - sampleTop),
        );
        // stats() measures the whole input, not the pipeline's extract: cut
        // the region out first.
        const region = await sharp(baseBuffer)
          .extract({
            left: sampleLeft,
            top: sampleTop,
            width: sampleWidth,
            height: sampleHeight,
          })
          .toBuffer();
        const stats = await sharp(region).stats();
        const [r, g, b] = stats.channels;
        regionLuminance =
          0.2126 * (r?.mean ?? 255) +
          0.7152 * (g?.mean ?? 255) +
          0.0722 * (b?.mean ?? 255);
        return regionLuminance;
      }
    };

    let chosenStorageKey = referenceStorageKey;
    if (lightLogoStorageKey && darkLogoStorageKey) {
      const luminance = onBar
        ? hexLuminance(accentHex!)
        : await sampleRegionLuminance();
      chosenStorageKey =
        luminance < DARK_REGION_LUMINANCE_THRESHOLD
          ? lightLogoStorageKey
          : darkLogoStorageKey;
    }

    const resizedLogo =
      chosenStorageKey === referenceStorageKey
        ? referenceResized
        : await sharp(await readLogo(chosenStorageKey))
            .resize({ width: logoWidth, withoutEnlargement: false })
            .toBuffer();

    // A logo that cannot be told apart from what is behind it (one variant
    // only, a picture that is neither light nor dark enough, a band in the
    // logo's own colour) is made to read: a one-colour mark is repainted white
    // or black, any other gets a soft plate. The variant pick above is what
    // normally keeps it clear without either.
    let logoToDraw: Buffer = resizedLogo;
    if (cfg.logoFit === "shape") {
      const logoLuminance = await logoForegroundLuminance(resizedLogo);
      if (logoLuminance !== null) {
        const behind = onBar
          ? hexLuminance(accentHex!)
          : await sampleRegionLuminance();
        const needed = onBar ? READABLE_ON_BAND : READABLE_ON_PICTURE;
        if (logoContrast(logoLuminance, behind) < needed) {
          if (await isMonochromeLogo(resizedLogo)) {
            logoToDraw = await tintLogo(
              resizedLogo,
              behind < 128 ? "#ffffff" : "#111111",
            );
          } else {
            const pad = Math.round(logoHeight * 0.35);
            const plateLeft = Math.max(0, left - pad);
            const plateTop = Math.max(0, top - pad);
            const plateWidth = Math.min(width - plateLeft, logoWidth + 2 * pad);
            const plateHeight = Math.min(height - plateTop, logoHeight + 2 * pad);
            const fill = logoLuminance < 128 ? "#ffffff" : "#111111";
            composites.push({
              input: Buffer.from(
                `<svg width="${plateWidth}" height="${plateHeight}"><rect width="${plateWidth}" height="${plateHeight}" rx="${pad}" fill="${fill}" fill-opacity="0.86"/></svg>`,
              ),
              left: plateLeft,
              top: plateTop,
            });
          }
        }
      }
    }

    composites.push({ input: logoToDraw, left, top });
    if (!onBar) logoRect = { left, top, width: logoWidth, height: logoHeight };
  }

  let textDrawn = false;
  if (text) {
    const textSafe = text.safeZone ?? input.safeZone;
    const layer = await renderTextLayer({
      base: baseBuffer,
      width,
      height,
      text,
      placement: text.placement,
      topInset:
        (barOnTop ? barHeight : 0) +
        Math.round(height * ((textSafe?.top ?? 0) / 100)),
      bottomInset:
        (barOnBottom ? barHeight : 0) +
        Math.round(height * ((textSafe?.bottom ?? 0) / 100)),
      logo: logoRect,
      fontFamily: text.fontFamily,
      darkInk: text.darkInk,
      accent: text.accentHex ?? input.accentColors?.[0]?.hex ?? accentHex,
    });
    if (layer) {
      // Under the bar and the logo, which stay crisp on top.
      composites.unshift({ input: layer, left: 0, top: 0 });
      textDrawn = true;
    }
  }

  if (composites.length === 0) return null;

  const outputBuffer = await sharp(baseBuffer).composite(composites).toBuffer();
  return { buffer: outputBuffer, ...(text ? { textDrawn } : {}) };
}

// Adds the brand's logo, bar and the post's words to a stored picture, in
// place. Everything about how it looks is composeBrandTemplate's.
export async function applyBrandTemplate(input: {
  storageKey: string;
  mimeType: string;
  lightLogoAssetId?: string | null;
  darkLogoAssetId?: string | null;
  accentColors?: { hex: string; name?: string }[];
  legacyApprovedColors?: unknown;
  template?: Partial<AppliedTemplateConfig>;
  safeZone?: { top?: number; bottom?: number };
  trimLogo?: boolean;
  text?: TemplateText;
}): Promise<{ size: number; textDrawn?: boolean } | null> {
  const enabled = { ...DEFAULT_TEMPLATE_CONFIG, ...input.template }.enabled;
  const words = input.text?.headline.trim() ? input.text : undefined;
  // Nothing to add: no template and no words (a read-free early exit).
  if (!enabled && !words) return null;

  const loadLogo = async (assetId: string | null | undefined) => {
    if (!enabled || !assetId) return null;
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { storageKey: true },
    });
    return asset?.storageKey ? readAsset(asset.storageKey) : null;
  };
  const [lightLogo, darkLogo] = await Promise.all([
    loadLogo(input.lightLogoAssetId),
    loadLogo(input.darkLogoAssetId),
  ]);

  const composed = await composeBrandTemplate({
    base: await readAsset(input.storageKey),
    lightLogo,
    darkLogo,
    accentColors: input.accentColors,
    legacyApprovedColors: input.legacyApprovedColors,
    template: input.template,
    safeZone: input.safeZone,
    trimLogo: input.trimLogo,
    text: input.text,
  });
  if (!composed) return null;

  await overwriteAsset(input.storageKey, composed.buffer, input.mimeType);
  return {
    size: composed.buffer.byteLength,
    ...(words ? { textDrawn: composed.textDrawn } : {}),
  };
}
