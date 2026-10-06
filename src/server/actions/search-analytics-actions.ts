"use server";

import { revalidatePath } from "next/cache";

import { parseBrandTermsInput } from "@/lib/seo/brand-terms";
import { GscFlags, gscSyncAllowedFor } from "@/lib/seo/flags";
import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { saveBrandTerms } from "@/server/seo/brand-terms";
import { GscRetention } from "@/server/seo/retention";
import { primaryGscLink } from "@/server/seo/store";
import { deleteGscDataForProject } from "@/server/seo/sync/links";
import { GscSync } from "@/server/seo/sync/runner";

// Search Console ambarının eylemleri (SC-F2): Search sayfasındaki Refresh ve
// marka terimleri, Connectors kartındaki arşiv ayarı ve "Delete stored data".
// Hepsi proje erişimini doğrular, açılış listesi dışındaki projeyi reddeder
// (gscSyncAllowedFor) ve hiç fırlatmaz.

export type ActionResult = { ok: true } | { ok: false; message: string };

const NOT_ALLOWED = "Search Console isn't set up for this project here.";
const NOT_CONNECTED = "Search Console isn't connected for this project.";
const MANAGERS_ONLY = "Only workspace owners and admins can change this.";
const NOT_ON = "Search Console data isn't turned on.";

const REFRESH_MESSAGES = {
  throttled: "Updated less than 5 minutes ago. Try again in a few minutes.",
  busy: "An update is already running. Try again in a moment.",
  failed: "The update didn't finish. Try again in a few minutes.",
  unavailable: NOT_CONNECTED,
} as const;

type Access = { userId: string; workspaceId: string; projectId: string };

// Ortak giriş: oturum, proje erişimi, GSC_SYNC ve açılış/geliştirme listesi.
async function access(
  formData: FormData,
): Promise<{ ok: true; access: Access } | { ok: false; message: string }> {
  const projectId = String(formData.get("projectId") ?? "");
  const { userId } = await requireUser();
  const { workspaceId } = await requireProjectAccess(userId, projectId);
  // Bayrak kapalıyken hiçbir yazma eylemi koşmaz (bağ da tembel kurulmaz).
  if (!GscFlags.sync()) return { ok: false, message: NOT_ON };
  if (!gscSyncAllowedFor(projectId)) {
    return { ok: false, message: NOT_ALLOWED };
  }
  return { ok: true, access: { userId, workspaceId, projectId } };
}

function failure(error: unknown, fallback: string): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : fallback,
  };
}

function revalidateSearch(projectId: string) {
  revalidatePath(`/projects/${projectId}/arama`);
  revalidatePath(`/projects/${projectId}/integrations`);
}

// Search sayfasındaki Refresh: son günler Google'dan yeniden çekilir.
export async function refreshSearchAnalyticsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await access(formData);
    if (!gate.ok) return gate;
    const { projectId } = gate.access;
    const result = await GscSync.refreshNow(projectId);
    if (result !== "refreshed") {
      return { ok: false, message: REFRESH_MESSAGES[result] };
    }
    revalidatePath(`/projects/${projectId}/arama`);
    return { ok: true };
  } catch (error) {
    return failure(error, "Refresh failed");
  }
}

// Marka terimleri: sorgular hemen yeniden sınıflanır, günlük marka serisi
// bir sonraki senkronda yeni terimlerle yeniden çekilir.
export async function saveBrandTermsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await access(formData);
    if (!gate.ok) return gate;
    const { userId, workspaceId, projectId } = gate.access;
    const terms = parseBrandTermsInput(String(formData.get("terms") ?? ""));
    const saved = await saveBrandTerms({ projectId, terms });
    if (!saved.ok) {
      return {
        ok: false,
        message:
          saved.reason === "too_long"
            ? "These brand terms are too long together. Remove some or use shorter ones."
            : NOT_CONNECTED,
      };
    }
    await AuditLogRepository.record({
      workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "search_console.brand_terms_updated",
      entityType: "GscSiteLink",
      entityId: projectId,
      metadata: { terms: saved.terms.length },
    });
    revalidateSearch(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "Brand terms could not be saved");
  }
}

// SK3 arşivi: kapatılınca Google'ın 16 ayından eski her şey hemen silinir.
// Bütün ekibi etkiler; yalnız OWNER/ADMIN.
export async function setSearchArchiveAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await access(formData);
    if (!gate.ok) return gate;
    const { userId, workspaceId, projectId } = gate.access;
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    const archive = String(formData.get("archive") ?? "") === "true";
    const link = await primaryGscLink(projectId);
    if (!link) return { ok: false, message: NOT_CONNECTED };
    await prisma.gscSiteLink.update({
      where: { id: link.id },
      data: { archive },
    });
    if (!archive) await GscRetention.pruneLink(link.id);
    await AuditLogRepository.record({
      workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "search_console.archive_updated",
      entityType: "GscSiteLink",
      entityId: link.id,
      metadata: { archive },
    });
    revalidateSearch(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The setting could not be saved");
  }
}

// "Delete stored data": projenin bütün Search Console ambarı silinir, bağ
// aynı arşiv ayarı ve marka terimleriyle yeniden kurulur; son 16 ay
// Google'dan yeniden yüklenir. Yalnız OWNER/ADMIN.
export async function deleteSearchDataAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await access(formData);
    if (!gate.ok) return gate;
    const { userId, workspaceId, projectId } = gate.access;
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    const { deletedLinks } = await deleteGscDataForProject(projectId);
    await AuditLogRepository.record({
      workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "search_console.data_deleted",
      entityType: "GscSiteLink",
      entityId: projectId,
      metadata: { deletedLinks },
    });
    revalidateSearch(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "Stored data could not be deleted");
  }
}
