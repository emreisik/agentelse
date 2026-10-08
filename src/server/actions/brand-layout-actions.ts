"use server";

import { revalidatePath } from "next/cache";

import { Prisma } from "@prisma/client";

import { isArchetype } from "@/lib/auto-layout";
import {
  DESIGN_FORMATS,
  parseDesignProfile,
  withDesign,
  type DesignFormat,
} from "@/lib/design-profile";
import { prisma } from "@/lib/prisma";
import { LayoutTemplatesSchema } from "@/lib/layout-templates";
import type { ActionResult } from "@/server/actions/agency-config-actions";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Saves the brand's named post layouts (src/lib/layout-templates.ts). The
// layout editor sends the whole set; the payload comes from the browser, so
// it is validated here as untrusted input (geometry ranges, ids, colours, a
// real default) and the brand is always taken from the project the caller
// can access, never from the payload.
export async function updateLayoutTemplatesAction(
  projectId: string,
  rawLayouts: unknown,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const parsed = LayoutTemplatesSchema.safeParse(rawLayouts);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        message: `Invalid layout: ${issue?.path.join(".") || "layouts"} ${issue?.message ?? ""}`.trim(),
      };
    }
    const layouts = parsed.data;

    await prisma.brandVisualIdentity.upsert({
      where: { brandId: access.defaultBrandId },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        layoutTemplates: layouts as never,
      },
      update: { layoutTemplates: layouts as never },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_layouts.updated",
      entityType: "BrandVisualIdentity",
      entityId: access.defaultBrandId,
      metadata: { count: layouts.items.length, defaultId: layouts.defaultId },
    }).catch(() => undefined);

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save layouts",
    };
  }
}

// The one setting of the automatic post design: which design each post format
// takes. `format` is one format or "all"; `archetype` null takes that format (or
// all of them) back to what the brand's words point to. The design is validated
// here, the brand always comes from the project the caller can access.
export async function updateDesignLookAction(
  projectId: string,
  format: DesignFormat | "all",
  archetype: string | null,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    if (format !== "all" && !DESIGN_FORMATS.includes(format)) {
      return { ok: false, message: "Unknown format" };
    }
    if (archetype !== null && !isArchetype(archetype)) {
      return { ok: false, message: "Unknown design" };
    }

    // Read and written back together, so a change to one format keeps the rest.
    const current = await prisma.brandVisualIdentity.findUnique({
      where: { brandId: access.defaultBrandId },
      select: { designProfile: true },
    });
    const next = withDesign(
      parseDesignProfile(current?.designProfile),
      format,
      archetype,
    );
    const designProfile = next ?? Prisma.DbNull;

    await prisma.brandVisualIdentity.upsert({
      where: { brandId: access.defaultBrandId },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        designProfile,
      },
      update: { designProfile },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_design_look.updated",
      entityType: "BrandVisualIdentity",
      entityId: access.defaultBrandId,
      metadata: { format, archetype },
    }).catch(() => undefined);

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save the design",
    };
  }
}

// Drops the brand's saved custom layouts, so its posts follow the automatic
// designs again. The layouts themselves are not kept: they were the brand's own
// to make, and this is the explicit way back.
export async function clearLayoutTemplatesAction(
  projectId: string,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await prisma.brandVisualIdentity.updateMany({
      where: { brandId: access.defaultBrandId },
      data: { layoutTemplates: Prisma.DbNull },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_layouts.cleared",
      entityType: "BrandVisualIdentity",
      entityId: access.defaultBrandId,
    }).catch(() => undefined);

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not clear the layouts",
    };
  }
}
