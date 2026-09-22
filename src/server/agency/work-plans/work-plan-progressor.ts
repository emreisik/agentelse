import "server-only";

import { prisma } from "@/lib/prisma";
import { TaskPlanner } from "@/server/commands/task-planner";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { WorkPlanRepository } from "@/server/repositories/work-plan.repository";

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
      if (task.requiresApproval) {
        // Dependency just cleared — only now is it safe to surface the
        // approval card (see task-planner.ts's deferDispatch branch for why
        // this can't happen at plan-creation time).
        await TaskPlanner.requestApproval(task);
      } else {
        await TaskPlanner.dispatchApprovedTask(task.id, projectId);
      }
      dispatched += 1;
    }
    return dispatched;
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
  // onTaskCompleted never had. Without this, a FAILED dependency left its
  // dependents READY forever (TaskRepository.dependenciesSatisfied requires
  // EVERY dependency to be exactly COMPLETED) and a plan with a dead branch
  // never left IN_PROGRESS. On FAILED, every direct dependent that hasn't
  // already started is cancelled — its input can now never arrive — which
  // in turn fires its own TASK_CANCELLED trigger and cascades down the
  // graph one level at a time, each level driven by a fresh trigger rather
  // than in-process recursion.
  async onTaskTerminal(
    taskId: string,
    status: "FAILED" | "CANCELLED",
  ): Promise<void> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { workPlanId: true, projectId: true },
    });
    if (!task?.workPlanId) return;

    if (status === "FAILED") {
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
            { failureReason: `Upstream dependency ${taskId} failed` },
          );
        } catch {
          // A concurrent transition (e.g. it was just dispatched) may make
          // this illegal by the time we get here — best-effort; the
          // all-terminal check below still resolves the plan once whatever
          // beat us here reaches its own terminal state.
        }
      }
    }

    await this.dispatchReadyTasks(task.workPlanId, task.projectId);
    await reconcilePlan(task.workPlanId, task.projectId);
  },
};

// Shared by onTaskCompleted/onTaskTerminal (previously duplicated inline in
// each): once every task in an IN_PROGRESS plan has reached a terminal
// status, the plan itself becomes FAILED if any task FAILED, else COMPLETED
// — unchanged from the original onTaskCompleted-only logic, just now also
// reachable from a FAILED/CANCELLED task instead of only a COMPLETED one.
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
  await WorkPlanRepository.transition(
    plan.id,
    projectId,
    anyFailed ? "FAILED" : "COMPLETED",
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
  if (anyFailed && plan.ideaId) {
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
