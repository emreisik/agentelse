import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";

const LOCAL_ASSET_SCHEME = "local-asset://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

// Converts the brand's actual logo to base64 to give it to the AI as a
// visual reference (see referenceImage in gemini-image-client.ts). The
// same resolution logic as applyBrandTemplate (creative-template.ts) —
// find the Asset, verify storageKey matches the local scheme, read the
// file. Best-effort: returns null if logoAssetId is missing, or if the
// asset/file can't be found/read — it never throws, so the caller never
// has to wrap it in try/catch.
export async function loadBrandLogoImage(
  logoAssetId: string | null | undefined,
): Promise<{ data: string; mimeType: string } | null> {
  if (!logoAssetId) return null;

  try {
    const logoAsset = await prisma.asset.findUnique({
      where: { id: logoAssetId },
      select: { storageKey: true, mimeType: true },
    });
    if (!logoAsset?.storageKey.startsWith(LOCAL_ASSET_SCHEME)) return null;

    const filename = logoAsset.storageKey.slice(LOCAL_ASSET_SCHEME.length);
    const bytes = await readFile(path.join(LOCAL_ASSETS_DIR, filename));
    return { data: bytes.toString("base64"), mimeType: logoAsset.mimeType };
  } catch {
    return null;
  }
}
