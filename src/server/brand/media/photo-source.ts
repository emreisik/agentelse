import "server-only";

import { prisma } from "@/lib/prisma";
import { readAsset } from "@/server/storage/asset-storage";

// A brand photo as the picture of a post (photo mode, docs/brand-media.md):
// read it, always scoped to the project the post belongs to, so an id from
// another project (a stale idea, a model's guess) can never be used.

export type BrandPhoto = {
  assetId: string;
  bytes: Buffer;
  // Where the main subject sits, 0-1 from the left / top; null when unknown.
  focal: { x: number; y: number } | null;
  // What the photo shows, for the words written for it.
  description: string | null;
};

export async function loadBrandPhoto(
  assetId: string,
  projectId: string,
): Promise<BrandPhoto | null> {
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId, type: "IMAGE" },
    select: { id: true, storageKey: true },
  });
  if (!asset) return null;
  const media = await prisma.brandMedia
    .findUnique({
      where: { assetId },
      select: { focalX: true, focalY: true, description: true },
    })
    .catch(() => null);
  try {
    const bytes = await readAsset(asset.storageKey);
    return {
      assetId: asset.id,
      bytes,
      focal:
        media?.focalX != null && media?.focalY != null
          ? { x: media.focalX, y: media.focalY }
          : null,
      description: media?.description ?? null,
    };
  } catch {
    return null;
  }
}

// Best-effort: counting a use must never fail a post.
export async function recordPhotoUse(assetId: string): Promise<void> {
  await prisma.brandMedia
    .updateMany({
      where: { assetId },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    .catch((error) =>
      console.error("[photo-source] use not recorded:", error),
    );
}

// The ids that are still images of this project (a photo may have been deleted
// since an idea named it).
export async function liveBrandPhotoIds(
  projectId: string,
  ids: readonly string[] | undefined,
): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  const rows = await prisma.asset.findMany({
    where: { id: { in: [...ids] }, projectId, type: "IMAGE" },
    select: { id: true },
  });
  const alive = new Set(rows.map((row) => row.id));
  return ids.filter((id) => alive.has(id));
}
