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
