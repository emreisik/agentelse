import "server-only";

import { prisma } from "@/lib/prisma";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";

import { computeNextRunAt } from "./scheduler-service";

// "Turn on scheduled posting" from the content plan's next steps: approved
// Instagram pieces are released at their planned time by the Publishing
// schedule (Settings -> Publishing: up to 3 daily slots, each a ProjectSchedule
// row marked PUBLISH_NEXT_READY, which takes the next APPROVED piece whose
// planned time has passed, publishNextQueuedInstagramCreative). This makes the
// same rows the settings form makes, from the times the plan itself uses, so
// they stay visible and editable there.

// The marker SchedulerService.runDueSchedules reads (see scheduler-service.ts
// and publish-schedule-actions.ts, which carry the same value).
const PUBLISH_QUEUE_MODE = "PUBLISH_NEXT_READY";
const MAX_SLOTS = 3;
const FALLBACK_TIME = "10:00";

// The clock times the plan posts at (in the project's timezone), most used
// first, at most three (the settings form's slot count), returned in day
// order. A plan with nothing scheduled yet falls back to 10:00, the plan
// default.
export function planPublishTimes(
  plannedFor: readonly Date[],
  timezone: string,
): string[] {
  const counts = new Map<string, number>();
  for (const date of plannedFor) {
    const time = utcToZonedDateTimeLocal(date, timezone).slice(11, 16);
    counts.set(time, (counts.get(time) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SLOTS)
    .map(([time]) => time)
    .sort();
  return top.length > 0 ? top : [FALLBACK_TIME];
}

export async function enableScheduledPublishing(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  timezone: string;
  times: readonly string[];
}): Promise<{ turnedOn: number; created: number }> {
  const existing = await prisma.projectSchedule.findMany({
    where: {
      projectId: input.projectId,
      capability: "INSTAGRAM_PUBLISH",
      configuration: { path: ["mode"], equals: PUBLISH_QUEUE_MODE },
    },
  });

  // The client already has slots (perhaps switched off): their times are
  // theirs, so just turn them on.
  if (existing.length > 0) {
    let turnedOn = 0;
    for (const row of existing) {
      if (row.enabled) continue;
      await prisma.projectSchedule.update({
        where: { id: row.id },
        data: {
          enabled: true,
          nextRunAt: computeNextRunAt({
            scheduleType: "CRON",
            cronExpression: row.cronExpression,
            timezone: row.timezone,
            configuration: null,
          }),
        },
      });
      turnedOn += 1;
    }
    return { turnedOn, created: 0 };
  }

  let created = 0;
  for (const [index, time] of input.times.slice(0, MAX_SLOTS).entries()) {
    const [hour, minute] = time.split(":");
    const cronExpression = `${minute} ${hour} * * *`;
    await prisma.projectSchedule.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        name: `Instagram publish — ${time}`,
        capability: "INSTAGRAM_PUBLISH",
        scheduleType: "CRON",
        cronExpression,
        timezone: input.timezone,
        configuration: { mode: PUBLISH_QUEUE_MODE, slot: index + 1 },
        enabled: true,
        nextRunAt: computeNextRunAt({
          scheduleType: "CRON",
          cronExpression,
          timezone: input.timezone,
          configuration: null,
        }),
      },
    });
    created += 1;
  }
  return { turnedOn: created, created };
}
