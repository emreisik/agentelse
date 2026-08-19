import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { readAsset } from "@/server/storage/asset-storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await requireProjectAccess(userId, asset.projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  try {
    const file = await readAsset(asset.storageKey);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": asset.mimeType,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
