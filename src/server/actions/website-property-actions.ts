"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/components/shared/action-form";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  addExtraGaProperty,
  makeGaPropertyMain,
  removeExtraGaProperty,
  type PropertyChangeResult,
} from "@/server/website-analytics/agency/properties";

// Çoklu GA mülkü eylemleri (GA-F8): ekle, kaldır, ana mülk yap. OWNER/ADMIN;
// GA_AGENCY ve proje izin listesi gerekir. Denetim kaydı properties.ts'te
// yazılır (yalnız kimlikler). Hiç fırlatmaz; hata metni istemciye aynen
// gitmez.

const MANAGERS_ONLY = "Only workspace owners and admins can change this.";
const UNAVAILABLE = "Multiple properties aren't available for this project.";

const MESSAGES: Record<Exclude<PropertyChangeResult, "ok">, string> = {
  off: UNAVAILABLE,
  not_connected: "Google Analytics isn't connected for this project.",
  not_accessible: "This Google account can't see that property.",
  already_linked: "That property is already linked.",
  limit: "You can add up to 4 extra properties.",
  not_found: "Property not found.",
  is_main: "That is already the main property.",
};

function failure(error: unknown): ActionResult {
  if (isAgentelseError(error)) {
    if (error.code === "LOGIN_REQUIRED" || error.code === "SESSION_EXPIRED") {
      return { ok: false, message: "Please sign in again." };
    }
    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "NOT_FOUND" ||
      error.code === "PROJECT_MISMATCH"
    ) {
      return { ok: false, message: "This project isn't available." };
    }
  }
  console.error(
    "[website-properties] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: "The change could not be saved." };
}

async function run(
  formData: FormData,
  change: (input: {
    projectId: string;
    propertyId: string;
    actorUserId: string;
  }) => Promise<PropertyChangeResult>,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "").trim();
    const propertyId = String(formData.get("propertyId") ?? "").trim();
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    if (!gaAgencyEnabledFor(projectId)) {
      return { ok: false, message: UNAVAILABLE };
    }
    if (!propertyId) return { ok: false, message: MESSAGES.not_found };
    const result = await change({ projectId, propertyId, actorUserId: userId });
    if (result !== "ok") return { ok: false, message: MESSAGES[result] };
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function addGaPropertyAction(
  formData: FormData,
): Promise<ActionResult> {
  return run(formData, addExtraGaProperty);
}

export async function removeGaPropertyAction(
  formData: FormData,
): Promise<ActionResult> {
  return run(formData, removeExtraGaProperty);
}

export async function makeGaPropertyMainAction(
  formData: FormData,
): Promise<ActionResult> {
  return run(formData, makeGaPropertyMain);
}
