import "server-only";

import { prisma } from "@/lib/prisma";
import { readAsset } from "@/server/storage/asset-storage";

// Converts the brand's actual logo to base64 to give it to the AI as a
// visual reference (see referenceImage in gemini-image-client.ts). The
// same resolution logic as applyBrandTemplate (creative-template.ts) —
// find the Asset, read it back via the storage abstraction. Best-effort:
// returns null if logoAssetId is missing, or if the asset/file can't be
// found/read — it never throws, so the caller never has to wrap it in
// try/catch.
export async function loadBrandLogoImage(
  logoAssetId: string | null | undefined,
): Promise<{ data: string; mimeType: string } | null> {
  if (!logoAssetId) return null;

  try {
    const logoAsset = await prisma.asset.findUnique({
      where: { id: logoAssetId },
      select: { storageKey: true, mimeType: true },
    });
    if (!logoAsset) return null;

    const bytes = await readAsset(logoAsset.storageKey);
    return { data: bytes.toString("base64"), mimeType: logoAsset.mimeType };
  } catch {
    return null;
  }
}
