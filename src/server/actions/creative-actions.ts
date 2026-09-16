"use server";

import { revalidatePath } from "next/cache";

import type { AssetType, CreativeContentFormat } from "@prisma/client";

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
import { loadReferenceImage } from "@/server/media/brand-logo";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";
import { readAsset } from "@/server/storage/asset-storage";

// Manual, opt-in image generation — deliberately outside the
// Command/Task/ExecutionJob engine (see execution-service.ts). Every real
// OpenClaw call here costs a real OpenAI charge and takes several seconds,
// so it only ever runs on an explicit user click, never automatically on
// creative creation.
export type ActionResult = { ok: true } | { ok: false; message: string };

// Reads the file as base64 so the existing image can be edited. mock://
// placeholders have no content to edit.
async function readAssetForEditing(
  assetId: string | null | undefined,
): Promise<{ data: string; mimeType: string } | undefined> {
  if (!assetId) return undefined;
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) return undefined;
  try {
    const bytes = await readAsset(asset.storageKey);
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
    const contentFormatRaw = formData.get("contentFormat");
    const contentFormat =
      typeof contentFormatRaw === "string" && contentFormatRaw
        ? (contentFormatRaw as CreativeContentFormat)
        : undefined;
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
    const platformFormat = getCreativePlatformFormat(
      creative.platform,
      contentFormat,
    );

    // Brand logo, colors, and structured Visual Identity — one shared
    // resolver (see brand-style-context.ts) instead of the ad-hoc
    // BrandDossier-only query this used to run. This is also the fix for a
    // real bug: ConstitutionService.getBrandContext() below never contains
    // `approvedColors`/`visualGuidelines` (its two possible return shapes
    // are the raw Constitution payload or a 5-field dossier slice — neither
    // has those keys), so brand colors were silently dropped from every
    // manual "Visual Studio" regenerate, unlike the automated agency
    // pipeline (context-builder.ts), which reads them correctly. Merging
    // resolveBrandStyleContext()'s result into brandContext below fixes
    // that; getBrandContext() is still used for identity/positioning/tone,
    // which it does have.
    const brandStyle = await resolveBrandStyleContext(creative.brandId);

    // The logo is NEVER sent to the AI as a referenceImage in either mode
    // — it's added afterward, guaranteed, by applyBrandTemplate below (see
    // step 2: prompt text alone is stochastic, only compositing
    // guarantees exact placement). The referenceImage slot instead carries
    // the brand's optional "style board" image, and only in from-scratch
    // mode (edit mode already has baseImage; the two are never used
    // together).
    const styleImage = baseImage
      ? null
      : await loadReferenceImage(
          brandStyle.visualIdentity?.referenceImageAssetId ?? undefined,
        );

    const prompt = baseImage
      ? instruction ||
        "Improve the overall visual quality while keeping the composition."
      : buildCreativePrompt({
          subject: instruction
            ? `${instruction}\n\nBrand/creative context: ${contextText}`
            : contextText,
          brandContext: {
            ...(await ConstitutionService.getBrandContext(creative.brandId)),
            visualGuidelines: brandStyle.legacyVisualGuidelines,
            approvedColors: brandStyle.legacyApprovedColors,
            visualIdentity: brandStyle.visualIdentity,
          },
          platformLabel: platformFormat.label,
          contentFormatLabel: platformFormat.contentFormatLabel,
          pixelSize: platformFormat.pixelSize,
          safeZone: platformFormat.safeZone,
          caption: currentVersion?.caption ?? creative.title ?? undefined,
          hasStyleReference: Boolean(styleImage),
        });

    const generated = await generateCreativeImage(prompt, {
      baseImage,
      referenceImage: styleImage ?? undefined,
      imageSize: platformFormat.pixelSize,
    });
    if (!generated) {
      return {
        ok: false,
        message:
          "Image generation failed — see the error on the System Health screen",
      };
    }

    // Deterministic logo + accent-bar compositing — the ONE guarantee in
    // this pipeline, now applied identically in both edit and from-scratch
    // modes (previously edit-only, since from-scratch used to send the logo
    // to the AI as a reference instead — see step 2 above for why that
    // stopped). Best-effort: on failure, the raw AI image is kept as-is and
    // the action does not fail.
    try {
      const templated = await applyBrandTemplate({
        storageKey: generated.storageKey,
        mimeType: generated.mimeType,
        lightLogoAssetId: brandStyle.logoAssetId,
        darkLogoAssetId: brandStyle.darkLogoAssetId,
        accentColors: brandStyle.visualIdentity?.accentColors,
        legacyApprovedColors: brandStyle.legacyApprovedColors,
        template: brandStyle.visualIdentity?.template ?? undefined,
      });
      if (templated) generated.size = templated.size;
    } catch (error) {
      console.error("[creative-actions] applyBrandTemplate failed:", error);
    }

    const asset = await prisma.asset.create({
      data: {
        workspaceId: creative.workspaceId,
        projectId: creative.projectId,
        brandId: creative.brandId,
        type: "CREATIVE",
        source: "AI_GENERATED",
        filename: generated.filename,
        mimeType: generated.mimeType,
        storageKey: generated.storageKey,
        size: generated.size,
        width: generated.width,
        height: generated.height,
      },
    });

    await CreativeRepository.addVersion(creative.id, creative.projectId, {
      assetId: asset.id,
      caption: currentVersion?.caption ?? undefined,
      copy: currentVersion?.copy ?? undefined,
      contentFormat: platformFormat.contentFormat,
      generationProvider: generated.provider,
      generationMetadata: {
        prompt,
        mode,
        edited: Boolean(baseImage),
        aspectRatio: platformFormat.aspectRatio,
        platform: creative.platform,
        contentFormat: platformFormat.contentFormat,
        targetWidth: platformFormat.pixelSize.width,
        targetHeight: platformFormat.pixelSize.height,
        // Which backend actually produced it — if the OpenAI call fails,
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
              assetWidth: asset.width ?? undefined,
              assetHeight: asset.height ?? undefined,
              platform: creative.platform,
              contentFormat: platformFormat.contentFormat,
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

    const platformFormat = getCreativePlatformFormat(platform);
    // Ratio check against the platform's required format — only possible
    // when the asset's real pixel size is known (images get measured on
    // upload, see library-actions.ts; video dimensions aren't probed yet,
    // so this is a no-op for TikTok's VIDEO-only assets until that lands).
    // 2% tolerance absorbs rounding from slightly different source
    // resolutions at the same ratio. Rejected rather than auto-cropped —
    // cropping a user's own upload without asking risks losing the part of
    // the frame that mattered to them.
    if (asset.width && asset.height) {
      const actualRatio = asset.width / asset.height;
      const targetRatio =
        platformFormat.pixelSize.width / platformFormat.pixelSize.height;
      if (Math.abs(actualRatio - targetRatio) / targetRatio > 0.02) {
        return {
          ok: false,
          message: `${platformFormat.label} requires ${platformFormat.aspectRatio} (${platformFormat.pixelSize.width}x${platformFormat.pixelSize.height}px) — this file is ${asset.width}x${asset.height}px, which doesn't match.`,
        };
      }
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
      contentFormat: platformFormat.contentFormat,
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
