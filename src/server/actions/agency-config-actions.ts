"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type {
  DepartmentKey,
  DepartmentMode,
  SignalCategory,
  SignalIntensity,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { clampUserLimits } from "@/lib/billing/user-limits";
import { handsOnLevelFor } from "@/lib/weekly-draft";
import { getEntitlements } from "@/server/billing/entitlements";
import { nextScanAt } from "@/server/agency/signals/scan-cadence";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Operation failed",
  };
}

export async function updateDepartmentModeAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const department = String(formData.get("department")) as DepartmentKey;
    const mode = String(formData.get("mode")) as DepartmentMode;

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await prisma.projectDepartment.upsert({
      where: { projectId_department: { projectId, department } },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        department,
        mode,
      },
      update: { mode },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "department.mode_changed",
      entityType: "ProjectDepartment",
      entityId: department,
      metadata: { mode },
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function updateSignalIntensityAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const category = String(formData.get("category")) as SignalCategory;
    const intensity = String(formData.get("intensity")) as SignalIntensity;

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await prisma.projectSignalProfile.upsert({
      where: { projectId_category: { projectId, category } },
      create: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        category,
        intensity,
        nextScanAt: nextScanAt(intensity),
      },
      update: { intensity, nextScanAt: nextScanAt(intensity) },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "signal_profile.intensity_changed",
      entityType: "ProjectSignalProfile",
      entityId: category,
      metadata: { intensity },
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// The limits the Autonomy settings still offer: the ones the chat-first flow
// actually enforces (AI calls and spend per day, the idea pool's size). The
// old pipeline's knobs (task limits, cooldowns, research concurrency, setup
// auto-approval, NBA weights, autopilot modes) keep their stored values and
// are no longer edited here.
const AutonomyPolicySchema = z.object({
  maxReasoningCallsPerDay: z.coerce.number().int().min(1).max(5000),
  maxActiveIdeas: z.coerce.number().int().min(1).max(500),
  dailyBudgetUsd: z
    .union([z.literal(""), z.coerce.number().min(0)])
    .transform((v) => (v === "" ? null : v)),
  // Ask before an automatic task bigger than this (USD); blank = the plan's default.
  approveAboveUsd: z
    .union([z.literal(""), z.coerce.number().min(0)])
    .transform((v) => (v === "" ? null : v)),
  unlimitedMode: z.coerce.boolean(),
  weeklyAutoProduce: z.coerce.boolean(),
});

export async function updateAutonomyPolicyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const parsed = AutonomyPolicySchema.parse({
      maxReasoningCallsPerDay: formData.get("maxReasoningCallsPerDay"),
      maxActiveIdeas: formData.get("maxActiveIdeas"),
      dailyBudgetUsd: formData.get("dailyBudgetUsd") ?? "",
      approveAboveUsd: formData.get("approveAboveUsd") ?? "",
      unlimitedMode: formData.get("unlimitedMode") === "on",
      weeklyAutoProduce: formData.get("weeklyAutoProduce") === "on",
    });
    // "Weekly plan draft" (weekly-plan-draft.ts) is the policy's hands-on
    // level (lib/weekly-draft.ts handsOnLevelFor).
    const current = await prisma.autonomyPolicy.findUnique({
      where: { projectId },
      select: { autopilotMode: true },
    });
    const autopilotMode = handsOnLevelFor(
      formData.get("weeklyDraft") === "on",
      current?.autopilotMode,
    );

    // The user's own limits never go past the plan (daily budget at most the plan's
    // monthly AI budget; the approval size within the plan's range).
    const entitlements = await getEntitlements(access.workspaceId);
    const limits = clampUserLimits({
      planKey: entitlements.unlimited ? null : entitlements.planKey,
      approveAboveUsd: parsed.approveAboveUsd,
      dailyBudgetUsd: parsed.dailyBudgetUsd,
    });

    await AutonomyPolicyRepository.update(projectId, {
      ...parsed,
      ...limits,
      autopilotMode,
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "autonomy_policy.updated",
      entityType: "AutonomyPolicy",
      entityId: projectId,
    });

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
