import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { verifyAssetPublicToken } from "@/server/security/asset-public-link";

// The UNAUTHENTICATED counterpart of /api/assets/[assetId] — exists ONLY so
// external providers like Meta (Instagram publish, etc.) can download an
// asset. Instead of session/project access, it verifies a short-lived
// signed `token` query param locked to a single assetId (see
// asset-public-link.ts). No asset is served without a valid, unexpired
// token.
const LOCAL_ASSET_SCHEME = "local-asset://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");
const SAFE_FILENAME = /^[a-zA-Z0-9-]+\.(png|jpe?g|webp|pdf|txt|csv|md)$/;

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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!asset.storageKey.startsWith(LOCAL_ASSET_SCHEME)) {
    return NextResponse.json(
      { error: "Asset has no locally-servable file" },
      { status: 404 },
    );
  }

  const filename = asset.storageKey.slice(LOCAL_ASSET_SCHEME.length);
  if (!SAFE_FILENAME.test(filename)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const file = await readFile(path.join(LOCAL_ASSETS_DIR, filename));
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": asset.mimeType,
        "Cache-Control": "private, max-age=900, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
