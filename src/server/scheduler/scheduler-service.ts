import "server-only";

import { CronExpressionParser } from "cron-parser";

import { prisma } from "@/lib/prisma";
import { TaskPlanner } from "@/server/commands/task-planner";
import { publishNextQueuedInstagramCreative } from "@/server/commands/approval-decisions";
import { planWeeklyInstagramContent } from "@/server/agency/content/instagram-week-planner";

// A ProjectSchedule with capability INSTAGRAM_PUBLISH and this marker in
// `configuration` doesn't plan a fresh capability run (there's no
// imageUrl/creativeId to give it) — instead, at each due tick, it pops the
// oldest APPROVED-but-unpublished Instagram creative off the project's
// queue and publishes that. See publishNextQueuedInstagramCreative and the
// Settings → Publishing tab (settings-panel.tsx) that creates these rows.
const PUBLISH_QUEUE_MODE = "PUBLISH_NEXT_READY";

// A ProjectSchedule with capability CREATE_CONTENT_PLAN and this marker
// runs the fully-autonomous weekly Instagram planner instead of a normal
// capability run — see instagram-week-planner.ts and the Settings ->
// Publishing "Auto content planning" card (settings-panel.tsx).
const AUTO_PLAN_GRID_WEEK_MODE = "AUTO_PLAN_GRID_WEEK";

// Exported so the Publishing settings action can compute the same
// `nextRunAt` immediately on save, instead of waiting for the schedule's
// first tick.
export function computeNextRunAt(schedule: {
  scheduleType: "CRON" | "INTERVAL" | "ONE_OFF";
  cronExpression: string | null;
  timezone?: string | null;
  configuration: unknown;
}): Date | null {
  if (schedule.scheduleType === "ONE_OFF") return null;

  if (schedule.scheduleType === "CRON") {
    if (!schedule.cronExpression) return null;
    return CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(),
      tz: schedule.timezone ?? "UTC",
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

      if (
        schedule.capability === "INSTAGRAM_PUBLISH" &&
        config.mode === PUBLISH_QUEUE_MODE
      ) {
        // No request text to plan here — just release the next queued
        // creative, if any. An empty queue is a normal, silent no-op: the
        // slot simply had nothing ready to post.
        await publishNextQueuedInstagramCreative({
          workspaceId: schedule.workspaceId,
          projectId: schedule.projectId,
          brandId: schedule.brandId,
        });
      } else if (
        schedule.capability === "CREATE_CONTENT_PLAN" &&
        config.mode === AUTO_PLAN_GRID_WEEK_MODE
      ) {
        const dailyImageCap =
          typeof config.dailyImageCap === "number" ? config.dailyImageCap : 3;
        await planWeeklyInstagramContent(
          {
            workspaceId: schedule.workspaceId,
            projectId: schedule.projectId,
            brandId: schedule.brandId,
          },
          dailyImageCap,
        );
      } else {
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
      }

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
