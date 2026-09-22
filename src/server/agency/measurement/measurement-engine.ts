import "server-only";

import type { CapabilityKey, SocialPlatform } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { TaskPlanner } from "@/server/commands/task-planner";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { MeasurementRepository } from "@/server/repositories/measurement.repository";

const SOCIAL_PLATFORMS = new Set<string>([
  "INSTAGRAM",
  "TIKTOK",
  "LINKEDIN",
  "X",
  "FACEBOOK",
  "YOUTUBE",
  "PINTEREST",
]);

function asSocialPlatform(value: unknown): SocialPlatform | undefined {
  return typeof value === "string" && SOCIAL_PLATFORMS.has(value)
    ? (value as SocialPlatform)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

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
  PR_OUTREACH: [{ label: "7d coverage check", afterHours: 168 }],
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

    // Pull the concrete result forward from the job that actually did the
    // publish/campaign-create — same pattern as MetaCampaignChainRelay
    // (meta-campaign-chain-relay.ts). Without this, every MEASUREMENT_CHECK
    // task this plan later spawns has nothing to check but its own internal
    // plan id (see runDueChecks below).
    const job = await prisma.executionJob.findFirst({
      where: { taskId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { rawResult: true },
    });
    const rawResult = (job?.rawResult ?? {}) as Record<string, unknown>;
    const payload = (task.payload ?? {}) as Record<string, unknown>;

    const now = Date.now();
    await MeasurementRepository.createPlan({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
      taskId: task.id,
      workPlanId: task.workPlanId ?? undefined,
      description: `Measurement plan for ${task.capability}: ${task.title.slice(0, 80)}`,
      platform: asSocialPlatform(payload.platform),
      postUrl:
        asString(rawResult.externalPostUrl) ?? asString(rawResult.postUrl),
      platformPostId: asString(rawResult.postId),
      campaignId: asString(rawResult.campaignId),
      checks: template.map((check) => ({
        label: check.label,
        dueAt: new Date(now + check.afterHours * 3600_000),
      })),
    });
  },

  // Due checks become MEASUREMENT_CHECK tasks through the normal pipeline.
  // listDueChecks returns both fresh PENDING checks and FAILED->SCHEDULED
  // retries whose backoff window elapsed (see onCheckTaskTerminal) — both
  // are handled identically here.
  async runDueChecks(limit = 10): Promise<number> {
    const due = await MeasurementRepository.listDueChecks(limit);
    let started = 0;

    for (const check of due) {
      // Paused-project guard (audit scenario L): silently skip — no
      // transition, no error — so a resumed project's check is simply
      // picked up again on a later tick.
      if (!(await isProjectAgencyActive(check.plan.projectId))) continue;
      // The plan's postUrl/platformPostId/campaignId (captured in
      // planForCompletedTask above from the original publish/campaign
      // task's result) are the actual thing to check. Confirmed in
      // production (2026-09): when none of them were ever captured (e.g.
      // WEBSITE_UPDATE, whose provider returns no post/campaign id), the
      // old fallback asked an agent to "check measurement plan <cuid>" — a
      // request no provider can act on, which either hallucinated a
      // plausible-sounding observation or failed outright. Skip honestly
      // instead of asking for the impossible.
      const target =
        check.plan.postUrl ??
        check.plan.platformPostId ??
        check.plan.campaignId;

      if (!target) {
        await MeasurementRepository.transitionCheck(
          check.id,
          check.projectId,
          "SKIPPED",
          {
            resultSummary: {
              reason: "NO_MEASURABLE_TARGET",
              skippedAt: new Date().toISOString(),
            },
          },
        );
        await MeasurementRepository.completePlanIfDone(check.planId);
        continue;
      }

      const planned = await TaskPlanner.planForCapability({
        workspaceId: check.workspaceId,
        projectId: check.projectId,
        brandId: check.brandId,
        capability: "MEASUREMENT_CHECK",
        request: `${check.label} for ${target}`,
        targetPlatform: check.plan.platform ?? undefined,
        createdByType: "SYSTEM",
        departmentKey: "DATA_ANALYTICS",
        goalIds: [],
        fingerprint: taskFingerprint({
          capability: "MEASUREMENT_CHECK",
          department: "DATA_ANALYTICS",
          subject: check.id,
        }),
        payloadExtra: {
          measurementCheckId: check.id,
          postUrl: check.plan.postUrl ?? undefined,
          platformPostId: check.plan.platformPostId ?? undefined,
          campaignId: check.plan.campaignId ?? undefined,
        },
      });

      // Legal whether `check` arrived here PENDING (assertTransition treats
      // an unchanged status as a no-op) or SCHEDULED (a retry) — either way
      // this just (re)points resultTaskId at the fresh task.
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

  // TASK_FAILED/TASK_CANCELLED fan-out — the symmetric counterpart
  // onCheckTaskCompleted never had. Without this, a MEASUREMENT_CHECK
  // task's provider error (a dead post, a rate-limited API, a browser
  // session failure) left the check at RUNNING forever, which in turn
  // permanently blocked its MeasurementPlan from reaching COMPLETED
  // (MeasurementRepository.completePlanIfDone requires every check to be
  // terminal) and therefore blocked LearningEngine from ever seeing it.
  // RUNNING can only legally move to COMPLETED or FAILED next (see
  // MEASUREMENT_CHECK_TRANSITIONS) — a CANCELLED result task is recorded
  // as FAILED too, there's no separate CANCELLED check status. Retries a
  // bounded number of times with exponential backoff before giving up.
  async onCheckTaskTerminal(
    taskId: string,
    status: "FAILED" | "CANCELLED",
  ): Promise<void> {
    const check = await MeasurementRepository.findCheckByResultTask(taskId);
    if (!check || check.status !== "RUNNING") return;

    const attemptCount = check.attemptCount + 1;
    await MeasurementRepository.transitionCheck(
      check.id,
      check.projectId,
      "FAILED",
      {
        attemptCount,
        lastError: `Result task ${taskId} ended ${status}`,
      },
    );

    if (attemptCount < check.maxAttempts) {
      // Same shape as execution-worker.ts's backoffMs, capped at 6h since a
      // measurement retry is far less urgent than a dispatch retry.
      const delayMs = Math.min(
        15 * 60_000 * 2 ** (attemptCount - 1),
        6 * 3600_000,
      );
      await MeasurementRepository.transitionCheck(
        check.id,
        check.projectId,
        "SCHEDULED",
        { nextAttemptAt: new Date(Date.now() + delayMs) },
      );
    } else {
      await MeasurementRepository.completePlanIfDone(check.planId);
    }
  },
};
