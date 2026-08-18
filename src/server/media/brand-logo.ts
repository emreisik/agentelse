import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";

const LOCAL_ASSET_SCHEME = "local-asset://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

// Markanın gerçek logosunu AI'ye görsel referans olarak vermek için base64'e
// çevirir (bkz. gemini-image-client.ts'teki referenceImage). applyBrandTemplate
// (creative-template.ts) ile aynı çözümleme mantığı — Asset'i bul, storageKey
// yerel şemaya uyuyor mu doğrula, dosyayı oku. Best-effort: logoAssetId yoksa
// ya da asset/dosya bulunamazsa/okunamazsa null döner, hiçbir zaman throw
// etmez — çağıran taraf try/catch'e almak zorunda kalmamalı.
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
