"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { ProjectSetupOrchestrator } from "@/server/agency/setup/project-setup-orchestrator";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Entry point for the 12-stage Agency OS Setup Mode (spec section 5). The
// client provides only brand name + domain + free-text description (+ any
// uploaded asset ids); everything else is researched. Progression happens on
// worker ticks; this action only starts the machine.
export async function startAgencySetupAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const brandName = String(formData.get("brandName") ?? "").trim();
    const domain = String(formData.get("domain") ?? "").trim() || undefined;
    const description =
      String(formData.get("description") ?? "").trim() || undefined;
    const autoApprove = formData.get("autoApprove") === "true";

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    if (!brandName) return { ok: false, message: "Brand name is required" };

    const existing = await prisma.projectSetupState.findUnique({
      where: { projectId },
    });
    if (existing) return { ok: true };

    const state = await ProjectSetupOrchestrator.start(
      {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
      },
      { brandName, domain, description, autoApprove },
    );

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "agency-setup.started",
      entityType: "ProjectSetupState",
      entityId: state.id,
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// Client decision for stages parked WAITING_CLIENT (goal approval, initial
// work plan approval).
export async function submitSetupDecisionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const stage = String(formData.get("stage"));
    const approve = formData.get("approve") === "true";

    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    if (stage !== "GOAL_GENERATION" && stage !== "INITIAL_WORK_PLAN") {
      return {
        ok: false,
        message: `This stage does not accept decisions: ${stage}`,
      };
    }

    await ProjectSetupOrchestrator.submitClientDecision(projectId, stage, {
      approve,
      approvedByUserId: userId,
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
