"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { GA_FIX_REFUSAL_MESSAGES } from "@/lib/website-analytics/fixes/copy";
import { gaFixesEnabledFor } from "@/lib/website-analytics/fixes/flags";
import {
  GA_FIX_KINDS,
  type GaFixKind,
} from "@/lib/website-analytics/fixes/types";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { GaFixes } from "@/server/website-analytics/fixes/fixes";
import {
  clearGaEditGrant,
  loadGaEditAccess,
} from "@/server/website-analytics/fixes/edit-grant";

export type ActionResult = { ok: true } | { ok: false; message: string };

// GA-F7 server action'ları (docs/website-fixes.md): öneri herkese açık (proje
// üyesi), onay/ret/geri alma/izni kapatma yalnız workspace OWNER/ADMIN.
// Hepsi {ok:false,message} döner, fırlatmaz; bayrak kapalıyken ya da proje
// yerel izin listesinde değilken hiçbir iş yapılmaz.

const NOT_AVAILABLE = "Editing isn't available right now.";
const MANAGER_ONLY_DECIDE = "Only a workspace owner or admin can approve this.";
const MANAGER_ONLY_UNDO = "Only a workspace owner or admin can undo this.";
const MANAGER_ONLY_TURN_OFF =
  "Only a workspace owner or admin can turn off editing.";

function revalidateSite(projectId: string): void {
  revalidatePath(`/projects/${projectId}/site`);
  revalidatePath("/dashboard");
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function asKind(value: string): GaFixKind | null {
  return GA_FIX_KINDS.find((kind) => kind === value) ?? null;
}

// Her tür için doğrulayıcının beklediği ham girdi.
function rawFor(kind: GaFixKind, formData: FormData): unknown {
  if (kind === "KEY_EVENT_CREATE") {
    return { eventName: field(formData, "eventName") };
  }
  if (kind === "ANNOTATION_CREATE") {
    return { title: field(formData, "title"), day: field(formData, "day") };
  }
  return {};
}

function failure(error: unknown, fallback: string): ActionResult {
  return {
    ok: false,
    message:
      error instanceof AgentelseError
        ? error.message
        : error instanceof Error && error.message
          ? error.message
          : fallback,
  };
}

// "Fix it for me (needs approval)" ve "Add a note": değişikliği önerir, onay
// Task + Approval ile ayrıca istenir.
export async function proposeGaFixAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    if (!gaFixesEnabledFor(projectId)) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    const kind = asKind(field(formData, "kind"));
    if (!kind) return { ok: false, message: GA_FIX_REFUSAL_MESSAGES.invalid };
    const result = await GaFixes.propose({
      projectId,
      kind,
      raw: rawFor(kind, formData),
      source: field(formData, "source") === "GUIDE" ? "GUIDE" : "PANEL",
      actor: { type: "USER", userId },
    });
    if (!result.ok) return { ok: false, message: result.message };
    revalidateSite(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not send this for approval");
  }
}

// Panelden onay/ret. Önce yönetici kontrolü; karar ortak onay komutuyla
// verilir, sonra değişiklik Approval satırına göre hizalanır (ret hemen
// işlenir, hook çalışmadıysa onay uygulanır).
export async function decideGaFixAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const changeId = field(formData, "changeId");
    const decision = field(formData, "decision");
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    if (!gaFixesEnabledFor(projectId)) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    if (decision !== "approve" && decision !== "reject") {
      return { ok: false, message: GA_FIX_REFUSAL_MESSAGES.invalid };
    }
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGER_ONLY_DECIDE };
    }

    const change = await prisma.gaConfigChange.findFirst({
      where: { id: changeId, projectId },
      select: { id: true, approvalId: true },
    });
    if (!change?.approvalId) {
      return { ok: false, message: "This change is no longer waiting." };
    }
    const approval = await prisma.approval.findUnique({
      where: { id: change.approvalId },
    });
    if (!approval || approval.projectId !== projectId) {
      return { ok: false, message: "This change is no longer waiting." };
    }
    if (approval.status !== "PENDING") {
      return { ok: false, message: "This change was already decided." };
    }

    await applyApprovalDecision({
      approval,
      to: decision === "approve" ? "APPROVED" : "REJECTED",
      reviewedByUserId: userId,
      actorType: "USER",
    });
    await GaFixes.syncApprovalState(change.id);
    revalidateSite(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not record the decision");
  }
}

// "Undo this change": açık bir OWNER/ADMIN tıklaması; motor önkoşulu ve geri
// okumayı yapar.
export async function undoGaFixAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const changeId = field(formData, "changeId");
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    if (!gaFixesEnabledFor(projectId)) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGER_ONLY_UNDO };
    }
    if (!changeId) return { ok: false, message: "Change not found." };
    const result = await GaFixes.undo({ projectId, changeId, userId });
    if (!result.ok) return { ok: false, message: result.message };
    revalidateSite(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not undo this change");
  }
}

// "Turn off editing": Agentelse'in yazması hemen durur. Google'daki izin
// kullanıcı Google Hesabı ayarlarından kaldırılana dek durur (metinlerde yazılı).
export async function turnOffGaEditAccessAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    if (!gaFixesEnabledFor(projectId)) {
      return { ok: false, message: NOT_AVAILABLE };
    }
    if (!(await isWorkspaceManager(userId, workspaceId))) {
      return { ok: false, message: MANAGER_ONLY_TURN_OFF };
    }
    const access = await loadGaEditAccess(projectId);
    if (!access) {
      return {
        ok: false,
        message: "Connect Google Analytics and choose a property first.",
      };
    }
    await clearGaEditGrant(access.credentialId);
    await AuditLogRepository.record({
      workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.edit_access_turned_off",
      entityType: "IntegrationCredential",
      entityId: access.credentialId,
      metadata: { provider: "google_analytics" },
    });
    revalidatePath(`/projects/${projectId}/integrations`);
    revalidateSite(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not turn off editing");
  }
}
