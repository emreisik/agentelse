import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import type { SafeZone } from "@/lib/creative-platform-format";
import type { OnImageText } from "@/server/media/creative-text";
import { putAsset, readAsset } from "@/server/storage/asset-storage";

// One post, one picture (docs/works.md "Shared picture"): the other formats of
// a post (its Facebook post, its Instagram Story...) are not new pictures. The
// post's picture goes to the image model as the picture to edit, with the
// instruction below: the same design, re-laid out for the new shape. The
// brand's logo and accent band are left out and stamped again afterwards
// (applyBrandTemplate), so they are crisp and never doubled.
//
// A post whose words we typeset (creative-text.ts) keeps its picture as it was
// BEFORE the words, logo and band went on (keepCleanPicture). Its other formats
// are laid out from that clean picture and get the same words set again in
// their own layout, so the words are never redrawn (or misspelled) by the model.

export type PictureToAdapt = {
  data: string;
  mimeType: string;
  // The post's words, to set again on the new format. Only with the clean
  // picture: a picture that already carries its words keeps them as they are.
  text?: OnImageText;
  // Set when the post's picture is one of the brand's own photos (photo mode):
  // its other formats are cut from that same photo again, not redrawn.
  photoSource?: PhotoSource;
};

// A brand photo used as the picture of a post, as the render recorded it
// (generationMetadata.photoSource).
export type PhotoSource = { assetId: string; fit: "cover" | "extend" };

// What the post's own render recorded (openai-creative.provider.ts, stored on
// its CreativeVersion.generationMetadata).
const OnImageTextSchema = z.object({
  headline: z.string().min(1),
  highlight: z.string().optional(),
  lines: z.array(z.string()).max(6).optional(),
  cta: z.string().optional(),
});

const CleanSourceSchema = z.object({
  cleanPicture: z.object({
    storageKey: z.string().min(1),
    mimeType: z.string().min(1),
  }),
  onImageText: OnImageTextSchema,
});

const PhotoSourceSchema = z.object({
  assetId: z.string().min(1),
  fit: z.enum(["cover", "extend"]),
});

export function photoSourceOf(metadata: unknown): PhotoSource | undefined {
  const parsed = z
    .object({ photoSource: PhotoSourceSchema })
    .safeParse(metadata);
  return parsed.success ? parsed.data.photoSource : undefined;
}

// The words a version's picture carries, as its render recorded them
// (generationMetadata.onImageText); undefined when it has none.
export function onImageTextOf(metadata: unknown): OnImageText | undefined {
  const parsed = z
    .object({ onImageText: OnImageTextSchema })
    .safeParse(metadata);
  return parsed.success ? parsed.data.onImageText : undefined;
}

async function metadataOf(assetId: string): Promise<unknown> {
  const version = await prisma.creativeVersion.findFirst({
    where: { assetId },
    orderBy: { createdAt: "desc" },
    select: { generationMetadata: true },
  });
  return version?.generationMetadata ?? null;
}

// The post's picture as the image edit takes it.
export async function readPictureForAdapting(
  assetId: string,
): Promise<PictureToAdapt | undefined> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { storageKey: true, mimeType: true },
  });
  if (!asset) return undefined;

  const metadata = await metadataOf(assetId).catch(() => null);
  const photoSource = photoSourceOf(metadata);
  const clean = CleanSourceSchema.safeParse(metadata);
  if (clean.success) {
    try {
      const bytes = await readAsset(clean.data.cleanPicture.storageKey);
      return {
        data: bytes.toString("base64"),
        mimeType: clean.data.cleanPicture.mimeType,
        text: clean.data.onImageText,
        ...(photoSource ? { photoSource } : {}),
      };
    } catch {
      // The clean copy is gone: adapt the finished picture, words and all.
    }
  }

  try {
    const bytes = await readAsset(asset.storageKey);
    return {
      data: bytes.toString("base64"),
      mimeType: asset.mimeType,
      ...(photoSource ? { photoSource } : {}),
    };
  } catch {
    return undefined;
  }
}

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// A copy of a freshly rendered picture before anything is set on it, for the
// post's other formats. Best-effort: without it they adapt the finished
// picture, as before.
export async function keepCleanPicture(rendered: {
  storageKey: string;
  mimeType: string;
}): Promise<{ storageKey: string; mimeType: string } | undefined> {
  try {
    const bytes = await readAsset(rendered.storageKey);
    const { storageKey } = await putAsset(
      bytes,
      EXTENSION[rendered.mimeType] ?? "png",
      rendered.mimeType,
    );
    return { storageKey, mimeType: rendered.mimeType };
  } catch (error) {
    console.error("[adapt-picture] clean copy not kept:", error);
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
  // Set when the picture carries no words and they are typeset again
  // afterwards: where they go ("in the upper third of the frame").
  textArea?: string;
}): string {
  const { width, height } = input.pixelSize;
  return [
    `Adapt this exact social media design to a ${width}x${height} px canvas (${input.aspectRatio}, ${input.formatLabel}).`,
    "It is the same post in another format, not a new design: keep the same people, product, objects, colours, lighting, style and mood.",
    input.textArea
      ? `The picture carries no text and must stay that way: add no words, letters or numbers. The post's headline is typeset afterwards ${input.textArea}: keep that area calm and uncluttered.`
      : "Keep every word of on-image text exactly as written, with the same spelling, language and letters.",
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
