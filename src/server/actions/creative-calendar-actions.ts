"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import type { ActionResult } from "@/server/actions/agency-config-actions";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The content calendar's only write path (spec: takvim) — assigns or
// clears which calendar day a creative is planned to publish on. A plain
// date column update, deliberately separate from creative-actions.ts
// (image generation/revision) and approval-actions.ts (approve/reject):
// this action never touches status, versions, or the approval pipeline,
// it only ever moves a creative between days (or back to "Unscheduled"
// when date is empty).
export async function assignCreativeDateAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const creativeId = String(formData.get("creativeId") ?? "");
    const dateRaw = String(formData.get("date") ?? "").trim();
    if (!creativeId) {
      return { ok: false, message: "Missing creative." };
    }
    if (dateRaw && !DATE_RE.test(dateRaw)) {
      return { ok: false, message: "Invalid date." };
    }

    const creative = await prisma.creative.findUnique({
      where: { id: creativeId },
      select: { projectId: true, workspaceId: true, brandId: true },
    });
    if (!creative) {
      return { ok: false, message: "Creative not found." };
    }

    const { userId } = await requireUser();
    await requireProjectAccess(userId, creative.projectId);

    // A bare "YYYY-MM-DD" string parses as UTC midnight — exactly what the
    // @db.Date column stores (see schema comment: date-only, no time/TZ
    // component to get wrong).
    const date = dateRaw ? new Date(dateRaw) : null;
    const { count } = await CreativeRepository.setScheduledFor(
      creativeId,
      creative.projectId,
      date,
    );
    if (count === 0) {
      return { ok: false, message: "Creative not found in this project." };
    }

    await AuditLogRepository.record({
      workspaceId: creative.workspaceId,
      projectId: creative.projectId,
      brandId: creative.brandId,
      actorType: "USER",
      actorId: userId,
      action: date ? "creative.scheduled" : "creative.unscheduled",
      entityType: "Creative",
      entityId: creativeId,
    });

    revalidatePath(`/projects/${creative.projectId}/takvim`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
