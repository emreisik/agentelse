"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";

import type { AssetType } from "@prisma/client";

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

// Reads the file as base64 so the existing image can be edited. Only accepts
// the local scheme; mock:// placeholders have no content to edit.
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

// Generates or edits the creative image. If `instruction` is given, the user
// has written what they want; if `mode=edit`, the existing image is fed to
// the model as input and changed according to the instruction — rather than
// generating from scratch, the composition is preserved and refined.
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
        message: "No existing image to edit — generate an image first",
      };
    }

    // In edit mode the instruction alone is enough (the image already carries
    // context); when generating from scratch, the creative's text + brand
    // identity + platform format are turned into a structured prompt (see
    // creative-prompt-builder.ts).
    const contextText =
      currentVersion?.caption ||
      currentVersion?.copy ||
      creative.brief ||
      creative.title ||
      "A social media marketing creative image";
    const platformFormat = getCreativePlatformFormat(creative.platform);

    // Brand logo and approved colors — fetched in a single query and used
    // for a different purpose depending on mode: as a visual reference for
    // the AI when generating from scratch (loadBrandLogoImage), or to
    // deterministically stamp the generated image in edit mode
    // (applyBrandTemplate).
    const dossier = await prisma.brandDossier.findUnique({
      where: { brandId: creative.brandId },
      select: { logoAssetId: true, approvedColors: true },
    });

    // When generating from scratch, the logo is now given to the AI as a
    // visual reference instead of deterministic stamping; in edit mode
    // baseImage already exists, so referenceImage is not used (rule from
    // step 2: never use both at once).
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
        message:
          "Image generation failed — see the error on the System Health screen",
      };
    }

    // In edit mode (mode === "edit") the logo is not given to the AI as a
    // visual reference (referenceImage is unused while baseImage is set), so
    // the real brand logo is still overlaid deterministically here via
    // applyBrandTemplate. When generating from scratch (mode !== "edit") the
    // logo was already given to the AI as a reference above, so it is NOT
    // overlaid again here — otherwise there would be a risk of a duplicate
    // logo. Best-effort: on failure, the raw AI image is kept as-is and the
    // action does not fail.
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
        // Which backend actually produced it — if the Gemini call fails,
        // creative-image.ts silently falls back to OpenClaw (without a
        // logo/text reference); without this field the only way to tell
        // the difference was the server logs.
        imageProvider: generated.provider,
      },
      revisionReason: baseImage
        ? `Image edited per instruction: ${instruction.slice(0, 200)}`
        : instruction
          ? `Image regenerated per instruction: ${instruction.slice(0, 200)}`
          : "Image regenerated",
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

    // A manual revision from the Creatives page is also subject to the
    // "golden rule": instead of getting lost in a separate panel, it lands
    // in the idea's chat as a NEW event (rather than updating the existing
    // creative-ready card — so previous versions also stay visible in the
    // chat history). Best-effort: silently skipped if it can't be linked to
    // an idea.
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
          const title = creative.title ?? "Creative";
          await IdeaChatRepository.postSystemMessage({
            workspaceId: creative.workspaceId,
            projectId: creative.projectId,
            ideaId,
            text: `🎨 Creative revised: ${title}`,
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
          "[creative-actions] failed to write revision chat card:",
          error,
        );
      }
    }

    revalidatePath(`/creatives/${creativeId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// Bridges the Library panel (see library-browser.tsx) to the Creative/
// publish pipeline. Before this, the ONLY way a Creative ever came into
// existence was execution-service.ts's AI generation path — there was no
// way to turn a user-uploaded Library asset (e.g. a video, which the AI
// pipeline can't generate at all — see media/creative-image.ts, image-only)
// into something publishCreativeToSocialCore (publish-creative.ts) could
// actually publish. This is the manual counterpart: pick an existing Asset,
// wrap it in a single-version Creative, and fast-track it straight to
// APPROVED (DRAFT -> IN_REVIEW -> APPROVED, the only path the state machine
// allows — see CREATIVE_TRANSITIONS in transitions.ts) since the user is
// knowingly approving their own upload right here, not an AI draft that
// needs a human review step.
export async function createCreativeFromLibraryAssetAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const assetId = String(formData.get("assetId") ?? "");
    const caption = String(formData.get("caption") ?? "").trim();
    const platformRaw = String(formData.get("platform") ?? "");
    const platform =
      platformRaw === "TIKTOK" ||
      platformRaw === "LINKEDIN" ||
      platformRaw === "X" ||
      platformRaw === "INSTAGRAM"
        ? platformRaw
        : undefined;
    if (!projectId || !assetId) {
      return { ok: false, message: "Missing project or asset." };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const asset = await prisma.asset.findFirst({
      where: { id: assetId, projectId },
    });
    if (!asset) {
      return { ok: false, message: "Asset not found in this project." };
    }
    // TikTok specifically requires a VIDEO-typed asset (see
    // publishCreativeToSocialCore's TikTok branch) — catching a mismatch
    // here gives a clear message instead of a confusing failure at publish
    // time.
    if (platform === "TIKTOK" && (asset.type as AssetType) !== "VIDEO") {
      return {
        ok: false,
        message: "TikTok requires a video asset — this file isn't a video.",
      };
    }

    const creative = await CreativeRepository.create({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      type: "SOCIAL_POST",
      platform,
      title: asset.filename,
    });
    await CreativeRepository.addVersion(creative.id, projectId, {
      assetId: asset.id,
      caption: caption || undefined,
    });
    await CreativeRepository.transition(creative.id, projectId, "IN_REVIEW");
    await CreativeRepository.transition(creative.id, projectId, "APPROVED");

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
