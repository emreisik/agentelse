import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { verifyAssetPublicToken } from "@/server/security/asset-public-link";
import { readAsset } from "@/server/storage/asset-storage";

// The UNAUTHENTICATED counterpart of /api/assets/[assetId] — exists ONLY so
// external providers like Meta (Instagram publish, etc.) can download an
// asset. Instead of session/project access, it verifies a short-lived
// signed `token` query param locked to a single assetId (see
// asset-public-link.ts). No asset is served without a valid, unexpired
// token. R2-backed assets normally never reach this route at all —
// buildAssetPublicUrl hands out R2's own direct public URL instead — this
// stays as the fallback for local-asset:// (dev without R2 configured).

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  const token = new URL(request.url).searchParams.get("token");

  if (!token || !verifyAssetPublicToken(assetId, token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    console.error(`[api/public/assets] no Asset row for id ${assetId}`);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const file = await readAsset(asset.storageKey);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": asset.mimeType,
        "Cache-Control": "private, max-age=900, immutable",
      },
    });
  } catch (error) {
    // See the sibling authenticated route for what storageKey scheme tells
    // you about a failure here (local-asset:// vs r2://).
    console.error(
      `[api/public/assets] readAsset failed for asset ${assetId} ` +
        `(storageKey: ${asset.storageKey})`,
      error,
    );
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
