import "server-only";

import { prisma } from "@/lib/prisma";
import { TaskPlanner } from "@/server/commands/task-planner";
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

    const plan = await WorkPlanRepository.findByIdInProject(
      task.workPlanId,
      task.projectId,
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
      task.projectId,
      anyFailed ? "FAILED" : "COMPLETED",
    );
  },
};
