"use server";

import { revalidatePath } from "next/cache";

import { isRateLimited } from "@/lib/rate-limit";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import { reportShareOn } from "@/lib/report-share/flags";
import { REPORT_SHARE_DAYS } from "@/lib/report-share/types";
import { AgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  createWebsiteReportShare,
  revokeWebsiteReportShare,
} from "@/server/website-analytics/agency/share";

export type ActionResult = { ok: true } | { ok: false; message: string };

export type CreateWebsiteShareResult =
  | { ok: true; url: string; expiresAt: string }
  | { ok: false; message: string };

// GA-F8: müşteri bağlantısı (white-label paylaşım) oluşturma ve iptal. Yalnız
// workspace OWNER/ADMIN. Hepsi {ok:false,message} döner, fırlatmaz; mesajlar
// sabittir. Adres yalnız bu yanıtta döner, hiçbir yerde saklanmaz.

const NOT_AVAILABLE = "Client links aren't available right now.";
const MANAGER_ONLY = "Only a workspace owner or admin can share reports.";
const NOT_CONFIRMED =
  "Confirm that anyone with the link can see this report.";
const BAD_DAYS = "Choose how long the link should work.";
const RATE_LIMITED = "Too many links created. Try again in a while.";
const LIMIT_MESSAGE =
  "This project already has the maximum number of active client links. Revoke one first.";
const BAD_REPORT = "This report can't be shared.";
const GENERIC = "Something went wrong. Try again.";
const REVOKE_FAILED = "This link was already revoked or no longer exists.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function failure(error: unknown): { ok: false; message: string } {
  return {
    ok: false,
    message: error instanceof AgentelseError ? error.message : GENERIC,
  };
}

function isShareDays(days: number): boolean {
  return (REPORT_SHARE_DAYS as readonly number[]).includes(days);
}

export async function createWebsiteReportShareAction(
  formData: FormData,
): Promise<CreateWebsiteShareResult> {
  try {
    const projectId = field(formData, "projectId");
    const commandId = field(formData, "commandId");
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGER_ONLY };
    }
    if (!gaAgencyEnabledFor(projectId) || !reportShareOn()) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    if (field(formData, "confirm") !== "on") {
      return { ok: false, message: NOT_CONFIRMED };
    }
    const days = Number(field(formData, "days"));
    if (!isShareDays(days)) return { ok: false, message: BAD_DAYS };
    if (isRateLimited(`share-create:${userId}`, 20, 3_600_000)) {
      return { ok: false, message: RATE_LIMITED };
    }
    const result = await createWebsiteReportShare({
      workspaceId,
      projectId,
      userId,
      commandId,
      days,
      confirmPublic: true,
    });
    if (!result.ok) {
      switch (result.reason) {
        case "limit":
          return { ok: false, message: LIMIT_MESSAGE };
        case "bad_report":
          return { ok: false, message: BAD_REPORT };
        case "bad_days":
          return { ok: false, message: BAD_DAYS };
        case "not_confirmed":
          return { ok: false, message: NOT_CONFIRMED };
        case "off":
          return { ok: false, message: NOT_AVAILABLE };
      }
    }
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true, url: result.url, expiresAt: result.expiresAt };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeWebsiteReportShareAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const shareId = field(formData, "shareId");
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGER_ONLY };
    }
    if (!gaAgencyEnabledFor(projectId) || !reportShareOn()) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    if (!shareId) return { ok: false, message: REVOKE_FAILED };
    const revoked = await revokeWebsiteReportShare({
      projectId,
      shareId,
      userId,
    });
    if (!revoked) return { ok: false, message: REVOKE_FAILED };
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
