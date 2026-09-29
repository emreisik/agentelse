"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { LayoutTemplatesSchema } from "@/lib/layout-templates";
import { isRateLimited } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { scanWebsite, type SiteScanResult } from "@/server/brand/site-scan/scan";
import { analyzeLogo, prepareLogo } from "@/server/brand/site-scan/image-colors";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError, } from "@/server/security/errors";
import { UnsafeUrlError } from "@/server/security/safe-fetch";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { limitNoticeFromError, limitNoticeReplyText } from "@/server/commands/limit-notice";
import { putAsset } from "@/server/storage/asset-storage";

// Site scan for the Brand tab: scan is READ-ONLY (returns a suggestion for the
// user to review); apply is the only step that writes, and it re-validates
// everything the browser sends back — the payload is untrusted input.

const SCANS_PER_MINUTE = 4;
const MAX_LOGO_BYTES = 1_500_000;
const HEX = /^#[0-9a-fA-F]{6}$/;

export type ScanActionResult =
  | { ok: true; result: SiteScanResult }
  | { ok: false; message: string };

export async function scanBrandWebsiteAction(
  projectId: string,
  url: string,
): Promise<ScanActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    if (isRateLimited(`brand-scan:${userId}`, SCANS_PER_MINUTE, 60_000)) {
      return { ok: false, message: "Too many scans. Please wait a minute." };
    }
    if (typeof url !== "string" || url.length > 300) {
      return { ok: false, message: "Enter a valid website address." };
    }

    const result = await scanWebsite(url, {
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
      action: "brand_scan.scanned",
      entityType: "Brand",
      entityId: access.defaultBrandId,
      metadata: {
        host: new URL(result.url).hostname,
        logo: Boolean(result.logo),
        warnings: result.warnings.length,
      },
    }).catch(() => undefined);

    return { ok: true, result };
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return { ok: false, message: error.message };
    }
    const notice = limitNoticeFromError(error);
    if (notice) return { ok: false, message: limitNoticeReplyText(notice) };
    if (isAgentelseError(error)) {
      return { ok: false, message: "The scan could not be completed right now." };
    }
    console.error("[brand-scan] scan failed:", error);
    return {
      ok: false,
      message:
        error instanceof Error && /HTTP|took too long|redirect|content type|large/i.test(error.message)
          ? `Could not read that site: ${error.message}`
          : "Could not read that site. Check the address and try again.",
    };
  }
}

const SwatchSchema = z.object({
  hex: z.string().regex(HEX),
  name: z.string().max(40).optional(),
});

const ApplyPayloadSchema = z.object({
  url: z.string().max(300).optional(),
  // "data:image/png;base64,...." from the scan preview, or null to keep the
  // current logo.
  logoDataUrl: z.string().max(MAX_LOGO_BYTES * 2).nullable().optional(),
  colors: z.object({
    primary: z.array(SwatchSchema).max(4),
    secondary: z.array(SwatchSchema).max(4),
    accent: z.array(SwatchSchema).max(3),
  }),
  fonts: z.array(z.string().trim().min(1).max(60)).max(8),
  style: z.object({
    photographyStyle: z.enum(["PHOTOGRAPHIC", "ILLUSTRATED", "THREE_D_RENDER", "FLAT_DESIGN", "MIXED"]),
    styleRefinement: z.string().max(600),
    moodTags: z.array(z.string().trim().min(1).max(30)).max(8),
    compositionNotes: z.string().max(400),
    backgroundTone: z.enum(["LIGHT", "DARK", "BRAND_COLORED", "NO_PREFERENCE"]),
    alwaysAvoid: z.array(z.string().trim().min(1).max(80)).max(8),
  }),
  // The post layouts reviewed in the modal. Optional: without it the brand's
  // saved layouts are left exactly as they are.
  layouts: LayoutTemplatesSchema.optional(),
});

export type ApplyBrandScanPayload = z.infer<typeof ApplyPayloadSchema>;

export type LogoSlot = "light" | "dark";

export type ApplyActionResult =
  | { ok: true; logoSaved: boolean; logoSlot: LogoSlot | null; domain: string | null }
  | { ok: false; message: string };

function decodeLogo(dataUrl: string): Buffer | null {
  const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[1]!, "base64");
  return buffer.length > 0 && buffer.length <= MAX_LOGO_BYTES ? buffer : null;
}

export async function applyBrandScanAction(
  projectId: string,
  rawPayload: unknown,
): Promise<ApplyActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const parsed = ApplyPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return { ok: false, message: "The scan result was not valid. Scan again." };
    }
    const payload = parsed.data;

    // Logo: never trust the bytes — decode and re-encode through sharp. The
    // slot is decided HERE from the pixels, never taken from the client: the
    // template picks the light variant for dark regions and the dark variant
    // for light regions, so a dark logo stored in the light slot would vanish
    // on dark posts the moment its counterpart is uploaded.
    let logoAssetId: string | null = null;
    let logoSlot: LogoSlot | null = null;
    if (payload.logoDataUrl) {
      const raw = decodeLogo(payload.logoDataUrl);
      const prepared = raw ? await prepareLogo(raw) : null;
      if (!prepared) {
        return { ok: false, message: "The logo image could not be read." };
      }
      logoSlot = (await analyzeLogo(prepared.png)).tone;
      const { storageKey, filename } = await putAsset(prepared.png, "png", "image/png");
      const asset = await prisma.asset.create({
        data: {
          workspaceId: access.workspaceId,
          projectId,
          brandId: access.defaultBrandId,
          type: "LOGO",
          source: "CUSTOMER_UPLOAD",
          filename,
          mimeType: "image/png",
          storageKey,
          size: prepared.png.length,
          width: prepared.width,
          height: prepared.height,
        },
      });
      logoAssetId = asset.id;
    }

    const scope = {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
    };

    // Dossier: fonts always; the logo only when the user chose to save it,
    // and only into the slot matching its tone (the other slot is untouched).
    const logoField = logoSlot === "light" ? "logoAssetId" : "darkLogoAssetId";
    const logoUpdate = logoAssetId ? { [logoField]: logoAssetId } : {};
    await prisma.brandDossier.upsert({
      where: { brandId: access.defaultBrandId },
      create: { ...scope, approvedFonts: payload.fonts, ...logoUpdate },
      update: { approvedFonts: payload.fonts, ...logoUpdate },
    });

    // Visual identity: colours + style. Layout/template columns are left
    // alone on update (and take their defaults on create).
    const identity = {
      primaryColors: payload.colors.primary,
      secondaryColors: payload.colors.secondary,
      accentColors: payload.colors.accent,
      photographyStyle: payload.style.photographyStyle,
      styleRefinement: payload.style.styleRefinement || null,
      moodTags: payload.style.moodTags,
      compositionNotes: payload.style.compositionNotes || null,
      backgroundTone: payload.style.backgroundTone,
      alwaysAvoid: payload.style.alwaysAvoid,
      ...(payload.layouts
        ? { layoutTemplates: payload.layouts as never }
        : {}),
    };
    await prisma.brandVisualIdentity.upsert({
      where: { brandId: access.defaultBrandId },
      create: { ...scope, ...identity },
      update: identity,
    });

    // The site address, when it is one we can store.
    let domain: string | null = null;
    if (payload.url) {
      let host: string | null = null;
      try {
        host = new URL(/^[a-z]+:\/\//i.test(payload.url) ? payload.url : `https://${payload.url}`).hostname;
      } catch {
        host = null;
      }
      if (host && isValidDomain(host)) {
        domain = normalizeDomain(host);
        await prisma.project.update({ where: { id: projectId }, data: { domain } });
      }
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_scan.applied",
      entityType: "BrandVisualIdentity",
      entityId: access.defaultBrandId,
      metadata: { logoReplaced: Boolean(logoAssetId), logoSlot, domain },
    }).catch(() => undefined);

    revalidatePath(`/projects/${projectId}`);
    return { ok: true, logoSaved: Boolean(logoAssetId), logoSlot, domain };
  } catch (error) {
    console.error("[brand-scan] apply failed:", error);
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save the brand identity",
    };
  }
}
