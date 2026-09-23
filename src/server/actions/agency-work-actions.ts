"use server";

import { revalidatePath } from "next/cache";

import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
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
    message: error instanceof Error ? error.message : "Operation failed",
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

// Cancel a single Task instead of waiting out a long-running generation —
// legal from QUEUED/RUNNING/WAITING_* (TASK_TRANSITIONS, transitions.ts)
// straight into CANCELLED, which fires the same TASK_CANCELLED trigger a
// system-driven cancellation would (see task.repository.ts's transition()) —
// WorkPlanProgressor/MeasurementEngine already react to it, no extra
// cascade code needed here. No provider actually supports aborting an
// in-flight call (only the mock does — see execution/types.ts's optional
// cancel()), so the underlying API call keeps running in the background;
// when its result eventually comes back, execution-service.ts's pollOnce
// now explicitly skips re-syncing the Task once it's already terminal
// (added alongside this action) instead of throwing an illegal-transition
// error trying to move a CANCELLED task to COMPLETED/FAILED.
export async function cancelTaskAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const taskId = String(formData.get("taskId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await TaskRepository.transition(taskId, projectId, "CANCELLED", {
      failureReason: "Cancelled by user",
    });
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "task.cancelled",
      entityType: "Task",
      entityId: taskId,
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
    if (!handoff) return { ok: false, message: "Handoff not found" };

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
          "Handoff could not be accepted (blocked by department mode or daily limit)",
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
