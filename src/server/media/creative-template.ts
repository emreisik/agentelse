import "server-only";

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { prisma } from "@/lib/prisma";

const LOCAL_ASSET_SCHEME = "local-asset://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

// There's no write flow for approved colors yet (BrandDossier.approvedColors
// is still free-form Json) — this defensively extracts the first valid hex
// code from the array, or a single hex string. Returns null when none is
// found: the template then uses a neutral (white) badge instead of a
// brand color, and no accent stripe is added.
function extractAccentColorHex(approvedColors: unknown): string | null {
  const HEX = /^#[0-9a-fA-F]{3,8}$/;
  if (typeof approvedColors === "string" && HEX.test(approvedColors)) {
    return approvedColors;
  }
  if (Array.isArray(approvedColors)) {
    for (const entry of approvedColors) {
      if (typeof entry === "string" && HEX.test(entry)) return entry;
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { hex?: unknown }).hex === "string" &&
        HEX.test((entry as { hex: string }).hex)
      ) {
        return (entry as { hex: string }).hex;
      }
    }
  }
  return null;
}

// Instead of leaving it to the AI's free interpretation, this overlays the
// brand's ACTUAL logo (pixel-accurate, undistorted) and, if available, the
// brand color onto the generated creative image in a FIXED template
// layout: the logo on a semi-transparent white badge in the bottom-right
// corner, with a full-width accent stripe below it (when a color is
// known). The same layout on every generation — a genuine "template"
// guarantee, so consistency doesn't depend on the model's interpretation
// in the moment.
//
// Best-effort: if there's no logo, or compositing fails for any reason,
// the file is left as-is — creative generation must never fail because of
// visual templating.
export async function applyBrandTemplate(input: {
  filename: string;
  logoAssetId?: string | null;
  approvedColors?: unknown;
}): Promise<{ size: number } | null> {
  if (!input.logoAssetId) return null;

  const logoAsset = await prisma.asset.findUnique({
    where: { id: input.logoAssetId },
    select: { storageKey: true },
  });
  if (!logoAsset?.storageKey.startsWith(LOCAL_ASSET_SCHEME)) return null;
  const logoFilename = logoAsset.storageKey.slice(LOCAL_ASSET_SCHEME.length);

  const [baseBuffer, logoBuffer] = await Promise.all([
    readFile(path.join(LOCAL_ASSETS_DIR, input.filename)),
    readFile(path.join(LOCAL_ASSETS_DIR, logoFilename)),
  ]);

  const baseMeta = await sharp(baseBuffer).metadata();
  const width = baseMeta.width ?? 1024;
  const height = baseMeta.height ?? 1024;

  const margin = Math.round(width * 0.04);
  const logoWidth = Math.round(width * 0.16);
  const resizedLogo = await sharp(logoBuffer)
    .resize({ width: logoWidth, withoutEnlargement: false })
    .toBuffer();
  const logoHeight = (await sharp(resizedLogo).metadata()).height ?? logoWidth;

  const badgePaddingX = Math.round(logoWidth * 0.18);
  const badgePaddingY = Math.round(logoHeight * 0.18);
  const badgeWidth = logoWidth + badgePaddingX * 2;
  const badgeHeight = logoHeight + badgePaddingY * 2;
  const badgeSvg = `<svg width="${badgeWidth}" height="${badgeHeight}"><rect width="${badgeWidth}" height="${badgeHeight}" rx="${Math.round(badgeHeight * 0.18)}" fill="white" fill-opacity="0.88"/></svg>`;

  const accentHex = extractAccentColorHex(input.approvedColors);
  const barHeight = accentHex ? Math.round(height * 0.05) : 0;
  const bottomMargin = margin + barHeight;

  const composites: { input: Buffer; left: number; top: number }[] = [
    {
      input: Buffer.from(badgeSvg),
      left: width - margin - badgeWidth,
      top: height - bottomMargin - badgeHeight,
    },
    {
      input: resizedLogo,
      left: width - margin - badgeWidth + badgePaddingX,
      top: height - bottomMargin - badgeHeight + badgePaddingY,
    },
  ];

  if (accentHex && barHeight > 0) {
    const barSvg = `<svg width="${width}" height="${barHeight}"><rect width="${width}" height="${barHeight}" fill="${accentHex}" fill-opacity="0.85"/></svg>`;
    composites.unshift({
      input: Buffer.from(barSvg),
      left: 0,
      top: height - barHeight,
    });
  }

  const outputBuffer = await sharp(baseBuffer).composite(composites).toBuffer();
  await writeFile(path.join(LOCAL_ASSETS_DIR, input.filename), outputBuffer);

  return { size: outputBuffer.byteLength };
}
