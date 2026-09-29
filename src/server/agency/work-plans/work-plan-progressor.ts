import "server-only";

import { prisma } from "@/lib/prisma";
import { TaskPlanner } from "@/server/commands/task-planner";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { WorkPlanRepository } from "@/server/repositories/work-plan.repository";

// A WorkPlan node task is created READY-but-undispatched (deferDispatch,
// see task-planner.ts) and only ever dispatched by: the one-shot root-node
// call right after plan creation (work-plan-builder.ts), or reactively by
// onTaskCompleted/onTaskTerminal below when a SIBLING task in the same plan
// reaches a terminal status. If that one-shot call misses a root node for
// any transient reason (isProjectAgencyActive was false at that exact
// moment — project still mid-setup, or briefly PAUSED), nothing ever
// retries it: no sibling ever completes to fire the reactive path, so the
// node (and everything depending on it) stays orphaned in READY forever.
// Confirmed in production: 40 Task rows stuck 147-221 hours, zero
// ExecutionJobs. sweepOrphanedReadyTasks below is the periodic repair pass
// neither path provides.
const STALE_READY_TASK_AFTER_MS = 30 * 60_000;

// Dependency-gated dispatch for WorkPlan node tasks (spec section 26).
// Tasks are created deferred (READY) regardless of whether their capability
// requires approval; this progressor acts on each one the moment all its
// dependencies are COMPLETED — dispatching it straight to execution, or, if
// the capability requires approval, parking it (WAITING_APPROVAL) only now
// that its inputs actually exist. From there the normal human-approval flow
// takes over and calls TaskPlanner.dispatchApprovedTask itself.
export const WorkPlanProgressor = {
  async dispatchReadyTasks(
    workPlanId: string,
    projectId: string,
  ): Promise<number> {
    // Paused-project guard (audit scenario L): an early return, not a loop
    // `continue` — this is already single-project scoped by the time it's
    // called (onTaskCompleted/onTaskTerminal resolve projectId first), so
    // there's no batch to skip within, just the query itself to not run.
    if (!(await isProjectAgencyActive(projectId))) return 0;

    const tasks = await prisma.task.findMany({
      where: { workPlanId, projectId, status: "READY" },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        brandId: true,
        title: true,
        capability: true,
        riskLevel: true,
        createdByType: true,
        createdByUserId: true,
        departmentKey: true,
        requiresApproval: true,
      },
    });

    let dispatched = 0;
    for (const task of tasks) {
      const satisfied = await TaskRepository.dependenciesSatisfied(task.id);
      if (!satisfied) continue;
      // Per-task isolation: one node failing to dispatch used to throw out
      // of this loop and leave every other READY node in the plan
      // undispatched for this pass.
      try {
        if (task.requiresApproval) {
          // Dependency just cleared — only now is it safe to surface the
          // approval card (see task-planner.ts's deferDispatch branch for
          // why this can't happen at plan-creation time).
          await TaskPlanner.requestApproval(task);
        } else {
          await TaskPlanner.dispatchApprovedTask(task.id, projectId);
        }
        dispatched += 1;
      } catch (error) {
        console.error(
          `[work-plan-progressor] dispatch failed for task ${task.id} (${task.capability}):`,
          error,
        );
      }
    }
    return dispatched;
  },

  // Periodic repair pass (see the module comment on STALE_READY_TASK_AFTER_MS
  // above) — finds WorkPlan node tasks that have sat READY for too long
  // (past any reasonable tick-jitter window) and re-runs dispatchReadyTasks
  // for their plan. Safe to call repeatedly: dispatchReadyTasks re-queries
  // status: "READY" fresh every time (an already-dispatched task has moved
  // off READY, so it simply won't be a candidate again), and
  // ExecutionService.dispatch()'s idempotencyKey (taskId:capability, unique
  // constraint) is a second independent guard against a duplicate dispatch.
  // distinct: ["workPlanId"] + orderBy updatedAt asc gives one candidate
  // (the oldest-stale) per distinct plan, same pattern as idea-foundry.ts's
  // generateForTopOpportunities.
  async sweepOrphanedReadyTasks(limit = 20, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_READY_TASK_AFTER_MS);

    const stale = await prisma.task.findMany({
      where: {
        workPlanId: { not: null },
        status: "READY",
        updatedAt: { lt: cutoff },
      },
      select: {
        workPlanId: true,
        projectId: true,
        workspaceId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "asc" },
      distinct: ["workPlanId"],
      take: limit,
    });

    let total = 0;
    for (const candidate of stale) {
      if (!candidate.workPlanId) continue;
      const dispatched = await this.dispatchReadyTasks(
        candidate.workPlanId,
        candidate.projectId,
      );
      // 0 means either the project is paused, or every READY task in this
      // plan is still legitimately dependency-blocked — not an error, just
      // nothing to rescue on this pass.
      if (dispatched === 0) continue;
      total += dispatched;

      await AuditLogRepository.record({
        workspaceId: candidate.workspaceId,
        projectId: candidate.projectId,
        actorType: "SYSTEM",
        action: "self-healing.stale_ready_tasks_rescued",
        entityType: "WorkPlan",
        entityId: candidate.workPlanId,
        metadata: {
          dispatchedCount: dispatched,
          staleForMinutes: Math.round(
            (now.getTime() - candidate.updatedAt.getTime()) / 60_000,
          ),
        },
      }).catch(() => undefined);
    }
    return total;
  },

  // TASK_COMPLETED fan-out: progress the task's plan, complete the plan when
  // every node is terminal.
  async onTaskCompleted(taskId: string): Promise<void> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { workPlanId: true, projectId: true },
    });
    if (!task?.workPlanId) return;

    await this.dispatchReadyTasks(task.workPlanId, task.projectId);
    await reconcilePlan(task.workPlanId, task.projectId);
  },

  // TASK_FAILED/TASK_CANCELLED fan-out — the symmetric counterpart
  // onTaskCompleted never had. Without this, a FAILED (or CANCELLED)
  // dependency left its dependents READY forever
  // (TaskRepository.dependenciesSatisfied requires EVERY dependency to be
  // exactly COMPLETED) and a plan with a dead branch never left
  // IN_PROGRESS. On FAILED or CANCELLED, every direct dependent that hasn't
  // already started is cancelled — its input can now never arrive — which
  // in turn fires its own TASK_CANCELLED trigger and cascades down the
  // graph one level at a time, each level driven by a fresh trigger rather
  // than in-process recursion. Cascading on CANCELLED too (not just FAILED)
  // matters for two reachable cases: a user-cancelled task
  // (cancelTaskAction) and a multi-hop plan where a cascade-CANCELLED node
  // itself has further dependents (e.g. WorkPlanBuilder's
  // strategy -> middle -> measurement graph — measurement is 2 hops from a
  // FAILED strategy task and was previously never reached).
  async onTaskTerminal(
    taskId: string,
    status: "FAILED" | "CANCELLED",
  ): Promise<void> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { workPlanId: true, projectId: true },
    });
    if (!task?.workPlanId) return;

    const dependents = await prisma.taskDependency.findMany({
      where: { dependsOnTaskId: taskId },
      select: {
        taskId: true,
        task: { select: { status: true, projectId: true } },
      },
    });
    for (const dep of dependents) {
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(dep.task.status)) {
        continue;
      }
      try {
        await TaskRepository.transition(
          dep.taskId,
          dep.task.projectId,
          "CANCELLED",
          {
            failureReason:
              status === "FAILED"
                ? `Upstream dependency ${taskId} failed`
                : `Upstream dependency ${taskId} was cancelled`,
          },
        );
      } catch {
        // A concurrent transition (e.g. it was just dispatched) may make
        // this illegal by the time we get here — best-effort; the
        // all-terminal check below still resolves the plan once whatever
        // beat us here reaches its own terminal state.
      }
    }

    await this.dispatchReadyTasks(task.workPlanId, task.projectId);
    await reconcilePlan(task.workPlanId, task.projectId);
  },
};

// Shared by onTaskCompleted/onTaskTerminal (previously duplicated inline in
// each): once every task in an IN_PROGRESS plan has reached a terminal
// status, the plan itself resolves — FAILED if any task FAILED, else
// CANCELLED if any task was CANCELLED (with none FAILED), else COMPLETED.
// The CANCELLED branch matters once onTaskTerminal above cascades on a
// plain CANCELLED terminal too: a plan whose only non-success path was one
// user-cancelled (or approval-rejected) task, with zero FAILED tasks
// anywhere, must not be silently mislabeled COMPLETED.
async function reconcilePlan(
  workPlanId: string,
  projectId: string,
): Promise<void> {
  const plan = await WorkPlanRepository.findByIdInProject(
    workPlanId,
    projectId,
  );
  if (!plan || plan.status !== "IN_PROGRESS") return;

  const statuses = plan.tasks.map((t) => t.status);
  const allTerminal = statuses.every((s) =>
    ["COMPLETED", "FAILED", "CANCELLED"].includes(s),
  );
  if (!allTerminal) return;

  const anyFailed = statuses.some((s) => s === "FAILED");
  const anyCancelled = statuses.some((s) => s === "CANCELLED");
  await WorkPlanRepository.transition(
    plan.id,
    projectId,
    anyFailed ? "FAILED" : anyCancelled ? "CANCELLED" : "COMPLETED",
  );

  // Audit scenario K: a failed plan must not leave its Idea stranded ACTIVE
  // forever (permanently occupying a maxActiveIdeas slot, per
  // IdeaRepository.countActive) with no way back into the loop. ACTIVE ->
  // ARCHIVED is already a legal IDEA_TRANSITIONS exit — this just makes the
  // engine actually take it, mirroring the OpportunityEngine.evaluateInsight
  // ARCHIVED pattern for a "didn't pan out" outcome. IdeaFoundry.
  // generateForTopOpportunities's candidate query treats an opportunity
  // whose ideas are all ARCHIVED/REJECTED as eligible again (bounded by
  // MAX_IDEA_ATTEMPTS_PER_OPPORTUNITY there), so the opportunity gets
  // another attempt on a later tick instead of being permanently exhausted
  // by one failed plan. Best-effort: a concurrent transition (idea already
  // moved on) must not block the plan's own FAILED transition above, which
  // has already committed.
  if ((anyFailed || anyCancelled) && plan.ideaId) {
    try {
      const idea = await prisma.idea.findUnique({
        where: { id: plan.ideaId },
        select: { status: true },
      });
      if (idea?.status === "ACTIVE") {
        await IdeaRepository.transition(plan.ideaId, projectId, "ARCHIVED");
      }
    } catch {
      // Best-effort — see comment above.
    }
  }
}
