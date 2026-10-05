import "server-only";

import { prisma } from "@/lib/prisma";
import type { SafeZone } from "@/lib/creative-platform-format";
import { readAsset } from "@/server/storage/asset-storage";

// One post, one picture (docs/works.md "Shared picture"): the other formats of
// a post (its Facebook post, its Instagram Story...) are not new pictures. The
// post's picture goes to the image model as the picture to edit, with the
// instruction below: the same design, re-laid out for the new shape. The
// brand's logo and accent band are left out and stamped again afterwards
// (applyBrandTemplate), so they are crisp and never doubled.

// The post's picture as the image edit takes it.
export async function readPictureForAdapting(
  assetId: string,
): Promise<{ data: string; mimeType: string } | undefined> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { storageKey: true, mimeType: true },
  });
  if (!asset) return undefined;
  try {
    const bytes = await readAsset(asset.storageKey);
    return { data: bytes.toString("base64"), mimeType: asset.mimeType };
  } catch {
    return undefined;
  }
}

export function adaptPicturePrompt(input: {
  pixelSize: { width: number; height: number };
  aspectRatio: string;
  formatLabel: string;
  safeZone?: SafeZone;
  // The layout's own reserved areas (logo corner, band), as prompt text.
  reservedZones?: string;
}): string {
  const { width, height } = input.pixelSize;
  return [
    `Adapt this exact social media design to a ${width}x${height} px canvas (${input.aspectRatio}, ${input.formatLabel}).`,
    "It is the same post in another format, not a new design: keep the same people, product, objects, colours, lighting, style and mood.",
    "Keep every word of on-image text exactly as written, with the same spelling, language and letters.",
    "Only re-arrange, scale and extend the layout so that nothing is cut off and the design fits the new shape naturally; extend the background in the same style where space is added.",
    input.safeZone
      ? `Keep text and key elements out of the top ${input.safeZone.top ?? 0}px and the bottom ${input.safeZone.bottom ?? 0}px (the app's own interface covers them).`
      : undefined,
    "Leave out the brand logo and any solid colour band along the edges: they are added back afterwards.",
    input.reservedZones,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
