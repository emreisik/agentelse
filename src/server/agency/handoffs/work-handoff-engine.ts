import "server-only";

import type {
  AgencyDecision,
  CapabilityKey,
  DepartmentKey,
  WorkHandoff,
} from "@prisma/client";

import { taskFingerprint } from "@/server/agency/fingerprint";
import { DepartmentRouter } from "@/server/agency/departments/department-router";
import { TaskPlanner } from "@/server/commands/task-planner";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { AgencyDecisionRepository } from "@/server/repositories/agency-decision.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { WorkHandoffRepository } from "@/server/repositories/work-handoff.repository";
import { prisma } from "@/lib/prisma";

type AcceptOpts = {
  capability: CapabilityKey;
  request: string;
  goalIds: string[];
};

// Shared by accept() and progressPending(): the cap-gated task-creation
// attempt a handoff needs exactly once to leave ACCEPTED. Pulled out so the
// tick-driven retry (progressPending) can redo just this part — with the
// SAME AgencyDecision accept() already recorded — instead of re-deciding
// or re-creating anything.
async function attemptTaskCreation(
  handoff: WorkHandoff,
  decision: AgencyDecision,
  opts: AcceptOpts,
) {
  const scope = {
    workspaceId: handoff.workspaceId,
    projectId: handoff.projectId,
    brandId: handoff.brandId,
  };

  try {
    await AutonomyPolicyRepository.checkAndIncrement(scope, "tasksCreated");
  } catch {
    // Cap reached: handoff stays ACCEPTED. This used to be a dead end (see
    // the old comment here, now moved to progressPending below) — now
    // progressPending's ACCEPTED sweep calls back into this same function
    // once capacity frees up, or expires the handoff if its window passes
    // first.
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
      subject: `handoff:${handoff.id}`,
    }),
    sourceDecisionId: decision.id,
    payloadExtra: {
      handoffId: handoff.id,
      handoffPayload: handoff.payload ?? undefined,
    },
  });

  await WorkHandoffRepository.transition(
    handoff.id,
    handoff.projectId,
    "TASK_CREATED",
    { toTaskId: planned.task.id, decisionId: decision.id },
  );

  return { handoff, task: planned.task, decision };
}

// Reconstructs the accept() opts a retried handoff no longer has a live
// caller to supply. Deliberately mirrors acceptHandoffAction's derivation
// (agency-work-actions.ts) exactly, so a tick-driven retry produces the same
// task a human re-clicking "Accept" would have — goalIds especially are
// never persisted on the handoff, only re-queried at accept time.
async function deriveAcceptOpts(handoff: WorkHandoff): Promise<AcceptOpts> {
  const payload = (handoff.payload ?? {}) as {
    capability?: string;
    request?: string;
  };
  const goals = await prisma.projectGoal.findMany({
    where: {
      projectId: handoff.projectId,
      status: { in: ["APPROVED", "ACTIVE"] },
    },
    select: { id: true },
    take: 3,
  });
  return {
    capability: (payload.capability ?? "CREATE_COPY") as CapabilityKey,
    request: payload.request ?? handoff.reason,
    goalIds: goals.map((g) => g.id),
  };
}

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
      workspaceId: handoff.workspaceId,
      projectId: handoff.projectId,
      brandId: handoff.brandId,
      subjectType: "HANDOFF",
      subjectId: handoffId,
      decision: "CREATE_TASK",
      rationale: `Handoff ${handoff.fromDepartment} -> ${handoff.toDepartment}: ${handoff.reason}`,
    });

    return attemptTaskCreation(handoff, decision, opts);
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

  // Tick-driven resumption of the "a later tick can create the task" comment
  // accept() used to leave stranded — WorkHandoffRepository.listByStatus
  // already did the right query, it just had zero callers. Handles both
  // halves of that gap: ACCEPTED handoffs whose task creation was deferred
  // by a daily cap (retried here, expired if their window has since closed),
  // and PROPOSED handoffs nobody ever accepted/rejected before expiring.
  async progressPending(
    limit = 10,
  ): Promise<{ retried: number; expired: number }> {
    const now = new Date();
    let retried = 0;
    let expired = 0;

    const accepted = await WorkHandoffRepository.listByStatus(
      "ACCEPTED",
      limit,
    );
    for (const handoff of accepted) {
      // Paused-project guard (audit scenario L): silently skip — no
      // transition, no error — so a resumed project's handoff is simply
      // picked up again on a later tick.
      if (!(await isProjectAgencyActive(handoff.projectId))) continue;
      try {
        if (handoff.expiresAt && handoff.expiresAt < now) {
          await WorkHandoffRepository.transition(
            handoff.id,
            handoff.projectId,
            "EXPIRED",
          );
          expired += 1;
          continue;
        }

        // Reuse the AgencyDecision accept() already recorded before the cap
        // check deferred this handoff, rather than creating a fresh one —
        // a handoff can sit ACCEPTED for many ticks before capacity frees
        // up, and each tick re-deciding would spam the decision log for a
        // decision that was only ever made once.
        const decision = await prisma.agencyDecision.findFirst({
          where: { subjectType: "HANDOFF", subjectId: handoff.id },
          orderBy: { createdAt: "desc" },
        });
        if (!decision) continue; // accept() always creates one first; nothing to resume without it.

        const opts = await deriveAcceptOpts(handoff);
        const result = await attemptTaskCreation(handoff, decision, opts);
        if (result) retried += 1;
      } catch (error) {
        console.error(
          `[work-handoff-engine] progressPending failed to retry handoff ${handoff.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    const proposed = await WorkHandoffRepository.listByStatus(
      "PROPOSED",
      limit,
    );
    for (const handoff of proposed) {
      if (!handoff.expiresAt || handoff.expiresAt >= now) continue;
      // Paused-project guard (audit scenario L): silently skip expiring
      // this handoff for a paused project — same reasoning as the ACCEPTED
      // sweep above.
      if (!(await isProjectAgencyActive(handoff.projectId))) continue;
      try {
        await WorkHandoffRepository.transition(
          handoff.id,
          handoff.projectId,
          "EXPIRED",
        );
        expired += 1;
      } catch (error) {
        console.error(
          `[work-handoff-engine] progressPending failed to expire handoff ${handoff.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return { retried, expired };
  },
};
