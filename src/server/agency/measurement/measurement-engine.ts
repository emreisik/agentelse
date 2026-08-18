import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { MeasurementRepository } from "@/server/repositories/measurement.repository";

// Measurement plans per capability (spec section 31). Checks are relative
// offsets from execution; MEASUREMENT_CHECK tasks are L0/L1 (no approval).
const CHECK_TEMPLATES: Partial<
  Record<CapabilityKey, Array<{ label: string; afterHours: number }>>
> = {
  INSTAGRAM_PUBLISH: [
    { label: "24h engagement check", afterHours: 24 },
    { label: "72h engagement check", afterHours: 72 },
    { label: "7d performance check", afterHours: 168 },
  ],
  TIKTOK_PUBLISH: [
    { label: "24h engagement check", afterHours: 24 },
    { label: "72h engagement check", afterHours: 72 },
    { label: "7d performance check", afterHours: 168 },
  ],
  LINKEDIN_PUBLISH: [
    { label: "24h engagement check", afterHours: 24 },
    { label: "7d performance check", afterHours: 168 },
  ],
  X_PUBLISH: [
    { label: "24h engagement check", afterHours: 24 },
    { label: "7d performance check", afterHours: 168 },
  ],
  WEBSITE_UPDATE: [
    { label: "indexing check", afterHours: 48 },
    { label: "ranking check 14d", afterHours: 336 },
    { label: "ranking check 30d", afterHours: 720 },
  ],
  META_CAMPAIGN_CREATE: [
    { label: "3d spend/performance check", afterHours: 72 },
    { label: "14d performance check", afterHours: 336 },
  ],
  GOOGLE_ADS_CAMPAIGN_CREATE: [
    { label: "3d spend/performance check", afterHours: 72 },
    { label: "14d performance check", afterHours: 336 },
  ],
  PR_OUTREACH: [
    { label: "7d coverage check", afterHours: 168 },
  ],
};

export const MeasurementEngine = {
  // TASK_COMPLETED fan-out: externally visible completed work gets a
  // measurement plan (idempotent — one plan per task).
  async planForCompletedTask(taskId: string): Promise<void> {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status !== "COMPLETED") return;

    const template = CHECK_TEMPLATES[task.capability];
    if (!template) return;

    const existing = await MeasurementRepository.findPlanForTask(taskId);
    if (existing) return;

    const now = Date.now();
    await MeasurementRepository.createPlan({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
      taskId: task.id,
      workPlanId: task.workPlanId ?? undefined,
      description: `Measurement plan for ${task.capability}: ${task.title.slice(0, 80)}`,
      checks: template.map((check) => ({
        label: check.label,
        dueAt: new Date(now + check.afterHours * 3600_000),
      })),
    });
  },

  // Due checks become MEASUREMENT_CHECK tasks through the normal pipeline.
  async runDueChecks(limit = 10): Promise<number> {
    const due = await MeasurementRepository.listDueChecks(limit);
    let started = 0;

    for (const check of due) {
      const planned = await TaskPlanner.planForCapability({
        workspaceId: check.workspaceId,
        projectId: check.projectId,
        brandId: check.brandId,
        capability: "MEASUREMENT_CHECK",
        request: `${check.label} for measurement plan ${check.planId}`,
        createdByType: "SYSTEM",
        departmentKey: "DATA_ANALYTICS",
        goalIds: [],
        fingerprint: taskFingerprint({
          capability: "MEASUREMENT_CHECK",
          department: "DATA_ANALYTICS",
          subject: check.id,
        }),
        payloadExtra: { measurementCheckId: check.id },
      });

      await MeasurementRepository.transitionCheck(
        check.id,
        check.projectId,
        "SCHEDULED",
        { resultTaskId: planned.task.id },
      );
      await MeasurementRepository.transitionCheck(
        check.id,
        check.projectId,
        "RUNNING",
      );
      started += 1;
    }

    return started;
  },

  // TASK_COMPLETED fan-out for MEASUREMENT_CHECK tasks: store the observation
  // on the check, complete the plan when all checks are done.
  async onCheckTaskCompleted(taskId: string): Promise<void> {
    const check = await MeasurementRepository.findCheckByResultTask(taskId);
    if (!check || check.status !== "RUNNING") return;

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { executionJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const raw = (task?.executionJobs[0]?.rawResult ?? {}) as Record<
      string,
      unknown
    >;

    await MeasurementRepository.transitionCheck(
      check.id,
      check.projectId,
      "COMPLETED",
      {
        resultSummary: {
          observation: raw.observation ?? null,
          isMock: raw.isMock === true,
          completedAt: new Date().toISOString(),
        },
      },
    );
    await MeasurementRepository.completePlanIfDone(check.planId);
  },
};

