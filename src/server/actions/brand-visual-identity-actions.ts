"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { putAsset } from "@/server/storage/asset-storage";
import { fetchInstagramPostPreview } from "@/server/media/instagram-post-preview";
import {
  analyzeInstagramStyle,
  downloadImageAsAttachment,
} from "@/server/media/instagram-style-analyzer";
import type { InstagramStyleSuggestion } from "@/server/reasoning/prompts/instagram-style";

export type ActionResult = { ok: true } | { ok: false; message: string };

const HEX = /^#[0-9a-fA-F]{3,8}$/;

const ColorSwatchSchema = z.object({
  hex: z.string().regex(HEX, "Invalid hex color"),
  name: z.string().trim().min(1).optional(),
});

// The color-swatch-input.tsx client component owns an array of
// {hex, name?} in React state and serializes it into ONE hidden JSON
// input on submit — the user never hand-writes JSON (unlike
// BrandDossier.approvedColors's raw-textarea pattern this deliberately
// avoids); this just validates the shape that component always produces.
function parseColorField(
  formData: FormData,
  field: string,
): { hex: string; name?: string }[] {
  const raw = String(formData.get(field) ?? "[]");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = z.array(ColorSwatchSchema).safeParse(parsed);
  return result.success ? result.data : [];
}

function parseLines(formData: FormData, field: string): string[] {
  return String(formData.get(field) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseTags(formData: FormData, field: string): string[] {
  return String(formData.get(field) ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function optionalText(formData: FormData, field: string): string | null {
  const value = String(formData.get(field) ?? "").trim();
  return value.length > 0 ? value : null;
}

// Percent fields are clamped server-side (never trust the client) — narrow
// enough to prevent a degenerate 90%-of-canvas logo or an invisible 0%-tall
// accent bar, wide enough to leave real creative room.
function clampPercent(
  formData: FormData,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(formData.get(field));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

const PhotographyStyleSchema = z
  .enum([
    "PHOTOGRAPHIC",
    "ILLUSTRATED",
    "THREE_D_RENDER",
    "FLAT_DESIGN",
    "MIXED",
  ])
  .nullable();
const BackgroundToneSchema = z
  .enum(["LIGHT", "DARK", "BRAND_COLORED", "NO_PREFERENCE"])
  .nullable();
const LogoPositionSchema = z.enum([
  "TOP_LEFT",
  "TOP_RIGHT",
  "BOTTOM_LEFT",
  "BOTTOM_RIGHT",
  "CENTER_BOTTOM",
]);
const AccentBarPositionSchema = z.enum(["TOP", "BOTTOM"]);

function parseEnumField<T>(
  formData: FormData,
  field: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  const raw = formData.get(field);
  const value = raw === "" || raw === null ? null : raw;
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}

// Target of the Visual Identity edit Sheet in Brand Brain — same
// tenant-scoping pattern as updateBrandDossierAction (requireUser +
// requireProjectAccess, brandId from access.defaultBrandId, never the
// client). Upserts, since a brand's first edit has no existing row.
export async function updateBrandVisualIdentityAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const accentBarColorHexRaw = optionalText(formData, "accentBarColorHex");
    if (accentBarColorHexRaw && !HEX.test(accentBarColorHexRaw)) {
      return { ok: false, message: "Accent bar color: invalid hex value" };
    }

    const data = {
      primaryColors: parseColorField(formData, "primaryColors"),
      secondaryColors: parseColorField(formData, "secondaryColors"),
      accentColors: parseColorField(formData, "accentColors"),
      photographyStyle: parseEnumField(
        formData,
        "photographyStyle",
        PhotographyStyleSchema,
        null,
      ),
      styleRefinement: optionalText(formData, "styleRefinement"),
      moodTags: parseTags(formData, "moodTags"),
      compositionNotes: optionalText(formData, "compositionNotes"),
      backgroundTone: parseEnumField(
        formData,
        "backgroundTone",
        BackgroundToneSchema,
        null,
      ),
      alwaysInclude: parseLines(formData, "alwaysInclude"),
      alwaysAvoid: parseLines(formData, "alwaysAvoid"),
      templateEnabled: formData.get("templateEnabled") === "on",
      logoPosition: parseEnumField(
        formData,
        "logoPosition",
        LogoPositionSchema,
        "BOTTOM_RIGHT" as const,
      ),
      logoSizePercent: clampPercent(formData, "logoSizePercent", 16, 8, 30),
      logoMarginPercent: clampPercent(formData, "logoMarginPercent", 4, 1, 15),
      accentBarEnabled: formData.get("accentBarEnabled") === "on",
      accentBarColorHex: accentBarColorHexRaw,
      accentBarHeightPercent: clampPercent(
        formData,
        "accentBarHeightPercent",
        5,
        2,
        15,
      ),
      accentBarPosition: parseEnumField(
        formData,
        "accentBarPosition",
        AccentBarPositionSchema,
        "BOTTOM" as const,
      ),
    };

    await prisma.brandVisualIdentity.upsert({
      where: { brandId: access.defaultBrandId },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        ...data,
      },
      update: data,
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_visual_identity.updated",
      entityType: "BrandVisualIdentity",
      entityId: access.defaultBrandId,
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// Quick inline edit target (the workspace "Marka" panel's compact color
// popover) — deliberately a SEPARATE, narrow action from
// updateBrandVisualIdentityAction above. That action always upserts the
// FULL 17-field record (`update: data`), so a caller that only sends a
// couple of fields would silently blank out everything else (photography
// style, mood tags, template config, ...). This one does a real partial
// Prisma update touching ONLY primaryColors, so quick edits can never
// clobber settings made via the full Visual Identity dialog.
// Secondary/accent colors (set via that dialog) stay untouched and keep
// showing up merged in the panel's flat swatch list (see brand-twin.ts).
export async function updateVisualIdentityColorsAction(
  projectId: string,
  colors: { hex: string; name?: string }[],
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const parsed = z.array(ColorSwatchSchema).max(12).safeParse(colors);
    if (!parsed.success) {
      return { ok: false, message: "Invalid color list" };
    }

    await prisma.brandVisualIdentity.upsert({
      where: { brandId: access.defaultBrandId },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        primaryColors: parsed.data,
      },
      update: { primaryColors: parsed.data },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_visual_identity.colors_updated",
      entityType: "BrandVisualIdentity",
      entityId: access.defaultBrandId,
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

const STYLE_REFERENCE_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const MAX_STYLE_REFERENCE_SIZE = 8 * 1024 * 1024;

// Same simple bare-form-action pattern as uploadLogoAction — no
// ActionResult/toast wrapper, silent success via revalidatePath. Stores
// the reference image as a normal Asset (type IMAGE) and points
// BrandVisualIdentity.referenceImageAssetId at it.
export async function uploadStyleReferenceAction(
  formData: FormData,
): Promise<void> {
  const projectId = String(formData.get("projectId"));
  const file = formData.get("referenceImage");
  if (!(file instanceof File) || file.size === 0) return;

  const ext = STYLE_REFERENCE_MIME_TO_EXT[file.type];
  if (!ext || file.size > MAX_STYLE_REFERENCE_SIZE) {
    console.error(
      `[brand-visual-identity-actions] rejected style reference upload: type=${file.type} size=${file.size}`,
    );
    return;
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  const buffer = Buffer.from(await file.arrayBuffer());
  const { storageKey, filename } = await putAsset(buffer, ext, file.type);

  const asset = await prisma.asset.create({
    data: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      type: "IMAGE",
      source: "CUSTOMER_UPLOAD",
      filename,
      mimeType: file.type,
      storageKey,
      size: file.size,
    },
  });

  await prisma.brandVisualIdentity.upsert({
    where: { brandId: access.defaultBrandId },
    create: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      referenceImageAssetId: asset.id,
    },
    update: { referenceImageAssetId: asset.id },
  });

  revalidatePath(`/projects/${projectId}`);
}

// Clears the style reference without touching any other Visual Identity
// field — a dedicated action so the "remove" affordance doesn't need to
// resubmit the entire edit Sheet.
export async function removeStyleReferenceAction(
  formData: FormData,
): Promise<void> {
  const projectId = String(formData.get("projectId"));
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  await prisma.brandVisualIdentity.updateMany({
    where: { brandId: access.defaultBrandId },
    data: { referenceImageAssetId: null },
  });

  revalidatePath(`/projects/${projectId}`);
}

const MAX_INSTAGRAM_URLS = 5;

export type InstagramImportResult =
  | { ok: true; suggestion: InstagramStyleSuggestion; failedUrls: string[] }
  | { ok: false; message: string };

// Analysis only — this never writes to BrandVisualIdentity. It hands its
// suggestion to the client, which pre-fills the same edit Sheet
// updateBrandVisualIdentityAction already serves; saving still goes through
// that one action, so nothing about this feature bypasses the user
// reviewing/editing before anything is persisted.
export async function analyzeInstagramPostsAction(
  formData: FormData,
): Promise<InstagramImportResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const urls = String(formData.get("urls") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_INSTAGRAM_URLS);

    if (urls.length === 0) {
      return { ok: false, message: "Paste at least one Instagram post link" };
    }

    const previews = await Promise.all(
      urls.map(async (url) => ({
        url,
        preview: await fetchInstagramPostPreview(url),
      })),
    );

    const failedUrls = previews.filter((p) => !p.preview.ok).map((p) => p.url);
    const succeeded = previews.filter(
      (
        p,
      ): p is {
        url: string;
        preview: Extract<typeof p.preview, { ok: true }>;
      } => p.preview.ok,
    );

    if (succeeded.length === 0) {
      return {
        ok: false,
        message:
          "Couldn't read any of those links — check they're public post/reel URLs",
      };
    }

    const downloaded = await Promise.all(
      succeeded.map((p) => downloadImageAsAttachment(p.preview.imageUrl)),
    );
    const images = downloaded.filter((img) => img !== null);
    const imageFailedUrls = succeeded
      .filter((_, i) => downloaded[i] === null)
      .map((p) => p.url);

    if (images.length === 0) {
      return {
        ok: false,
        message: "Found the posts but couldn't download their images",
      };
    }

    const captions = succeeded
      .filter((_, i) => downloaded[i] !== null)
      .map((p) => p.preview.caption);

    const suggestion = await analyzeInstagramStyle(images, captions, {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_visual_identity.instagram_import_analyzed",
      entityType: "BrandVisualIdentity",
      entityId: access.defaultBrandId,
      metadata: { urlCount: urls.length, imageCount: images.length },
    });

    return {
      ok: true,
      suggestion,
      failedUrls: [...failedUrls, ...imageFailedUrls],
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Import failed",
    };
  }
}
