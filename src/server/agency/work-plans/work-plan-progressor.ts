import "server-only";

import { prisma } from "@/lib/prisma";
import { TaskPlanner } from "@/server/commands/task-planner";
import { TaskRepository } from "@/server/repositories/task.repository";
import { WorkPlanRepository } from "@/server/repositories/work-plan.repository";

// Dependency-gated dispatch for WorkPlan node tasks (spec section 26).
// Tasks are created deferred (READY); this progressor queues each one the
// moment all its dependencies are COMPLETED. Approval-parked tasks
// (WAITING_APPROVAL) are dispatched by the existing approval flow instead.
export const WorkPlanProgressor = {
  async dispatchReadyTasks(workPlanId: string, projectId: string): Promise<number> {
    const tasks = await prisma.task.findMany({
      where: { workPlanId, projectId, status: "READY" },
      select: { id: true },
    });

    let dispatched = 0;
    for (const task of tasks) {
      const satisfied = await TaskRepository.dependenciesSatisfied(task.id);
      if (!satisfied) continue;
      await TaskPlanner.dispatchApprovedTask(task.id, projectId);
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
