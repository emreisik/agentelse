import "server-only";

import type { CapabilityKey, DepartmentKey } from "@prisma/client";

import { taskFingerprint } from "@/server/agency/fingerprint";
import { DepartmentRouter } from "@/server/agency/departments/department-router";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AgencyDecisionRepository } from "@/server/repositories/agency-decision.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { WorkHandoffRepository } from "@/server/repositories/work-handoff.repository";
import { prisma } from "@/lib/prisma";

// Cross-department work handoff (spec section 27). A department never
// mutates another department's state: it proposes a WorkHandoff; acceptance
// is a recorded AgencyDecision; the receiving department's task is created
// through TaskPlanner with full policy (approval levels intact).
export const WorkHandoffEngine = {
  async propose(input: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    workPlanId?: string;
    fromDepartment: DepartmentKey;
    toDepartment: DepartmentKey;
    fromTaskId?: string;
    reason: string;
    payload?: Record<string, unknown>;
    expiresInHours?: number;
  }) {
    return WorkHandoffRepository.create({
      ...input,
      expiresAt: input.expiresInHours
        ? new Date(Date.now() + input.expiresInHours * 3600_000)
        : undefined,
    });
  },

  // Accepting a handoff = a recorded director-level decision + a task in the
  // receiving department. The capability comes from the handoff payload or
  // the target department's primary capability.
  async accept(
    handoffId: string,
    projectId: string,
    opts: { capability: CapabilityKey; request: string; goalIds: string[] },
  ) {
    const handoff = await WorkHandoffRepository.findByIdInProject(
      handoffId,
      projectId,
    );
    if (!handoff || handoff.status !== "PROPOSED") return null;

    const scope = {
      workspaceId: handoff.workspaceId,
      projectId: handoff.projectId,
      brandId: handoff.brandId,
    };

    // Department mode gate: the receiving department must be in PREPARE or
    // EXECUTE mode to take on work.
    const allowed = await DepartmentRouter.allowsTaskCreation(
      projectId,
      handoff.toDepartment,
    );
    if (!allowed) {
      await WorkHandoffRepository.transition(handoffId, projectId, "REJECTED");
      return null;
    }

    await WorkHandoffRepository.transition(handoffId, projectId, "ACCEPTED");

    const decision = await AgencyDecisionRepository.create({
      ...scope,
      subjectType: "HANDOFF",
      subjectId: handoffId,
      decision: "CREATE_TASK",
      rationale: `Handoff ${handoff.fromDepartment} -> ${handoff.toDepartment}: ${handoff.reason}`,
    });

    try {
      await AutonomyPolicyRepository.checkAndIncrement(scope, "tasksCreated");
    } catch {
      // Cap reached: handoff stays ACCEPTED, a later tick can create the task.
      return null;
    }

    const planned = await TaskPlanner.planForCapability({
      ...scope,
      capability: opts.capability,
      request: opts.request,
      createdByType: "SYSTEM",
      departmentKey: handoff.toDepartment,
      workPlanId: handoff.workPlanId ?? undefined,
      goalIds: opts.goalIds,
      fingerprint: taskFingerprint({
        capability: opts.capability,
        department: handoff.toDepartment,
        subject: `handoff:${handoffId}`,
      }),
      sourceDecisionId: decision.id,
      payloadExtra: {
        handoffId,
        handoffPayload: handoff.payload ?? undefined,
      },
    });

    await WorkHandoffRepository.transition(handoffId, projectId, "TASK_CREATED", {
      toTaskId: planned.task.id,
      decisionId: decision.id,
    });

    return { handoff, task: planned.task, decision };
  },

  // TASK_COMPLETED fan-out: a completed task that was created from a handoff
  // completes the handoff.
  async onTaskCompleted(taskId: string): Promise<void> {
    const handoff = await prisma.workHandoff.findFirst({
      where: { toTaskId: taskId, status: "TASK_CREATED" },
    });
    if (!handoff) return;
    await WorkHandoffRepository.transition(
      handoff.id,
      handoff.projectId,
      "COMPLETED",
    );
  },
};
