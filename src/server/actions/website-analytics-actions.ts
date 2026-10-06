"use server";

import { revalidatePath } from "next/cache";

import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { GaSync } from "@/server/website-analytics/sync/runner";

export type ActionResult = { ok: true } | { ok: false; message: string };

const REFRESH_MESSAGES = {
  throttled: "Updated less than 5 minutes ago. Try again in a few minutes.",
  busy: "An update is already running. Try again in a moment.",
  unavailable: "Google Analytics isn't connected for this project.",
} as const;

// "Website" sayfasındaki Refresh (P1): son 7 gün Google'dan yeniden çekilir.
export async function refreshWebsiteAnalyticsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    const result = await GaSync.refreshNow(projectId);
    if (result !== "refreshed") {
      return { ok: false, message: REFRESH_MESSAGES[result] };
    }
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Refresh failed",
    };
  }
}
