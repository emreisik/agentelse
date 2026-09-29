"use server";

import { revalidatePath } from "next/cache";

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
