"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/components/shared/action-form";
import { prisma } from "@/lib/prisma";
import { gaBigQueryEnabledFor } from "@/lib/website-analytics/agency/flags";
import { defaultExportDataset } from "@/lib/website-analytics/bigquery/config";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  removeBigQuerySource,
  requestBigQueryRefresh,
} from "@/server/website-analytics/bigquery/store";
import { verifyAndSaveBigQuerySource } from "@/server/website-analytics/bigquery/verify";

// GA4 BigQuery dışa aktarımı eylemleri (GA-F8, docs/website-agency.md): kaydet, kaldır,
// yenile. Yalnız OWNER/ADMIN; proje erişimi ve gaBigQueryEnabledFor(projectId) (geliştirme
// izin listesi dahil) denetlenir. Veri kümesi adı kullanıcı alanı DEĞİLDİR: mülk
// kimliğinden hesaplanır; ikinci bir proje alanı (faturalama projesi) kabul edilmez,
// formdaki fazladan alanlar hiç okunmaz. Hiç fırlatmaz; hata metni istemciye aynen gitmez.

const MANAGERS_ONLY = "Only workspace owners and admins can change this.";
const OFF = "BigQuery export isn't available for this project.";
const NO_LINK = "Google Analytics isn't connected for this property.";
const NOT_SET_UP = "BigQuery isn't set up for this property.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";

function failure(error: unknown, fallback: string): ActionResult {
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
    "[ga-bigquery] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

type Gate =
  | { ok: true; userId: string; projectId: string; linkId: string }
  | { ok: false; result: ActionResult };

// Ortak kapı: oturum, proje erişimi, OWNER/ADMIN, bayrak + geliştirme koruması.
async function gate(formData: FormData): Promise<Gate> {
  const projectId = field(formData, "projectId");
  const linkId = field(formData, "linkId");
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (!(await isWorkspaceManager(userId, access.workspaceId))) {
    return { ok: false, result: { ok: false, message: MANAGERS_ONLY } };
  }
  if (!gaBigQueryEnabledFor(projectId)) {
    return { ok: false, result: { ok: false, message: OFF } };
  }
  if (!linkId) return { ok: false, result: { ok: false, message: NO_LINK } };
  return { ok: true, userId, projectId, linkId };
}

export async function saveBigQuerySourceAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const guard = await gate(formData);
    if (!guard.ok) return guard.result;
    const gcpProjectId = field(formData, "gcpProjectId");
    const location = field(formData, "location");

    // Veri kümesi adı mülk kimliğinden türetilir (bağlama kuralı); formdaki
    // datasetId / billingProjectId gibi alanlar hiç okunmaz.
    const link = await prisma.gaPropertyLink.findFirst({
      where: { id: guard.linkId, projectId: guard.projectId },
      select: { propertyId: true },
    });
    if (!link) return { ok: false, message: NO_LINK };

    const result = await verifyAndSaveBigQuerySource({
      projectId: guard.projectId,
      linkId: guard.linkId,
      userId: guard.userId,
      config: {
        gcpProjectId,
        datasetId: defaultExportDataset(link.propertyId),
        ...(location ? { location } : {}),
      },
    });
    if (!result.ok) return { ok: false, message: result.message };
    revalidatePath(`/projects/${guard.projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the BigQuery export.");
  }
}

export async function removeBigQuerySourceAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const guard = await gate(formData);
    if (!guard.ok) return guard.result;
    const result = await removeBigQuerySource({
      projectId: guard.projectId,
      linkId: guard.linkId,
      userId: guard.userId,
    });
    if (result === "not_found") return { ok: false, message: NOT_SET_UP };
    revalidatePath(`/projects/${guard.projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not remove the BigQuery export.");
  }
}

// "Refresh": bir sonraki turda okunsun; son okumadan beri 1 saat geçmediyse reddedilir.
export async function refreshBigQuerySourceAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const guard = await gate(formData);
    if (!guard.ok) return guard.result;
    const result = await requestBigQueryRefresh({
      projectId: guard.projectId,
      linkId: guard.linkId,
    });
    if (result === "not_found") return { ok: false, message: NOT_SET_UP };
    if (result === "throttled") {
      return { ok: false, message: "Already refreshed recently." };
    }
    revalidatePath(`/projects/${guard.projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not refresh the BigQuery export.");
  }
}
