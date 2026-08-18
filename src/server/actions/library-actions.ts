"use server";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import type { ActionResult } from "@/components/shared/action-form";

// Kütüphane paneline doğrudan dosya yükleme — sohbet ekindeki
// CHAT_MIME_TO_EXT ile aynı izinli tür seti (command-actions.ts), çünkü
// ikisi de aynı /api/assets/[assetId]/route.ts SAFE_FILENAME regex'inden
// geçmek zorunda. Sohbete özgü boyut/adet sınırları (inlineData isteği)
// burada geçerli değil — tek dosya, daha yüksek bir sınır yeterli.
const LIBRARY_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
};
const MAX_LIBRARY_FILE_SIZE = 20 * 1024 * 1024;
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

export async function uploadLibraryAssetAction(
  formData: FormData,
): Promise<ActionResult> {
  const projectId = String(formData.get("projectId") ?? "");
  const file = formData.get("file");
  if (!projectId || !(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Dosya seçilmedi." };
  }

  const ext = LIBRARY_MIME_TO_EXT[file.type];
  if (!ext) {
    return {
      ok: false,
      message: `Desteklenmeyen dosya türü: ${file.name}. Görsel (PNG/JPG/WebP), PDF veya metin dosyası (TXT/CSV/MD) yükleyin.`,
    };
  }
  if (file.size > MAX_LIBRARY_FILE_SIZE) {
    return {
      ok: false,
      message: `${file.name} çok büyük (sınır ${MAX_LIBRARY_FILE_SIZE / 1024 / 1024} MB).`,
    };
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  await mkdir(LOCAL_ASSETS_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(
    path.join(LOCAL_ASSETS_DIR, filename),
    Buffer.from(await file.arrayBuffer()),
  );

  await prisma.asset.create({
    data: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      type: file.type.startsWith("image/") ? "IMAGE" : "DOCUMENT",
      filename,
      mimeType: file.type,
      storageKey: `local-asset://${filename}`,
      size: file.size,
    },
  });

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
