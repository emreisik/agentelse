"use server";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

// Projeyi + varsayılan Marka'yı oluşturur ve kullanıcıyı 12 aşamalı
// Ajans Kurulumu'na bırakır. Proje durumunu burada ilerletmiyoruz:
// yaşam döngüsünün sahibi ProjectSetupOrchestrator (CREATED -> DISCOVERY
// geçişini kurulum başlarken o yapıyor).
export async function createProjectAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const domain = String(formData.get("domain") ?? "").trim();
  const brandName = String(formData.get("brandName") ?? "").trim();
  const language = String(formData.get("language") ?? "").trim();
  // Sihirbaz birden fazla pazar seçtirebilir — client her seçili kodu ayrı
  // bir "country" girişi olarak append eder (ilki = birincil pazar).
  // formData.getAll() sıralamayı korur.
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

  redirect(`/projects/${project.id}?panel=kurulum`);
}

const LOGO_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
const MAX_LOGO_SIZE = 5 * 1024 * 1024;
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

export async function uploadLogoAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return;

  const ext = LOGO_MIME_TO_EXT[file.type];
  if (!ext || file.size > MAX_LOGO_SIZE) {
    console.error(
      `[project-actions] rejected logo upload: type=${file.type} size=${file.size}`,
    );
    return;
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  await mkdir(LOCAL_ASSETS_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(
    path.join(LOCAL_ASSETS_DIR, filename),
    Buffer.from(await file.arrayBuffer()),
  );

  const asset = await prisma.asset.create({
    data: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      type: "LOGO",
      filename,
      mimeType: file.type,
      storageKey: `local-asset://${filename}`,
      size: file.size,
    },
  });

  await prisma.brandDossier.upsert({
    where: { brandId: access.defaultBrandId },
    create: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      logoAssetId: asset.id,
    },
    update: { logoAssetId: asset.id },
  });

  revalidatePath(`/projects/${projectId}`);
}

export async function generateLogoAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  const [project, dossier] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.brandDossier.findUnique({
      where: { brandId: access.defaultBrandId },
    }),
  ]);

  const prompt = `A simple, modern, flat-design logo icon for a company called "${project.name}". ${dossier?.positioning ?? ""} Minimalist, vector style, centered on a plain white background, no text.`;

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
      filename: generated.filename,
      mimeType: generated.mimeType,
      storageKey: generated.storageKey,
      size: generated.size,
    },
  });

  await prisma.brandDossier.upsert({
    where: { brandId: access.defaultBrandId },
    create: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      logoAssetId: asset.id,
    },
    update: { logoAssetId: asset.id },
  });

  revalidatePath(`/projects/${projectId}`);
}

type ActionResult = { ok: true } | { ok: false; message: string };

const BrandDossierTextField = z.string().transform((value) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
});

// targetAudiences/markets/products/services/visualGuidelines serbest Json
// kolonları — tek bir öngörülmüş şekilleri yok (bkz. prisma/seed.ts:
// targetAudiences {label,description}[] iken constitution-synthesis.ts
// düz string[] üretiyor). Bu yüzden form alanı ham, düzenlenebilir JSON
// metni: mevcut şekli ne olursa olsun kayıpsız gidip geliyor. Boş
// bırakılırsa kolon Prisma.DbNull ile temizlenir (nullable Json kolonunda
// literal `null` Prisma tarafından reddedilir).
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
    throw new Error(`${label}: geçerli bir JSON değil`);
  }
}

// Marka Beyni > Varlıklar > Marka Dosyası kartındaki "Düzenle" formunun
// hedefi — logo upsert'leriyle aynı tenant-scoping deseni (requireUser +
// requireProjectAccess, brandId İSTEMCİDEN DEĞİL access.defaultBrandId'den).
// Dossier henüz yoksa upsert onu ilk kez de oluşturur.
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
        "Hedef Kitleler",
      ),
      markets: parseDossierJsonField(formData, "markets", "Pazarlar"),
      products: parseDossierJsonField(formData, "products", "Ürünler"),
      services: parseDossierJsonField(formData, "services", "Hizmetler"),
      visualGuidelines: parseDossierJsonField(
        formData,
        "visualGuidelines",
        "Görsel Kurallar",
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
      message: error instanceof Error ? error.message : "İşlem başarısız",
    };
  }
}
