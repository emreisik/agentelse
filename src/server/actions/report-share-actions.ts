"use server";

import { revalidatePath } from "next/cache";

import { isRateLimited } from "@/lib/rate-limit";
import { validateBrandingInput } from "@/lib/report-share/branding";
import { reportShareOn } from "@/lib/report-share/flags";
import { REPORT_SHARE_DAYS } from "@/lib/report-share/types";
import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import { appUrl } from "@/lib/app-url";
import { ReportBrandings } from "@/server/report-share/branding";
import { ReportShares } from "@/server/report-share/store";
import { AgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { readSeoReportView } from "@/server/seo/reports/store";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Beyaz etiket marka ayarı ve SEARCH rapor bağlantıları (SC-F9). Hepsi
// {ok:false,message} döner, fırlatmaz; mesajlar sabittir. Yalnız workspace
// OWNER/ADMIN. Bağlantı adresi yalnız createReportShareAction yanıtında
// vardır; saklanmaz ve günlüğe yazılmaz. Denetim kayıtları kimlik ve tür taşır.

const NOT_AVAILABLE = "Client links aren't available right now.";
const MANAGER_ONLY = "Only a workspace owner or admin can change this.";
const NOT_CONFIRMED = "Confirm that anyone with the link can see this report.";
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

export async function saveReportBrandingAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const { workspaceId } = await requireWorkspaceMembership(userId);
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGER_ONLY };
    }
    if (!reportShareOn()) return { ok: false, message: NOT_AVAILABLE };
    const parsed = validateBrandingInput({
      displayName: field(formData, "displayName"),
      accent: field(formData, "accent"),
      footer: field(formData, "footer"),
      logoAssetId: field(formData, "logoAssetId"),
    });
    if (!parsed.ok) return parsed;
    const saved = await ReportBrandings.save({
      workspaceId,
      userId,
      value: parsed.value,
    });
    if (!saved.ok) return saved;
    // Marka formu iki genel bakış sayfasında durur; yazdırma sayfaları canlı
    // markayı okur (GA-F8 ile paylaşılan birim).
    revalidatePath("/search");
    revalidatePath("/websites");
    revalidatePath("/projects/[projectId]/arama/client/[reportId]", "page");
    revalidatePath("/projects/[projectId]/site/client/[commandId]", "page");
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function createReportShareAction(
  formData: FormData,
): Promise<
  | { ok: true; url: string; expiresAt: string }
  | { ok: false; message: string }
> {
  try {
    const projectId = field(formData, "projectId");
    const reportId = field(formData, "reportId");
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGER_ONLY };
    }
    if (!reportShareOn() || !seoReportsActiveFor(projectId)) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    if (field(formData, "confirm") !== "on") {
      return { ok: false, message: NOT_CONFIRMED };
    }
    const days = Number(field(formData, "days"));
    if (!(REPORT_SHARE_DAYS as readonly number[]).includes(days)) {
      return { ok: false, message: BAD_DAYS };
    }
    if (isRateLimited(`share-create:${userId}`, 20, 3_600_000)) {
      return { ok: false, message: RATE_LIMITED };
    }
    // Rapor bu projeye ait olmalı; nabız kartı müşteri raporu değildir.
    const view = reportId ? await readSeoReportView(projectId, reportId) : null;
    if (!view || view.kind === "PULSE") {
      return { ok: false, message: BAD_REPORT };
    }
    // Marka, oluşturma anındaki ayardan KOPYALANIR.
    const branding = await ReportBrandings.get(workspaceId);
    const result = await ReportShares.create({
      workspaceId,
      projectId,
      kind: "SEARCH",
      reportId: view.id,
      days,
      userId,
      branding,
    });
    if (!result.ok) {
      return {
        ok: false,
        message: result.code === "LIMIT" ? LIMIT_MESSAGE : BAD_DAYS,
      };
    }
    revalidatePath(`/projects/${projectId}/arama`);
    return {
      ok: true,
      url: appUrl(`/r/${result.token}`).toString(),
      expiresAt: result.expiresAt.toISOString(),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeReportShareAction(
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
    if (!reportShareOn()) return { ok: false, message: NOT_AVAILABLE };
    if (!shareId) return { ok: false, message: REVOKE_FAILED };
    const revoked = await ReportShares.revoke({ projectId, shareId, userId });
    if (!revoked) return { ok: false, message: REVOKE_FAILED };
    revalidatePath(`/projects/${projectId}/arama`);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
