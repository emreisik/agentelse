"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { seoGeoEnabledFor } from "@/lib/seo/apply/flags";
import { isAcknowledgeable } from "@/lib/seo/geo/types";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { SeoGeo } from "@/server/seo/geo/runner";
import { setAcknowledged } from "@/server/seo/geo/store";

// Search sayfasındaki "AI search visibility" bölümünün eylemleri (SC-F8,
// docs/ai-search-visibility.md): "Check again" ve "I decided this". Sıra:
// oturum, proje erişimi, girdi doğrulama, bayrak/izin listesi, (kabul için)
// OWNER/ADMIN. Mesajlar sabit İngilizcedir; hata ayrıntısı istemciye gitmez.

export type ActionResult =
  { ok: true; message?: string } | { ok: false; message: string };

const NOT_AVAILABLE = "AI search visibility is not available for this project.";
const MANAGERS_ONLY = "Only workspace owners and admins can change this.";
const INVALID = "Something is missing. Reload the page and try again.";
const NOTHING_TO_UPDATE = "Run a check first, then try again.";
const FAILED = "That did not work. Try again later.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";

const ProjectSchema = z.object({ projectId: z.string().trim().min(1).max(64) });
const AckSchema = ProjectSchema.extend({
  checkId: z.string().refine(isAcknowledgeable),
  on: z.enum(["true", "false"]),
});

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function revalidateSearch(projectId: string) {
  revalidatePath(`/projects/${projectId}/arama`);
}

function failure(error: unknown): ActionResult {
  if (isAgentelseError(error)) {
    if (error.code === "LOGIN_REQUIRED" || error.code === "SESSION_EXPIRED") {
      return { ok: false, message: SIGN_IN_AGAIN };
    }
    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "NOT_FOUND" ||
      error.code === "PROJECT_MISMATCH"
    ) {
      return { ok: false, message: PROJECT_UNAVAILABLE };
    }
  }
  console.error(
    "[seo-geo] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: FAILED };
}

// "Check again": en az 6 saat arayla; her proje üyesi çalıştırabilir.
export async function auditGeoNowAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    const parsed = ProjectSchema.safeParse({ projectId });
    if (!parsed.success) return { ok: false, message: INVALID };
    if (!seoGeoEnabledFor(projectId)) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    const outcome = await SeoGeo.auditNow({ projectId, userId });
    if (!outcome.ok) return { ok: false, message: outcome.message };
    revalidateSearch(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

// "I decided this": yalnız GEO2 ve GEO9, yalnız OWNER/ADMIN. Puan yeni denetim
// olmadan rescore ile yeniden hesaplanır.
export async function acknowledgeGeoCheckAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    const parsed = AckSchema.safeParse({
      projectId,
      checkId: field(formData, "checkId"),
      on: field(formData, "on"),
    });
    if (!parsed.success || !isAcknowledgeable(parsed.data.checkId)) {
      return { ok: false, message: INVALID };
    }
    if (!seoGeoEnabledFor(projectId)) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    const on = parsed.data.on === "true";
    const outcome = await setAcknowledged(projectId, parsed.data.checkId, on);
    if (!outcome.ok) return { ok: false, message: NOTHING_TO_UPDATE };
    await AuditLogRepository.record({
      workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: on ? "seo_geo.check_acknowledged" : "seo_geo.check_unacknowledged",
      entityType: "SeoGeoAudit",
      entityId: projectId,
      metadata: { checkId: parsed.data.checkId },
    });
    revalidateSearch(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
