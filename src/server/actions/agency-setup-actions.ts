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

// Shared core of the 12-stage Agency OS Setup Mode (spec section 5) start —
// used by both the form-based startAgencySetupAction (below) and the chat
// surface's conversational intake (chat-service.ts), which already has
// workspaceId/brandId/userId resolved and no FormData to build. Everything
// beyond brand name + domain + free-text description (+ any uploaded asset
// ids) is researched; progression happens on worker ticks, this only starts
// the machine.
export async function startAgencySetupForProject(params: {
  projectId: string;
  workspaceId: string;
  brandId: string;
  userId: string;
  brandName: string;
  domain?: string;
  description?: string;
  autoApprove?: boolean;
}): Promise<ActionResult> {
  try {
    if (!params.brandName)
      return { ok: false, message: "Brand name is required" };

    const existing = await prisma.projectSetupState.findUnique({
      where: { projectId: params.projectId },
    });
    if (existing) return { ok: true };

    const state = await ProjectSetupOrchestrator.start(
      {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        brandId: params.brandId,
      },
      {
        brandName: params.brandName,
        domain: params.domain,
        description: params.description,
        autoApprove: params.autoApprove,
      },
    );

    await AuditLogRepository.record({
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      actorType: "USER",
      actorId: params.userId,
      action: "agency-setup.started",
      entityType: "ProjectSetupState",
      entityId: state.id,
    });

    revalidatePath(`/projects/${params.projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// Entry point for the setup form (setup-panel.tsx) — thin FormData wrapper
// around startAgencySetupForProject above.
export async function startAgencySetupAction(
  formData: FormData,
): Promise<ActionResult> {
  const projectId = String(formData.get("projectId"));
  const brandName = String(formData.get("brandName") ?? "").trim();
  const domain = String(formData.get("domain") ?? "").trim() || undefined;
  const description =
    String(formData.get("description") ?? "").trim() || undefined;
  const autoApprove = formData.get("autoApprove") === "true";

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  return startAgencySetupForProject({
    projectId,
    workspaceId: access.workspaceId,
    brandId: access.defaultBrandId,
    userId,
    brandName,
    domain,
    description,
    autoApprove,
  });
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

// Manual retry of the current FAILED setup stage — the escape hatch a user
// reaches for instead of giving up on the app after hitting an error during
// onboarding. Exempt from the automatic tick-driven retry cap
// (project-setup-orchestrator.ts's MAX_STAGE_ATTEMPTS).
export async function retrySetupStageAction(
  projectId: string,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    await ProjectSetupOrchestrator.retryStageNow(projectId);

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
