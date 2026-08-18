import "server-only";

import { CronExpressionParser } from "cron-parser";

import { prisma } from "@/lib/prisma";
import { TaskPlanner } from "@/server/commands/task-planner";

function computeNextRunAt(schedule: {
  scheduleType: "CRON" | "INTERVAL" | "ONE_OFF";
  cronExpression: string | null;
  configuration: unknown;
}): Date | null {
  if (schedule.scheduleType === "ONE_OFF") return null;

  if (schedule.scheduleType === "CRON") {
    if (!schedule.cronExpression) return null;
    return CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(),
    })
      .next()
      .toDate();
  }

  const config = (schedule.configuration ?? {}) as Record<string, unknown>;
  const intervalMinutes =
    typeof config.intervalMinutes === "number" ? config.intervalMinutes : 60;
  return new Date(Date.now() + intervalMinutes * 60_000);
}

// Turns a due ProjectSchedule into a Task, exactly like a user-typed command
// would (spec section 73). Runs from ExecutionWorker.tick() alongside the
// rest of the polling loop — no separate cron infrastructure.
export const SchedulerService = {
  async runDueSchedules(limit = 20): Promise<number> {
    const due = await prisma.projectSchedule.findMany({
      where: { enabled: true, nextRunAt: { lte: new Date() } },
      take: limit,
    });

    let ran = 0;
    for (const schedule of due) {
      const config = (schedule.configuration ?? {}) as Record<string, unknown>;
      const requestText =
        typeof config.request === "string" ? config.request : schedule.name;

      await TaskPlanner.planForCapability({
        workspaceId: schedule.workspaceId,
        projectId: schedule.projectId,
        brandId: schedule.brandId,
        capability: schedule.capability,
        request: requestText,
        createdByType: "SYSTEM",
      });

      const nextRunAt = computeNextRunAt(schedule);

      await prisma.projectSchedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt,
          enabled:
            schedule.scheduleType === "ONE_OFF" ? false : schedule.enabled,
        },
      });

      ran += 1;
    }

    return ran;
  },
};
