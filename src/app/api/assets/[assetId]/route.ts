import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import {
  readAsset,
  readStoredThumbnail,
  writeStoredThumbnail,
} from "@/server/storage/asset-storage";
import {
  assetThumbnail,
  canResize,
  parseAssetWidth,
} from "@/server/storage/asset-thumbnail";

const CACHE_CONTROL = "private, max-age=31536000, immutable";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { projectId: true, mimeType: true, storageKey: true },
  });
  if (!asset) {
    console.error(`[api/assets] no Asset row for id ${assetId}`);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await requireProjectAccess(userId, asset.projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      console.error(
        `[api/assets] requireProjectAccess denied for asset ${assetId} ` +
          `(project ${asset.projectId}, user ${userId})`,
        error,
      );
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  // ?w= asks for a resized preview (src/lib/asset-url.ts). A width outside
  // the allowed set, or a file that is not a still image, gets the original.
  const width = parseAssetWidth(new URL(request.url).searchParams.get("w"));
  if (width && canResize(asset.mimeType)) {
    try {
      const preview = await assetThumbnail(
        assetId,
        width,
        () => readAsset(asset.storageKey),
        {
          read: () => readStoredThumbnail(asset.storageKey, width),
          write: (made) => writeStoredThumbnail(asset.storageKey, width, made),
        },
      );
      return new NextResponse(new Uint8Array(preview), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": CACHE_CONTROL,
        },
      });
    } catch (error) {
      // A file sharp cannot read is still served as it is, below.
      console.error(`[api/assets] preview failed for asset ${assetId}`, error);
    }
  }

  try {
    const file = await readAsset(asset.storageKey);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": asset.mimeType,
        "Cache-Control": CACHE_CONTROL,
      },
    });
  } catch (error) {
    // Distinguishes the two ways this can fail: a `local-asset://` key means
    // the file only ever existed on whatever machine wrote it (see
    // asset-storage.ts's putAsset R2 guard) — this process can never serve
    // it, no matter how many times it's retried. An `r2://` key failing here
    // means R2 itself errored (bad creds, network, object genuinely deleted).
    console.error(
      `[api/assets] readAsset failed for asset ${assetId} ` +
        `(storageKey: ${asset.storageKey})`,
      error,
    );
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
