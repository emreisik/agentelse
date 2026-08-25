import "server-only";

import { prisma } from "@/lib/prisma";
import { readAsset } from "@/server/storage/asset-storage";

// Converts an Asset to base64 so it can be given to the AI as a visual
// reference (see referenceImage in gemini-image-client.ts/openai-image-
// client.ts). The same resolution logic as applyBrandTemplate (creative-
// template.ts) — find the Asset, read it back via the storage abstraction.
// Best-effort: returns null if assetId is missing, or if the asset/file
// can't be found/read — it never throws, so the caller never has to wrap
// it in try/catch.
async function loadImageAsset(
  assetId: string | null | undefined,
): Promise<{ data: string; mimeType: string } | null> {
  if (!assetId) return null;

  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { storageKey: true, mimeType: true },
    });
    if (!asset) return null;

    const bytes = await readAsset(asset.storageKey);
    return { data: bytes.toString("base64"), mimeType: asset.mimeType };
  } catch {
    return null;
  }
}

// Named for its historical/primary caller (loading the brand's logo). Once
// deterministic template compositing (applyBrandTemplate) is what places
// the logo, this is no longer used as an AI referenceImage — kept for the
// manual "generate a logo" flow and any future logo-preview need.
export const loadBrandLogoImage = loadImageAsset;

// The brand's optional "style board" reference image (BrandVisualIdentity.
// referenceImageAssetId) — the AI referenceImage slot freed up once the
// logo itself stops being sent that way (see creative-prompt-builder.ts's
// hasStyleReference wording: this must never contain literal logo/subject
// matter the model would copy, only mood/palette/style to emulate).
export const loadReferenceImage = loadImageAsset;
