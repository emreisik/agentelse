"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { generateCreativeImage } from "@/server/media/creative-image";
import { buildCreativePrompt } from "@/server/media/creative-prompt-builder";
import { applyBrandTemplate } from "@/server/media/creative-template";
import { loadBrandLogoImage } from "@/server/media/brand-logo";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";

// Manual, opt-in image generation — deliberately outside the
// Command/Task/ExecutionJob engine (see execution-service.ts). Every real
// OpenClaw call here costs a real OpenAI charge and takes several seconds,
// so it only ever runs on an explicit user click, never automatically on
// creative creation.
export type ActionResult = { ok: true } | { ok: false; message: string };

const LOCAL_ASSET_SCHEME = "local-asset://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

// Mevcut görseli düzenleyebilmek için dosyayı base64 olarak okur. Yalnızca
// yerel şemayı kabul eder; mock:// yer tutucuların düzenlenecek bir içeriği
// yoktur.
async function readAssetForEditing(
  assetId: string | null | undefined,
): Promise<{ data: string; mimeType: string } | undefined> {
  if (!assetId) return undefined;
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset?.storageKey.startsWith(LOCAL_ASSET_SCHEME)) return undefined;

  const filename = asset.storageKey.slice(LOCAL_ASSET_SCHEME.length);
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return undefined;
  }
  try {
    const bytes = await readFile(path.join(LOCAL_ASSETS_DIR, filename));
    return { data: bytes.toString("base64"), mimeType: asset.mimeType };
  } catch {
    return undefined;
  }
}

// Kreatif görselini üretir veya düzenler. `instruction` verilmişse kullanıcı
// ne istediğini yazmıştır; `mode=edit` ise mevcut görsel girdi olarak
// modele verilir ve talimata göre değiştirilir — sıfırdan üretmek yerine
// kompozisyonu koruyarak düzeltme yapılır.
export async function generateRealCreativeImageAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const creativeId = String(formData.get("creativeId"));
    const instruction = String(formData.get("instruction") ?? "").trim();
    const mode = String(formData.get("mode") ?? "new");
    const { userId } = await requireUser();

    const creative = await prisma.creative.findUniqueOrThrow({
      where: { id: creativeId },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    await requireProjectAccess(userId, creative.projectId);

    const currentVersion = creative.versions[0];
    const baseImage =
      mode === "edit"
        ? await readAssetForEditing(currentVersion?.assetId)
        : undefined;

    if (mode === "edit" && !baseImage) {
      return {
        ok: false,
        message: "Düzenlenecek mevcut bir görsel yok — önce görsel üretin",
      };
    }

    // Düzenlemede talimat tek başına yeterli (görsel zaten bağlam taşıyor);
    // sıfırdan üretimde kreatifin metni + marka kimliği + platform formatı
    // yapılandırılmış bir prompt'a dönüştürülür (bkz. creative-prompt-builder.ts).
    const contextText =
      currentVersion?.caption ||
      currentVersion?.copy ||
      creative.brief ||
      creative.title ||
      "A social media marketing creative image";
    const platformFormat = getCreativePlatformFormat(creative.platform);

    // Marka logosu ve onaylı renkler — sıfırdan üretimde AI'a görsel
    // referans olarak vermek (loadBrandLogoImage) ya da düzenleme modunda
    // üretilen görseli deterministik olarak damgalamak (applyBrandTemplate)
    // için tek sorguda çekilir, moda göre farklı amaçla kullanılır.
    const dossier = await prisma.brandDossier.findUnique({
      where: { brandId: creative.brandId },
      select: { logoAssetId: true, approvedColors: true },
    });

    // Sıfırdan üretimde logo artık deterministik damgalama yerine AI'a
    // görsel referans olarak veriliyor; düzenleme modunda baseImage zaten
    // var, referenceImage kullanılmaz (adım 2'deki kural: ikisi birden
    // kullanılmaz).
    const logoImage = baseImage
      ? null
      : await loadBrandLogoImage(dossier?.logoAssetId);

    const prompt = baseImage
      ? instruction ||
        "Improve the overall visual quality while keeping the composition."
      : buildCreativePrompt({
          subject: instruction
            ? `${instruction}\n\nBrand/creative context: ${contextText}`
            : contextText,
          brandContext: await ConstitutionService.getBrandContext(
            creative.brandId,
          ),
          platformLabel: platformFormat.label,
          caption: currentVersion?.caption ?? creative.title ?? undefined,
          hasLogoReference: Boolean(logoImage),
        });

    const generated = await generateCreativeImage(prompt, {
      baseImage,
      referenceImage: logoImage ?? undefined,
      aspectRatio: platformFormat.aspectRatio,
      imageSize: platformFormat.pixelSize,
    });
    if (!generated) {
      return {
        ok: false,
        message: "Görsel üretilemedi — Sistem Sağlığı ekranındaki hataya bakın",
      };
    }

    // Düzenleme modunda (mode === "edit") logo AI'a görsel referans olarak
    // verilmez (baseImage varken referenceImage kullanılmaz), o yüzden
    // gerçek marka logosu burada hâlâ applyBrandTemplate ile deterministik
    // olarak bindirilir. Sıfırdan üretimde (mode !== "edit") logo zaten
    // yukarıda AI'a referans olarak verildiği için burada TEKRAR
    // bindirilmez — aksi halde çift logo riski olurdu. Best-effort:
    // başarısız olursa ham AI görseli olduğu gibi kalır, işlem düşmez.
    if (baseImage) {
      try {
        const templated = await applyBrandTemplate({
          filename: generated.filename,
          logoAssetId: dossier?.logoAssetId,
          approvedColors: dossier?.approvedColors,
        });
        if (templated) generated.size = templated.size;
      } catch (error) {
        console.error("[creative-actions] applyBrandTemplate failed:", error);
      }
    }

    const asset = await prisma.asset.create({
      data: {
        workspaceId: creative.workspaceId,
        projectId: creative.projectId,
        brandId: creative.brandId,
        type: "CREATIVE",
        filename: generated.filename,
        mimeType: generated.mimeType,
        storageKey: generated.storageKey,
        size: generated.size,
      },
    });

    await CreativeRepository.addVersion(creative.id, creative.projectId, {
      assetId: asset.id,
      caption: currentVersion?.caption ?? undefined,
      copy: currentVersion?.copy ?? undefined,
      generationProvider: "gemini-image",
      generationMetadata: {
        prompt,
        mode,
        edited: Boolean(baseImage),
        aspectRatio: platformFormat.aspectRatio,
        platform: creative.platform,
        // Gerçekte hangi backend'in ürettiği — Gemini çağrısı başarısız
        // olursa creative-image.ts sessizce OpenClaw'a düşer (logo/metin
        // referansı olmadan); bu alan olmadan bunu ayırt etmenin tek yolu
        // sunucu loglarıydı.
        imageProvider: generated.provider,
      },
      revisionReason: baseImage
        ? `Görsel talimatla düzenlendi: ${instruction.slice(0, 200)}`
        : instruction
          ? `Görsel talimatla yeniden üretildi: ${instruction.slice(0, 200)}`
          : "Görsel yeniden üretildi",
    });

    await AuditLogRepository.record({
      workspaceId: creative.workspaceId,
      projectId: creative.projectId,
      brandId: creative.brandId,
      actorType: "USER",
      actorId: userId,
      action: baseImage ? "creative.image_edited" : "creative.image_generated",
      entityType: "Creative",
      entityId: creative.id,
    });

    // Creatives sayfasından elle yapılan revizyon de "altın kural"a tabi:
    // ayrı bir panelde kaybolmadan, fikrin sohbetine YENİ bir olay olarak
    // düşer (mevcut creative-ready kartını güncellemek yerine — böylece
    // önceki versiyonlar da sohbet geçmişinde görünür kalır). Best-effort,
    // fikre bağlanamıyorsa sessizce atlanır.
    if (creative.createdByTaskId) {
      try {
        const [ideaId, task] = await Promise.all([
          IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId),
          prisma.task.findUnique({
            where: { id: creative.createdByTaskId },
            select: { departmentKey: true },
          }),
        ]);
        if (ideaId) {
          const title = creative.title ?? "Kreatif";
          await IdeaChatRepository.postSystemMessage({
            workspaceId: creative.workspaceId,
            projectId: creative.projectId,
            ideaId,
            text: `🎨 Kreatif revize edildi: ${title}`,
            card: {
              kind: "creative-ready",
              taskId: creative.createdByTaskId,
              title,
              creativeId: creative.id,
              assetId: asset.id,
              mimeType: asset.mimeType,
              caption: currentVersion?.caption ?? undefined,
              copy: currentVersion?.copy ?? undefined,
              status: creative.status,
            },
            departmentKey: task?.departmentKey ?? undefined,
          });
        }
      } catch (error) {
        console.error(
          "[creative-actions] revizyon sohbet kartı yazılamadı:",
          error,
        );
      }
    }

    revalidatePath(`/creatives/${creativeId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "İşlem başarısız",
    };
  }
}
