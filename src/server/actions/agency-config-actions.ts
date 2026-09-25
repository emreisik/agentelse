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

const AutonomyPolicySchema = z.object({
  maxTasksPerDay: z.coerce.number().int().min(1).max(500),
  maxReasoningCallsPerDay: z.coerce.number().int().min(1).max(5000),
  maxConcurrentResearchTasks: z.coerce.number().int().min(1).max(50),
  maxOpenOpportunities: z.coerce.number().int().min(1).max(500),
  maxActiveIdeas: z.coerce.number().int().min(1).max(500),
  taskCooldownHours: z.coerce.number().int().min(0).max(720),
  dailyBudgetUsd: z
    .union([z.literal(""), z.coerce.number().min(0)])
    .transform((v) => (v === "" ? null : v)),
  setupAutoApprove: z.coerce.boolean(),
  unlimitedMode: z.coerce.boolean(),
  autopilotMode: z.enum([
    "REVIEW_EVERYTHING",
    "CREATE_AUTOMATICALLY",
    "AUTOPILOT",
  ]),
});

const WEIGHT_KEYS = [
  "impact",
  "goalAlignment",
  "urgency",
  "evidence",
  "confidence",
  "timing",
  "originality",
  "costPenalty",
  "effortPenalty",
  "riskPenalty",
] as const;

export async function updateAutonomyPolicyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const parsed = AutonomyPolicySchema.parse({
      maxTasksPerDay: formData.get("maxTasksPerDay"),
      maxReasoningCallsPerDay: formData.get("maxReasoningCallsPerDay"),
      maxConcurrentResearchTasks: formData.get("maxConcurrentResearchTasks"),
      maxOpenOpportunities: formData.get("maxOpenOpportunities"),
      maxActiveIdeas: formData.get("maxActiveIdeas"),
      taskCooldownHours: formData.get("taskCooldownHours"),
      dailyBudgetUsd: formData.get("dailyBudgetUsd") ?? "",
      setupAutoApprove: formData.get("setupAutoApprove") === "on",
      unlimitedMode: formData.get("unlimitedMode") === "on",
      autopilotMode: formData.get("autopilotMode") ?? "AUTOPILOT",
    });

    // Scoring weights: only accept known keys, each 0..1.
    const weights: Record<string, number> = {};
    let hasWeights = false;
    for (const key of WEIGHT_KEYS) {
      const raw = formData.get(`weight_${key}`);
      if (raw === null || raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        return {
          ok: false,
          message: `Invalid weight: ${key} (must be between 0 and 1)`,
        };
      }
      weights[key] = value;
      hasWeights = true;
    }

    await AutonomyPolicyRepository.update(projectId, {
      ...parsed,
      ...(hasWeights ? { scoringWeights: weights } : {}),
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
