"use server";

import { revalidatePath } from "next/cache";

import { LINK_TRACKING_COPY } from "@/lib/tracked-links/copy";
import { parseLinkTrackingForm } from "@/lib/tracked-links/settings";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { saveInstagramBioLink } from "@/server/tracked-links/bio";
import { saveLinkTrackingSettings } from "@/server/tracked-links/settings";

export type ActionResult = { ok: true } | { ok: false; message: string };

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Operation failed",
  };
}

const BIO_FAILURE_MESSAGES = {
  off: LINK_TRACKING_COPY.bioOff,
  invalid: LINK_TRACKING_COPY.invalidUrl,
  no_domain: LINK_TRACKING_COPY.bioNoDomain,
  not_own_site: LINK_TRACKING_COPY.notOwnSite,
} as const;

// Ekibin bütün linklerini etkilediği için yalnız OWNER/ADMIN değiştirir.
export async function updateLinkTrackingAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return { ok: false, message: LINK_TRACKING_COPY.managersOnly };
    }

    const value = parseLinkTrackingForm(formData);
    await saveLinkTrackingSettings({
      workspaceId: access.workspaceId,
      projectId,
      userId,
      value,
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "link_tracking.updated",
      entityType: "LinkTrackingSetting",
      entityId: projectId,
      metadata: { utmEnabled: value.utmEnabled },
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Bio linkini proje üyelerinin hepsi üretebilir (ekip ayarını değiştirmez).
export async function saveInstagramBioLinkAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const destinationUrl = String(formData.get("destinationUrl") ?? "").trim();
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const result = await saveInstagramBioLink({
      workspaceId: access.workspaceId,
      projectId,
      userId,
      destinationUrl,
    });
    if (!result.ok) {
      return { ok: false, message: BIO_FAILURE_MESSAGES[result.reason] };
    }

    // Metadata'ya adres konmaz: yalnız ne tür bir link olduğu.
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "tracked_link.saved",
      entityType: "TrackedLink",
      entityId: result.link.code,
      metadata: { entityType: "instagram_bio" },
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
