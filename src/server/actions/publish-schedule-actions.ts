"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { computeNextRunAt } from "@/server/scheduler/scheduler-service";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import type { ActionResult } from "@/server/actions/agency-config-actions";

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Operation failed",
  };
}

// Up to 3 slots/day (Settings → Publishing). Each filled slot becomes its
// own ProjectSchedule row, identified by configuration.slot (1-3) since
// there's no natural unique key otherwise. An empty slot means "no row" —
// clearing a previously-set time deletes it rather than disabling it.
const SLOT_COUNT = 3;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ScheduleSchema = z.object({
  projectId: z.string().min(1),
  enabled: z.boolean(),
  timezone: z.string().min(1),
  slots: z
    .array(z.string().regex(TIME_RE, "Use HH:mm").or(z.literal("")))
    .length(SLOT_COUNT),
});

// The marker that tells SchedulerService.runDueSchedules to release the
// next queued creative instead of planning a fresh capability run — see
// scheduler-service.ts and approval-decisions.ts's
// publishNextQueuedInstagramCreative.
const PUBLISH_QUEUE_MODE = "PUBLISH_NEXT_READY";

export async function updateInstagramPublishScheduleAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const parsed = ScheduleSchema.parse({
      projectId,
      enabled: formData.get("enabled") === "on",
      timezone: String(formData.get("timezone") ?? "").trim() || "UTC",
      slots: Array.from({ length: SLOT_COUNT }, (_, index) =>
        String(formData.get(`slot${index + 1}`) ?? "").trim(),
      ),
    });

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    for (let index = 0; index < SLOT_COUNT; index++) {
      const slot = index + 1;
      const time = parsed.slots[index];
      const existing = await prisma.projectSchedule.findFirst({
        where: {
          projectId,
          capability: "INSTAGRAM_PUBLISH",
          configuration: { path: ["slot"], equals: slot },
        },
        select: { id: true },
      });

      if (!time) {
        if (existing) {
          await prisma.projectSchedule.delete({ where: { id: existing.id } });
        }
        continue;
      }

      const [hour, minute] = time.split(":");
      const cronExpression = `${minute} ${hour} * * *`;
      const nextRunAt = computeNextRunAt({
        scheduleType: "CRON",
        cronExpression,
        timezone: parsed.timezone,
        configuration: null,
      });

      if (existing) {
        await prisma.projectSchedule.update({
          where: { id: existing.id },
          data: {
            cronExpression,
            timezone: parsed.timezone,
            enabled: parsed.enabled,
            nextRunAt,
          },
        });
      } else {
        await prisma.projectSchedule.create({
          data: {
            workspaceId: access.workspaceId,
            projectId,
            brandId: access.defaultBrandId,
            name: `Instagram publish — ${time}`,
            capability: "INSTAGRAM_PUBLISH",
            scheduleType: "CRON",
            cronExpression,
            timezone: parsed.timezone,
            configuration: { mode: PUBLISH_QUEUE_MODE, slot },
            enabled: parsed.enabled,
            nextRunAt,
          },
        });
      }
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "instagram_publish_schedule.updated",
      entityType: "ProjectSchedule",
      entityId: projectId,
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
