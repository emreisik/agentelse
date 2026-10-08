import "server-only";

import { Prisma } from "@prisma/client";

import { orientationOf } from "@/lib/brand-media";
import { prisma } from "@/lib/prisma";
import { normalizeBrandPhoto } from "@/server/brand/media/normalize";
import { putAsset } from "@/server/storage/asset-storage";

export type MediaScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type AddPhotoResult =
  | { ok: true; mediaId: string; assetId: string; duplicate: boolean }
  | { ok: false; reason: string };

// Puts one photo in the brand's library: normalised, stored once (the same
// picture added again returns the one already there), and queued for analysis.
export async function addBrandPhoto(input: {
  scope: MediaScope;
  bytes: Buffer;
  filename: string;
}): Promise<AddPhotoResult> {
  const { scope } = input;
  const normalized = await normalizeBrandPhoto(input.bytes);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  const { image } = normalized;

  const existing = await prisma.asset.findFirst({
    where: { projectId: scope.projectId, hash: image.hash, type: "IMAGE" },
    select: { id: true },
  });
  if (existing) {
    const media = await ensureMediaRow(scope, existing.id, {
      width: image.width,
      height: image.height,
    });
    // A photo that was archived and is added again is wanted again.
    await prisma.brandMedia.update({
      where: { id: media.id },
      data: { archivedAt: null },
    });
    return { ok: true, mediaId: media.id, assetId: existing.id, duplicate: true };
  }

  const stored = await putAsset(image.buffer, image.ext, image.mimeType);
  const asset = await prisma.asset.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      type: "IMAGE",
      source: "CUSTOMER_UPLOAD",
      filename: stored.filename,
      mimeType: image.mimeType,
      storageKey: stored.storageKey,
      size: image.buffer.byteLength,
      hash: image.hash,
      width: image.width,
      height: image.height,
    },
  });
  const media = await ensureMediaRow(scope, asset.id, {
    width: image.width,
    height: image.height,
  });
  return { ok: true, mediaId: media.id, assetId: asset.id, duplicate: false };
}

// The library row of an asset, created waiting for its analysis.
export async function ensureMediaRow(
  scope: MediaScope,
  assetId: string,
  size: { width?: number | null; height?: number | null },
): Promise<{ id: string }> {
  const orientation = orientationOf(size.width, size.height);
  try {
    return await prisma.brandMedia.upsert({
      where: { assetId },
      create: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        assetId,
        kind: "IMAGE",
        status: "PENDING",
        orientation,
      },
      update: {},
      select: { id: true },
    });
  } catch (error) {
    // Two uploads of the same photo racing: the other one made the row.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const row = await prisma.brandMedia.findUnique({
        where: { assetId },
        select: { id: true },
      });
      if (row) return row;
    }
    throw error;
  }
}

// Existing library uploads that have no BrandMedia row yet (everything added
// before the media library existed): brought in, waiting for analysis. Post
// style examples and the like are left out: they are design references, not
// photos to make posts from. Cheap when there is nothing to do.
export async function adoptExistingPhotos(limit = 50): Promise<number> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      workspaceId: string;
      projectId: string;
      brandId: string;
      width: number | null;
      height: number | null;
    }[]
  >(Prisma.sql`
    SELECT a."id", a."workspaceId", a."projectId", a."brandId", a."width", a."height"
    FROM "Asset" a
    LEFT JOIN "BrandMedia" m ON m."assetId" = a."id"
    WHERE a."type" = 'IMAGE'
      AND a."source" = 'CUSTOMER_UPLOAD'
      AND m."id" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "BrandFact" f
        WHERE f."category" = 'post_style' AND f."key" = 'example:' || a."id"
      )
    ORDER BY a."createdAt" DESC
    LIMIT ${limit}
  `);
  for (const row of rows) {
    await ensureMediaRow(
      {
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        brandId: row.brandId,
      },
      row.id,
      { width: row.width, height: row.height },
    );
  }
  return rows.length;
}
