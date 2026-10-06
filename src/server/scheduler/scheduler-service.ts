import "server-only";

import { CronExpressionParser } from "cron-parser";

import { prisma } from "@/lib/prisma";
import { TaskPlanner } from "@/server/commands/task-planner";
import { publishNextQueuedInstagramCreative } from "@/server/commands/approval-decisions";
import { DeadLetterRepository } from "@/server/repositories/dead-letter.repository";

// Same constants/shape as execution-worker.ts's own retry/backoff (not
// imported from there: execution-worker.ts already imports SchedulerService,
// so the reverse import would be circular — this is the same "duplicate the
// three lines with a comment pointing at the original" convention
// measurement-engine.ts already uses for its own backoff formula).
const MAX_ATTEMPTS = 5;
// A claimed schedule whose run never finished comes due again after this.
const SCHEDULE_CLAIM_LEASE_MS = 10 * 60_000;
const BASE_BACKOFF_MS = 2_000;
function backoffMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, 5 * 60_000);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(BASE_BACKOFF_MS, Math.round(base + jitter));
}

// A ProjectSchedule with capability INSTAGRAM_PUBLISH and this marker in
// `configuration` doesn't plan a fresh capability run (there's no
// imageUrl/creativeId to give it) — instead, at each due tick, it pops the
// oldest APPROVED-but-unpublished Instagram creative off the project's
// queue and publishes that. See publishNextQueuedInstagramCreative and the
// Settings → Publishing tab (settings-panel.tsx) that creates these rows.
const PUBLISH_QUEUE_MODE = "PUBLISH_NEXT_READY";

// A ProjectSchedule with capability CREATE_CONTENT_PLAN and this marker was
// the Settings "Auto content planning" card's weekly Instagram planner. The
// card is gone: plans are made in the chat, from the idea pool. A row left
// behind is switched off the first time it comes due (same as the retired
// idea-generation schedule below), so it never renders images on its own.
const AUTO_PLAN_GRID_WEEK_MODE = "AUTO_PLAN_GRID_WEEK";
const RETIRED_AUTO_PLAN_NOTE =
  "Retired: content plans are made in the chat, from the idea pool.";

// The Settings "Idea Generation Frequency" card is gone: turning an evaluated
// opportunity into ideas is on demand only (a chat request). A row it left
// behind (capability GENERATE_IDEAS) must neither run nor fall through to the
// generic capability planner below, so the first time it comes due it is just
// switched off. The enum value stays: dropping it would need a migration.
const RETIRED_IDEA_GENERATION_CAPABILITY = "GENERATE_IDEAS";
const RETIRED_IDEA_GENERATION_NOTE =
  "Retired: ideas are generated on demand from chat, not on a schedule.";

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

      // Claim (compare-and-swap on nextRunAt): during a deploy overlap two
      // processes read the same due row; only the one that moves nextRunAt
      // forward runs it, so a slot never publishes twice
      // (docs/meta-ads-plan.md F1). The real next run is written below.
      const claimed = await prisma.projectSchedule.updateMany({
        where: {
          id: schedule.id,
          enabled: true,
          nextRunAt: schedule.nextRunAt,
        },
        data: { nextRunAt: new Date(Date.now() + SCHEDULE_CLAIM_LEASE_MS) },
      });
      if (claimed.count !== 1) continue;

      // Per-item isolation (reliability audit concern 8): previously a
      // thrown error here propagated straight out of the `for` loop —
      // nextRunAt/lastRunAt below never ran, so the schedule stayed "due"
      // and got retried on every single worker tick forever with no
      // cooldown, AND every other still-due schedule behind this one in the
      // unordered batch never got a chance to run that tick either. Each
      // schedule now succeeds or fails independently.
      try {
        if (schedule.capability === RETIRED_IDEA_GENERATION_CAPABILITY) {
          await prisma.projectSchedule.update({
            where: { id: schedule.id },
            data: { enabled: false, lastError: RETIRED_IDEA_GENERATION_NOTE },
          });
          continue;
        }

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
          await prisma.projectSchedule.update({
            where: { id: schedule.id },
            data: { enabled: false, lastError: RETIRED_AUTO_PLAN_NOTE },
          });
          continue;
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
            consecutiveFailures: 0,
            lastError: null,
          },
        });

        ran += 1;
      } catch (error) {
        const lastError =
          error instanceof Error ? error.message : String(error);
        const attempt = schedule.consecutiveFailures + 1;

        if (attempt >= MAX_ATTEMPTS) {
          await prisma.projectSchedule.update({
            where: { id: schedule.id },
            data: { enabled: false, consecutiveFailures: attempt, lastError },
          });
          await DeadLetterRepository.create({
            reason: `scheduler.run_due_schedule_failed_after_${MAX_ATTEMPTS}_attempts`,
            payload: {
              scheduleId: schedule.id,
              capability: schedule.capability,
            },
            attempts: attempt,
            lastError,
          }).catch(() => undefined);
        } else {
          await prisma.projectSchedule.update({
            where: { id: schedule.id },
            data: {
              nextRunAt: new Date(Date.now() + backoffMs(attempt)),
              consecutiveFailures: attempt,
              lastError,
            },
          });
        }
        // Continue to the next schedule regardless — one broken schedule
        // must not block the rest of this tick's batch.
      }
    }

    return ran;
  },
};
