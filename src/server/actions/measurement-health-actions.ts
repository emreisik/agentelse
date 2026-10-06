"use server";

import { revalidatePath } from "next/cache";

import { gaSyncAllowedFor } from "@/lib/website-analytics/flags";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";

import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { GaHealth } from "@/server/website-analytics/health/runner";

export type ActionResult = { ok: true } | { ok: false; message: string };

const RECHECK_MESSAGES = {
  throttled: "Checked a few minutes ago. Try again in a few minutes.",
  busy: "A check is already running. Try again in a moment.",
  failed: "The check could not finish. We'll retry automatically.",
  unavailable: "Google Analytics isn't connected for this project.",
} as const;

const MUTE_DAYS = 7;

// "Check again" / "I fixed it" (Website sayfası, Measurement health):
// zorlamalı yeniden değerlendirme, bağ başına 10 dakikada bir.
export async function recheckMeasurementHealthAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    const result = await GaHealth.recheckNow(projectId);
    if (result !== "rechecked") {
      return { ok: false, message: RECHECK_MESSAGES[result] };
    }
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Check failed",
    };
  }
}

// "Mute 7 days": yalnız bu projenin GA4 ölçüm uyarıları; GSC/SEO uyarıları
// Search sayfasının kendi (denetimli) akışında susturulur. GA_HEALTH kapalıyken
// ya da proje yerel izin listesinde değilken yazım yok.
export async function muteMeasurementAlertAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const alertId = String(formData.get("alertId") ?? "");
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    if (!gaHealthEnabled() || !gaSyncAllowedFor(projectId)) {
      return {
        ok: false,
        message: "Google Analytics isn't connected for this project.",
      };
    }
    if (!alertId) return { ok: false, message: "Alert not found." };
    await SiteAlerts.mute(alertId, projectId, MUTE_DAYS, "GA4");
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Mute failed",
    };
  }
}
