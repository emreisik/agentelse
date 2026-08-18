"use server";

import { revalidatePath } from "next/cache";

import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { WorkHandoffRepository } from "@/server/repositories/work-handoff.repository";
import { WorkPlanRepository } from "@/server/repositories/work-plan.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "İşlem başarısız",
  };
}

export async function approveWorkPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const workPlanId = String(formData.get("workPlanId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await WorkPlanRepository.transition(workPlanId, projectId, "APPROVED");
    await WorkPlanRepository.transition(workPlanId, projectId, "IN_PROGRESS");

    // Kick dependency-free nodes immediately.
    const { WorkPlanProgressor } =
      await import("@/server/agency/work-plans/work-plan-progressor");
    await WorkPlanProgressor.dispatchReadyTasks(workPlanId, projectId);

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "work_plan.approved",
      entityType: "WorkPlan",
      entityId: workPlanId,
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function cancelWorkPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const workPlanId = String(formData.get("workPlanId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await WorkPlanRepository.transition(workPlanId, projectId, "CANCELLED");
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "work_plan.cancelled",
      entityType: "WorkPlan",
      entityId: workPlanId,
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Accepting a handoff routes through WorkHandoffEngine so the department-mode
// gate, decision record, and TaskPlanner policy all apply.
export async function acceptHandoffAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const handoffId = String(formData.get("handoffId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const { WorkHandoffEngine } =
      await import("@/server/agency/handoffs/work-handoff-engine");
    const { prisma } = await import("@/lib/prisma");

    const handoff = await WorkHandoffRepository.findByIdInProject(
      handoffId,
      projectId,
    );
    if (!handoff) return { ok: false, message: "Devir bulunamadı" };

    // Capability/goal context comes from the handoff payload; fall back to a
    // generic content capability + the project's active goals.
    const payload = (handoff.payload ?? {}) as {
      capability?: string;
      request?: string;
    };
    const goals = await prisma.projectGoal.findMany({
      where: { projectId, status: { in: ["APPROVED", "ACTIVE"] } },
      select: { id: true },
      take: 3,
    });

    const result = await WorkHandoffEngine.accept(handoffId, projectId, {
      capability: (payload.capability ?? "CREATE_COPY") as never,
      request: payload.request ?? handoff.reason,
      goalIds: goals.map((g) => g.id),
    });
    if (!result) {
      return {
        ok: false,
        message:
          "Devir kabul edilemedi (departman modu veya günlük limit engeli)",
      };
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "handoff.accepted",
      entityType: "WorkHandoff",
      entityId: handoffId,
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectHandoffAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const handoffId = String(formData.get("handoffId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await WorkHandoffRepository.transition(handoffId, projectId, "REJECTED");
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "handoff.rejected",
      entityType: "WorkHandoff",
      entityId: handoffId,
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
