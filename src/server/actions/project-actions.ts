"use server";

import { randomUUID } from "node:crypto";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { ProjectRepository } from "@/server/repositories/project.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { generateCreativeImage } from "@/server/media/creative-image";
import { putAsset } from "@/server/storage/asset-storage";
import { isSupportedLanguage, isSupportedCountry } from "@/lib/locales";

async function getWorkspaceId(userId: string): Promise<string> {
  const membership = await prisma.workspaceMember.findFirstOrThrow({
    where: { userId },
  });
  return membership.workspaceId;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Creates the Project + default Brand and drops the user into the 12-stage
// Agency Setup. We don't advance the project status here: the owner of the
// lifecycle is ProjectSetupOrchestrator (it performs the CREATED -> DISCOVERY
// transition when setup starts).
export async function createProjectAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const domain = String(formData.get("domain") ?? "").trim();
  const brandName = String(formData.get("brandName") ?? "").trim();
  const language = String(formData.get("language") ?? "").trim();
  // The wizard can select multiple markets — the client appends each selected
  // code as a separate "country" entry (the first = primary market).
  // formData.getAll() preserves ordering.
  const countries = [
    ...new Set(
      formData
        .getAll("country")
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ];
  const country = countries[0] ?? "";
  if (!name) return;
  if (!isSupportedLanguage(language) || !isSupportedCountry(country)) return;
  if (!countries.every(isSupportedCountry)) return;

  const { userId } = await requireUser();
  const workspaceId = await getWorkspaceId(userId);

  let baseSlug = slugify(name);
  if (!baseSlug) baseSlug = randomUUID().slice(0, 8);
  let slug = baseSlug;
  let attempt = 0;
  let project;
  for (;;) {
    try {
      project = await ProjectRepository.create({
        workspaceId,
        name,
        slug,
        domain: domain || undefined,
        brandName: brandName || undefined,
        language,
        country,
        countries,
      });
      break;
    } catch (error) {
      attempt += 1;
      if (attempt > 5) throw error;
      slug = `${baseSlug}-${attempt}`;
    }
  }

  await AuditLogRepository.record({
    workspaceId,
    projectId: project.id,
    // ProjectRepository.create() always nested-creates exactly one Brand.
    brandId: project.brands[0]!.id,
    actorType: "USER",
    actorId: userId,
    action: "project.created",
    entityType: "Project",
    entityId: project.id,
  });

  // Setup intake now happens conversationally in the project chat itself
  // (see chat-turn.ts's NOT_STARTED phase) instead of the ?panel=setup form.
  redirect(`/projects/${project.id}`);
}

const LOGO_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
const MAX_LOGO_SIZE = 5 * 1024 * 1024;

// "light" = the light-colored logo variant, shown on dark backgrounds.
// "dark" = the dark-colored variant, shown on light backgrounds.
// creative-template.ts picks between BrandDossier.logoAssetId (light) and
// .darkLogoAssetId (dark) by sampling the generated image's background.
type LogoVariant = "light" | "dark";

function logoVariantFromForm(formData: FormData): LogoVariant {
  return formData.get("variant") === "dark" ? "dark" : "light";
}

export async function uploadLogoAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return;
  const variant = logoVariantFromForm(formData);

  const ext = LOGO_MIME_TO_EXT[file.type];
  if (!ext || file.size > MAX_LOGO_SIZE) {
    console.error(
      `[project-actions] rejected logo upload: type=${file.type} size=${file.size}`,
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
      type: "LOGO",
      source: "CUSTOMER_UPLOAD",
      filename,
      mimeType: file.type,
      storageKey,
      size: file.size,
    },
  });

  const field = variant === "dark" ? "darkLogoAssetId" : "logoAssetId";
  await prisma.brandDossier.upsert({
    where: { brandId: access.defaultBrandId },
    create: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      [field]: asset.id,
    },
    update: { [field]: asset.id },
  });

  revalidatePath(`/projects/${projectId}`);
}

export async function generateLogoAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const variant = logoVariantFromForm(formData);
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  const [project, dossier] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.brandDossier.findUnique({
      where: { brandId: access.defaultBrandId },
    }),
  ]);

  const colorInstruction =
    variant === "dark"
      ? "The logo mark itself must be dark-colored (black or a dark brand color) so it reads clearly on light backgrounds."
      : "The logo mark itself must be light-colored (white or a light brand color) so it reads clearly on dark backgrounds.";
  const prompt = `A simple, modern, flat-design logo icon for a company called "${project.name}". ${dossier?.positioning ?? ""} Minimalist, vector style, centered on a plain white background, no text. ${colorInstruction}`;

  const generated = await generateCreativeImage(prompt);
  if (!generated) {
    console.error(
      `[project-actions] logo generation failed for project ${projectId}`,
    );
    return;
  }

  const asset = await prisma.asset.create({
    data: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      type: "LOGO",
      source: "AI_GENERATED",
      filename: generated.filename,
      mimeType: generated.mimeType,
      storageKey: generated.storageKey,
      size: generated.size,
    },
  });

  const field = variant === "dark" ? "darkLogoAssetId" : "logoAssetId";
  await prisma.brandDossier.upsert({
    where: { brandId: access.defaultBrandId },
    create: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      [field]: asset.id,
    },
    update: { [field]: asset.id },
  });

  revalidatePath(`/projects/${projectId}`);
}

type ActionResult = { ok: true } | { ok: false; message: string };

const BrandDossierTextField = z.string().transform((value) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
});

// targetAudiences/markets/products/services/visualGuidelines are free-form
// Json columns — they don't have a single predetermined shape (see
// prisma/seed.ts: targetAudiences is {label,description}[] while
// constitution-synthesis.ts produces a plain string[]). So the form field is
// raw, editable JSON text: whatever shape it currently has round-trips
// losslessly. If left empty, the column is cleared with Prisma.DbNull (a
// literal `null` is rejected by Prisma on a nullable Json column).
function parseDossierJsonField(
  formData: FormData,
  field: string,
  label: string,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const raw = String(formData.get(field) ?? "").trim();
  if (!raw) return Prisma.DbNull;
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    throw new Error(`${label}: not valid JSON`);
  }
}

// Target of the "Edit" form on the Brand Dossier card in Brand Brain >
// Assets — same tenant-scoping pattern as the logo upserts (requireUser +
// requireProjectAccess, brandId from access.defaultBrandId, NOT from the
// client). If the dossier doesn't exist yet, the upsert creates it for the
// first time.
export async function updateBrandDossierAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const data = {
      summary: BrandDossierTextField.parse(
        String(formData.get("summary") ?? ""),
      ),
      positioning: BrandDossierTextField.parse(
        String(formData.get("positioning") ?? ""),
      ),
      toneOfVoice: BrandDossierTextField.parse(
        String(formData.get("toneOfVoice") ?? ""),
      ),
      language: BrandDossierTextField.parse(
        String(formData.get("language") ?? ""),
      ),
      country: BrandDossierTextField.parse(
        String(formData.get("country") ?? ""),
      ),
      targetAudiences: parseDossierJsonField(
        formData,
        "targetAudiences",
        "Target Audiences",
      ),
      markets: parseDossierJsonField(formData, "markets", "Markets"),
      products: parseDossierJsonField(formData, "products", "Products"),
      services: parseDossierJsonField(formData, "services", "Services"),
      visualGuidelines: parseDossierJsonField(
        formData,
        "visualGuidelines",
        "Visual Guidelines",
      ),
    };

    await prisma.brandDossier.upsert({
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
      action: "brand_dossier.updated",
      entityType: "BrandDossier",
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

// Quick inline edit target (the workspace "Marka" panel's compact
// typography popover) — separate from updateBrandDossierAction above for
// the same reason updateVisualIdentityColorsAction is separate from
// updateBrandVisualIdentityAction: that action always upserts every
// dossier text field at once, so a partial submit would blank out
// summary/positioning/toneOfVoice/etc. This one touches ONLY
// approvedFonts (a real partial Prisma update).
export async function updateApprovedFontsAction(
  projectId: string,
  fonts: string[],
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const cleaned = fonts
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, 8);

    await prisma.brandDossier.upsert({
      where: { brandId: access.defaultBrandId },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        approvedFonts: cleaned,
      },
      update: { approvedFonts: cleaned },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_dossier.fonts_updated",
      entityType: "BrandDossier",
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
