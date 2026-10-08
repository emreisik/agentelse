import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import { autoLayout, type Archetype } from "@/lib/auto-layout";
import { parseColorSwatches, parseFontNames } from "@/lib/color-swatches";
import {
  getCreativePlatformFormat,
  type CreativeContentFormat,
} from "@/lib/creative-platform-format";
import { layoutToTemplateConfig } from "@/lib/layout-templates";
import { createLimiter, Lru } from "@/lib/lru";
import { prisma } from "@/lib/prisma";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";
import { safeZonePercent } from "@/server/media/creative-layout";
import { composeBrandTemplate } from "@/server/media/creative-template";
import { readAsset } from "@/server/storage/asset-storage";

// What a post design looks like on a real picture, drawn by the very code that
// makes the posts (composeBrandTemplate): the brand's own logo, font and colours,
// the design's placement, the same sizing, contrast and safe-area rules. So the
// gallery shows what a post gets, not an approximation of it.

export const PREVIEW_FORMATS = {
  feed: "FEED_PORTRAIT",
  square: "FEED_SQUARE",
  landscape: "FEED_LANDSCAPE",
  story: "STORY",
} as const satisfies Record<string, CreativeContentFormat>;
export type PreviewFormat = keyof typeof PREVIEW_FORMATS;
export const PREVIEW_FORMAT_KEYS = Object.keys(
  PREVIEW_FORMATS,
) as PreviewFormat[];

const PREVIEW_WIDTH = 640;

// Words a sample post carries, in the brand's language (the first two letters
// of Project.language); English otherwise.
const SAMPLE_WORDS: Record<
  string,
  { headline: string; highlight: string; line: string; cta: string }
> = {
  tr: {
    headline: "Yeni sezonun en iyileri burada",
    highlight: "en iyileri",
    line: "Bu hafta sonuna özel seçkiler",
    cta: "Hemen keşfet",
  },
  mk: {
    headline: "Најдоброто од новата сезона е тука",
    highlight: "Најдоброто",
    line: "Избрано специјално за овој викенд",
    cta: "Откриј сега",
  },
  en: {
    headline: "The best of the new season is here",
    highlight: "best",
    line: "Picked just for this weekend",
    cta: "Explore now",
  },
};

export function sampleWordsFor(language: string | null | undefined) {
  const key = (language ?? "en").slice(0, 2).toLowerCase();
  return SAMPLE_WORDS[key] ?? SAMPLE_WORDS.en!;
}

// --- the picture under the design --------------------------------------------------

export const SAMPLE_SCENES = ["sample-1", "sample-2", "sample-3"] as const;

// Built-in scenes for a brand with no photo of its own: soft, photographic
// lighting and a subject, so the headline and logo are judged on a believable
// picture rather than a flat colour.
function sceneSvg(index: number, width: number, height: number): string {
  const palettes = [
    {
      sky: "#f4e4d0",
      glow: "#fff6ea",
      ground: "#b9835a",
      subject: "#7a4a2a",
      accent: "#d9a15f",
    },
    {
      sky: "#16323a",
      glow: "#3f8590",
      ground: "#0b1d22",
      subject: "#c98b4a",
      accent: "#e8d3a8",
    },
    {
      sky: "#e7ecf2",
      glow: "#ffffff",
      ground: "#9aa7b8",
      subject: "#3b4a63",
      accent: "#c9d3e0",
    },
  ];
  const p = palettes[index % palettes.length]!;
  const short = Math.min(width, height);
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="g" cx="62%" cy="38%" r="75%"><stop offset="0" stop-color="${p.glow}"/><stop offset="1" stop-color="${p.sky}"/></radialGradient>
      <linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.ground}" stop-opacity="0"/><stop offset="1" stop-color="${p.ground}" stop-opacity="0.95"/></linearGradient>
      <filter id="b"><feGaussianBlur stdDeviation="${short * 0.012}"/></filter>
      <filter id="bb"><feGaussianBlur stdDeviation="${short * 0.04}"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.2}" cy="${height * 0.28}" r="${short * 0.16}" fill="${p.accent}" opacity="0.55" filter="url(#bb)"/>
    <circle cx="${width * 0.85}" cy="${height * 0.2}" r="${short * 0.1}" fill="${p.glow}" opacity="0.7" filter="url(#bb)"/>
    <rect y="${height * 0.62}" width="100%" height="${height * 0.38}" fill="url(#f)"/>
    <ellipse cx="${width * 0.62}" cy="${height * 0.78}" rx="${short * 0.3}" ry="${short * 0.05}" fill="#000" opacity="0.28" filter="url(#b)"/>
    <rect x="${width * 0.46}" y="${height * 0.52}" width="${short * 0.32}" height="${short * 0.28}" rx="${short * 0.04}" fill="${p.subject}" filter="url(#b)"/>
    <circle cx="${width * 0.62}" cy="${height * 0.5}" r="${short * 0.1}" fill="${p.accent}" filter="url(#b)"/>
  </svg>`;
}

// The brand's own clean pictures (uploads in its library), newest first. Not
// its finished posts: those already carry a logo.
export async function listPreviewPhotos(
  projectId: string,
): Promise<{ id: string }[]> {
  return prisma.asset.findMany({
    where: {
      projectId,
      type: "IMAGE",
      source: "CUSTOMER_UPLOAD",
      mimeType: { startsWith: "image/" },
    },
    orderBy: { createdAt: "desc" },
    take: 4,
    select: { id: true },
  });
}

// The same scene or photo is the backdrop of every card: drawn and scaled once.
const bases = new Lru<string, Promise<Buffer>>(16);

function basePicture(
  projectId: string,
  photo: string | null | undefined,
  size: { width: number; height: number },
): Promise<Buffer> {
  const key = `${projectId}:${photo ?? ""}:${size.width}x${size.height}`;
  let base = bases.get(key);
  if (!base) {
    base = drawBase(projectId, photo, size);
    bases.set(key, base);
    // A failure is not remembered.
    base.catch(() => bases.delete(key));
  }
  return base;
}

async function drawBase(
  projectId: string,
  photo: string | null | undefined,
  size: { width: number; height: number },
): Promise<Buffer> {
  const pick = photo ?? (await listPreviewPhotos(projectId))[0]?.id ?? "sample-1";
  const sample = (SAMPLE_SCENES as readonly string[]).indexOf(pick);
  if (sample >= 0) {
    return sharp(Buffer.from(sceneSvg(sample, size.width, size.height)))
      .png()
      .toBuffer();
  }
  const asset = await prisma.asset.findFirst({
    where: { id: pick, projectId, type: "IMAGE" },
    select: { storageKey: true },
  });
  if (!asset) return basePicture(projectId, "sample-1", size);
  return sharp(await readAsset(asset.storageKey))
    .resize({ width: size.width, height: size.height, fit: "cover" })
    .png()
    .toBuffer();
}

// --- the preview -----------------------------------------------------------------------

// What the brand looks like, read once for all the cards of a page: its
// colours, font, language and both logos. Remembered for a short while so the
// six cards (and a format switch) do not each read it again.
type LookContext = {
  style: Awaited<ReturnType<typeof resolveBrandStyleContext>>;
  fonts: string[];
  language: string;
  lightLogo: Buffer | null;
  darkLogo: Buffer | null;
};
const looks = new Lru<string, { at: number; look: Promise<LookContext> }>(16);
const LOOK_TTL_MS = 30_000;

function lookOf(projectId: string, brandId: string): Promise<LookContext> {
  const cached = looks.get(brandId);
  if (cached && Date.now() - cached.at < LOOK_TTL_MS) return cached.look;

  const look = (async (): Promise<LookContext> => {
    const [style, dossier, project] = await Promise.all([
      resolveBrandStyleContext(brandId),
      prisma.brandDossier.findUnique({
        where: { brandId },
        select: { approvedFonts: true, language: true },
      }),
      prisma.project.findUnique({
        where: { id: projectId },
        select: { language: true },
      }),
    ]);
    const readLogo = async (assetId: string | null) => {
      if (!assetId) return null;
      const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        select: { storageKey: true },
      });
      return asset?.storageKey ? readAsset(asset.storageKey) : null;
    };
    const [lightLogo, darkLogo] = await Promise.all([
      readLogo(style.logoAssetId),
      readLogo(style.darkLogoAssetId),
    ]);
    return {
      style,
      fonts: parseFontNames(dossier?.approvedFonts),
      language: project?.language ?? dossier?.language ?? "en",
      lightLogo,
      darkLogo,
    };
  })();
  looks.set(brandId, { at: Date.now(), look });
  look.catch(() => looks.delete(brandId));
  return look;
}

// A short fingerprint of everything a preview depends on. The gallery puts it
// in each picture's address, so a picture is fetched once per look and then
// served from the browser's own cache for good; change the logo, a colour, the
// font or the language and every address changes with it.
export function designLookKey(look: {
  logos: (string | null)[];
  primary: string | null;
  accent: string | null;
  legacyColors: string[];
  font: string | null;
  language: string;
  enabled: boolean;
}): string {
  return createHash("sha1")
    .update(JSON.stringify(look))
    .digest("hex")
    .slice(0, 12);
}

export async function previewLookKey(
  projectId: string,
  brandId: string,
): Promise<string> {
  const { style, fonts, language } = await lookOf(projectId, brandId);
  const identity = style.visualIdentity;
  return designLookKey({
    logos: [style.logoAssetId, style.darkLogoAssetId],
    primary: identity?.primaryColors[0]?.hex ?? null,
    accent: identity?.accentColors[0]?.hex ?? null,
    legacyColors: parseColorSwatches(style.legacyApprovedColors).map((c) => c.hex),
    font: fonts[0] ?? null,
    language,
    enabled: identity?.template.enabled ?? true,
  });
}

const rendered = new Lru<string, Buffer>(120);

// For tests: forget everything remembered.
export function resetDesignPreviewCaches(): void {
  looks.clear();
  bases.clear();
  rendered.clear();
}
// Rendering is CPU work on the one thread that also serves pages: a few at a
// time, the rest queued, so opening the gallery never freezes the app.
const limit = createLimiter(2);

export function renderDesignPreview(input: {
  projectId: string;
  brandId: string;
  design: Archetype;
  format: PreviewFormat;
  photo?: string | null;
}): Promise<Buffer> {
  return limit(() => render(input));
}

async function render(input: {
  projectId: string;
  brandId: string;
  design: Archetype;
  format: PreviewFormat;
  photo?: string | null;
}): Promise<Buffer> {
  const { projectId, brandId, design, format } = input;
  const platformFormat = getCreativePlatformFormat(
    "INSTAGRAM",
    PREVIEW_FORMATS[format],
  );
  const size = platformFormat.pixelSize;

  const { style, fonts, language, lightLogo, darkLogo } = await lookOf(
    projectId,
    brandId,
  );
  const identity = style.visualIdentity;

  const key = `${await previewLookKey(projectId, brandId)}:${design}:${format}:${input.photo ?? ""}`;
  const cached = rendered.get(key);
  if (cached) return cached;

  const layout = autoLayout({ archetype: design, pixelSize: size });
  const palette = {
    primary: identity?.primaryColors[0]?.hex ?? null,
    secondary: identity?.secondaryColors[0]?.hex ?? null,
    accent: identity?.accentColors[0]?.hex ?? null,
  };
  const safeZone = safeZonePercent(platformFormat.safeZone, size);
  const base = await basePicture(projectId, input.photo, size);

  const words = sampleWordsFor(language);
  const composed = await composeBrandTemplate({
    base,
    lightLogo,
    darkLogo,
    // A brand that switched the template off gets no logo on its posts either.
    template: {
      ...layoutToTemplateConfig(layout, palette),
      enabled: identity?.template.enabled ?? true,
    },
    safeZone,
    trimLogo: true,
    ...(layout.headline.enabled
      ? {
          text: {
            headline: words.headline,
            highlight: words.highlight,
            lines: [words.line],
            cta: words.cta,
            placement: {
              zone: layout.headline.zone,
              align: layout.headline.align,
              maxLines: layout.headline.maxLines,
              scale: layout.headline.scale,
            },
            fontFamily: fonts[0] ?? null,
            darkInk: identity?.primaryColors[0]?.hex ?? null,
            accentHex: identity?.accentColors[0]?.hex ?? null,
            safeZone,
          },
        }
      : {}),
  });

  const output = await sharp(composed?.buffer ?? base)
    .resize({ width: PREVIEW_WIDTH })
    .webp({ quality: 84 })
    .toBuffer();
  rendered.set(key, output);
  return output;
}
