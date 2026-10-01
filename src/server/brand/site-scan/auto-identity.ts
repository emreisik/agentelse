import "server-only";

import { isValidDomain, normalizeDomain } from "@/lib/domain";
import { parseColorSwatches, parseFontNames } from "@/lib/color-swatches";
import { prisma } from "@/lib/prisma";
import { safeModelList, safeModelText } from "@/lib/safe-model-text";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { putAsset } from "@/server/storage/asset-storage";

import { analyzeLogo, prepareLogo } from "./image-colors";
import { type ScanScope, type SiteScanResult, scanWebsite } from "./scan";

// Brand identity from the website, without anyone pressing "Scan site": the
// same scan the Brand tab runs, but its result is written straight into the
// brand kit, and ONLY into what is still empty (a logo, colours, fonts or style
// a person already set is never touched). The Brand tab's "Scan site" stays the
// way to look again and choose by hand.
//
// Nothing the page or the model wrote is trusted: colours are re-checked as
// hex, enums against their lists, every free text passes the same hostile-text
// filter as the dossier suggestion (dropped whole when it carries a link, a
// marker or an instruction), and the logo is decoded and re-encoded.

export const IDENTITY_PARTS = ["logo", "colors", "fonts", "style"] as const;
export type IdentityPart = (typeof IDENTITY_PARTS)[number];

export const IDENTITY_AUDIT = {
  // WORKSPACE-LEVEL row (no projectId, no brandId; the project id rides in
  // entityId): project deletion must not erase what the caps count.
  started: "brand_scan.auto_started",
  filled: "brand_scan.autofilled",
} as const;

// Ceilings on automatic scans per 24 hours. One scan is about one cent to four.
export const IDENTITY_CAPS = {
  perUserPer24h: 10,
  perWorkspacePer24h: 20,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

export type IdentityFillStatus =
  | "FILLED"
  | "NOTHING_TO_FILL"
  | "SKIPPED"
  | "LIMIT"
  | "ALREADY_TRIED"
  | "FAILED";

export type IdentityFillResult = {
  status: IdentityFillStatus;
  filled: IdentityPart[];
};

const PHOTOGRAPHY_STYLES = [
  "PHOTOGRAPHIC",
  "ILLUSTRATED",
  "THREE_D_RENDER",
  "FLAT_DESIGN",
  "MIXED",
] as const;
const BACKGROUND_TONES = [
  "LIGHT",
  "DARK",
  "BRAND_COLORED",
  "NO_PREFERENCE",
] as const;
type PhotographyStyle = (typeof PHOTOGRAPHY_STYLES)[number];
type BackgroundTone = (typeof BACKGROUND_TONES)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_LOGO_BYTES = 1_500_000;

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

type Swatch = { hex: string; name?: string };

function cleanSwatches(raw: Swatch[], limit: number): Swatch[] {
  const out: Swatch[] = [];
  const seen = new Set<string>();
  for (const swatch of raw) {
    if (!HEX.test(swatch.hex)) continue;
    const key = swatch.hex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = safeModelText(swatch.name, 40);
    out.push(name ? { hex: swatch.hex, name } : { hex: swatch.hex });
    if (out.length >= limit) break;
  }
  return out;
}

function decodeLogo(dataUrl: string): Buffer | null {
  const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[1]!, "base64");
  return buffer.length > 0 && buffer.length <= MAX_LOGO_BYTES ? buffer : null;
}

type Existing = {
  dossier: {
    logoAssetId: string | null;
    darkLogoAssetId: string | null;
    approvedFonts: unknown;
  } | null;
  identity: {
    primaryColors: unknown;
    secondaryColors: unknown;
    accentColors: unknown;
    photographyStyle: string | null;
    styleRefinement: string | null;
    moodTags: string[];
    compositionNotes: string | null;
    backgroundTone: string | null;
    alwaysAvoid: string[];
  } | null;
};

// What the scan is still allowed to fill.
export function emptyIdentityParts(existing: Existing): IdentityPart[] {
  const { dossier, identity } = existing;
  const out: IdentityPart[] = [];
  if (!dossier?.logoAssetId && !dossier?.darkLogoAssetId) out.push("logo");
  const colours =
    parseColorSwatches(identity?.primaryColors).length +
    parseColorSwatches(identity?.secondaryColors).length +
    parseColorSwatches(identity?.accentColors).length;
  if (colours === 0) out.push("colors");
  if (parseFontNames(dossier?.approvedFonts).length === 0) out.push("fonts");
  if (
    isBlank(identity?.photographyStyle) ||
    isBlank(identity?.backgroundTone) ||
    isBlank(identity?.styleRefinement) ||
    isBlank(identity?.compositionNotes) ||
    isBlank(identity?.moodTags) ||
    isBlank(identity?.alwaysAvoid)
  ) {
    out.push("style");
  }
  return out;
}

type IdentityWrite = {
  primaryColors?: Swatch[];
  secondaryColors?: Swatch[];
  accentColors?: Swatch[];
  photographyStyle?: PhotographyStyle;
  backgroundTone?: BackgroundTone;
  styleRefinement?: string;
  compositionNotes?: string;
  moodTags?: string[];
  alwaysAvoid?: string[];
};

// What would be written for the visual identity: cleaned, and only into the
// fields that are empty now.
export function identityWriteFrom(
  scan: SiteScanResult,
  existing: Existing["identity"],
  fillable: ReadonlySet<IdentityPart>,
): { write: IdentityWrite; parts: IdentityPart[] } {
  const write: IdentityWrite = {};
  const parts = new Set<IdentityPart>();

  if (fillable.has("colors")) {
    const primary = cleanSwatches(scan.colors.primary, 3);
    const secondary = cleanSwatches(scan.colors.secondary, 3);
    const accent = cleanSwatches(scan.colors.accent, 2);
    if (primary.length + secondary.length + accent.length > 0) {
      write.primaryColors = primary;
      write.secondaryColors = secondary;
      write.accentColors = accent;
      parts.add("colors");
    }
  }

  if (fillable.has("style")) {
    const style = scan.style;
    if (
      isBlank(existing?.photographyStyle) &&
      (PHOTOGRAPHY_STYLES as readonly string[]).includes(style.photographyStyle)
    ) {
      write.photographyStyle = style.photographyStyle;
    }
    if (
      isBlank(existing?.backgroundTone) &&
      (BACKGROUND_TONES as readonly string[]).includes(style.backgroundTone)
    ) {
      write.backgroundTone = style.backgroundTone;
    }
    if (isBlank(existing?.styleRefinement)) {
      const text = safeModelText(style.styleRefinement, 400);
      if (text) write.styleRefinement = text;
    }
    if (isBlank(existing?.compositionNotes)) {
      const text = safeModelText(style.compositionNotes, 300);
      if (text) write.compositionNotes = text;
    }
    if (isBlank(existing?.moodTags)) {
      const tags = safeModelList(style.moodTags, 30, 6);
      if (tags.length > 0) write.moodTags = tags;
    }
    if (isBlank(existing?.alwaysAvoid)) {
      const avoid = safeModelList(style.alwaysAvoid, 80, 5);
      if (avoid.length > 0) write.alwaysAvoid = avoid;
    }
    if (
      write.photographyStyle ||
      write.backgroundTone ||
      write.styleRefinement ||
      write.compositionNotes ||
      write.moodTags ||
      write.alwaysAvoid
    ) {
      parts.add("style");
    }
  }
  return { write, parts: [...parts] };
}

export type IdentityDeps = {
  scan?: typeof scanWebsite;
  nowMs?: () => number;
};

export async function autoFillBrandIdentity(
  scope: ScanScope,
  input: { domain: string; userId: string },
  deps: IdentityDeps = {},
): Promise<IdentityFillResult> {
  // A mock model would put invented style notes into a real brand kit.
  if (ReasoningService.isMockMode()) return { status: "SKIPPED", filled: [] };
  if (!isValidDomain(input.domain)) return { status: "SKIPPED", filled: [] };
  const host = normalizeDomain(input.domain);

  const [dossier, identity] = await Promise.all([
    prisma.brandDossier.findUnique({
      where: { brandId: scope.brandId },
      select: { logoAssetId: true, darkLogoAssetId: true, approvedFonts: true },
    }),
    prisma.brandVisualIdentity.findUnique({
      where: { brandId: scope.brandId },
      select: {
        primaryColors: true,
        secondaryColors: true,
        accentColors: true,
        photographyStyle: true,
        styleRefinement: true,
        moodTags: true,
        compositionNotes: true,
        backgroundTone: true,
        alwaysAvoid: true,
      },
    }),
  ]);
  const existing: Existing = { dossier, identity };

  // Nothing to fill: no scan, no cost.
  const fillable = new Set(emptyIdentityParts(existing));
  if (fillable.size === 0) return { status: "NOTHING_TO_FILL", filled: [] };

  // The caps count workspace-level rows; a project scans automatically once.
  const since = new Date((deps.nowMs ?? Date.now)() - IDENTITY_CAPS.windowMs);
  const [already, byUser, byWorkspace] = await Promise.all([
    prisma.auditLog.count({
      where: {
        workspaceId: scope.workspaceId,
        action: IDENTITY_AUDIT.started,
        entityId: scope.projectId,
      },
    }),
    prisma.auditLog.count({
      where: {
        workspaceId: scope.workspaceId,
        actorId: input.userId,
        action: IDENTITY_AUDIT.started,
        createdAt: { gte: since },
      },
    }),
    prisma.auditLog.count({
      where: {
        workspaceId: scope.workspaceId,
        action: IDENTITY_AUDIT.started,
        createdAt: { gte: since },
      },
    }),
  ]);
  if (already > 0) return { status: "ALREADY_TRIED", filled: [] };
  if (
    byUser >= IDENTITY_CAPS.perUserPer24h ||
    byWorkspace >= IDENTITY_CAPS.perWorkspacePer24h
  ) {
    return { status: "LIMIT", filled: [] };
  }
  // Counted before the scan: a failing scan is an attempt too.
  await AuditLogRepository.record({
    workspaceId: scope.workspaceId,
    actorType: "USER",
    actorId: input.userId,
    action: IDENTITY_AUDIT.started,
    entityType: "Project",
    entityId: scope.projectId,
    metadata: { host },
  });

  let scan: SiteScanResult;
  try {
    scan = await (deps.scan ?? scanWebsite)(host, scope);
  } catch (error) {
    console.error(
      "[brand-identity] scan failed:",
      error instanceof Error ? error.message : error,
    );
    return { status: "FAILED", filled: [] };
  }

  const filled = new Set<IdentityPart>();

  // Logo: a real logo only (an icon or a social image is not one), decoded and
  // re-encoded, stored in the slot its own pixels call for.
  let logoAssetId: string | null = null;
  let logoSlot: "light" | "dark" | null = null;
  if (fillable.has("logo") && scan.logo && !scan.logo.fallback) {
    try {
      const raw = decodeLogo(scan.logo.dataUrl);
      const prepared = raw ? await prepareLogo(raw) : null;
      if (prepared) {
        logoSlot = (await analyzeLogo(prepared.png)).tone;
        const { storageKey, filename } = await putAsset(
          prepared.png,
          "png",
          "image/png",
        );
        const asset = await prisma.asset.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            brandId: scope.brandId,
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
    } catch (error) {
      console.error(
        "[brand-identity] logo not saved:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const fonts = fillable.has("fonts") ? safeModelList(scan.fonts, 60, 8) : [];

  // Read again right before writing: a person may have set something while the
  // scan ran. Whatever is no longer empty is left alone.
  const [dossierNow, identityNow] = await Promise.all([
    prisma.brandDossier.findUnique({
      where: { brandId: scope.brandId },
      select: { logoAssetId: true, darkLogoAssetId: true, approvedFonts: true },
    }),
    prisma.brandVisualIdentity.findUnique({
      where: { brandId: scope.brandId },
      select: {
        primaryColors: true,
        secondaryColors: true,
        accentColors: true,
        photographyStyle: true,
        styleRefinement: true,
        moodTags: true,
        compositionNotes: true,
        backgroundTone: true,
        alwaysAvoid: true,
      },
    }),
  ]);
  const stillEmpty = new Set(
    emptyIdentityParts({ dossier: dossierNow, identity: identityNow }),
  );

  const dossierWrite: Record<string, unknown> = {};
  if (logoAssetId && stillEmpty.has("logo")) {
    dossierWrite[logoSlot === "light" ? "logoAssetId" : "darkLogoAssetId"] =
      logoAssetId;
    filled.add("logo");
  }
  if (fonts.length > 0 && stillEmpty.has("fonts")) {
    dossierWrite.approvedFonts = fonts;
    filled.add("fonts");
  }
  if (Object.keys(dossierWrite).length > 0) {
    await prisma.brandDossier.upsert({
      where: { brandId: scope.brandId },
      create: { ...scope, ...dossierWrite },
      update: dossierWrite,
    });
  }

  const { write, parts } = identityWriteFrom(
    scan,
    identityNow,
    new Set(
      [...stillEmpty].filter((part) => part === "colors" || part === "style"),
    ),
  );
  if (parts.length > 0) {
    await prisma.brandVisualIdentity.upsert({
      where: { brandId: scope.brandId },
      create: { ...scope, ...write },
      update: write,
    });
    for (const part of parts) filled.add(part);
  }

  if (filled.size === 0) return { status: "NOTHING_TO_FILL", filled: [] };

  const done = IDENTITY_PARTS.filter((part) => filled.has(part));
  await AuditLogRepository.record({
    ...scope,
    actorType: "USER",
    actorId: input.userId,
    action: IDENTITY_AUDIT.filled,
    entityType: "BrandVisualIdentity",
    entityId: scope.brandId,
    metadata: { source: "website_scan", host, parts: done, logoSlot },
  });
  return { status: "FILLED", filled: done };
}
