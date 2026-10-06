"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/components/shared/action-form";
import { isSeoGoalMetric, validSeoGoalTarget } from "@/lib/seo/reports/goals";
import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  archiveSeoGoal,
  listSeoGoals,
  refreshSeoGoals,
  upsertSeoGoal,
} from "@/server/seo/reports/goals";

// Search sayfasındaki "SEO goals" kartının eylemleri (SC-F5,
// docs/search-reports.md "Hedefler"): hedef ekleme/güncelleme ve arşivleme.
// İkisi de oturumu ve proje erişimini doğrular, sonra bayrağı sınar; hiç
// fırlatmaz, hata metni istemciye aynen gitmez. Denetim kaydında Google
// verisi değil yalnız ölçüt anahtarı ve hedef sayısı durur.

const NOT_ON = "SEO reports are turned off.";
const INVALID = "Something is missing. Reload the page and try again.";
const INVALID_METRIC = "Choose a goal.";
const INVALID_TARGET = "Enter a target above zero (percent goals up to 100).";
const GOAL_NOT_FOUND = "Goal not found.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";

const ProjectSchema = z.object({ projectId: z.string().trim().min(1).max(64) });
const CreateSchema = ProjectSchema.extend({
  metricKey: z.string().trim().min(1).max(64),
  target: z.string().trim().min(1).max(32),
});
const ArchiveSchema = ProjectSchema.extend({
  goalId: z.string().trim().min(1).max(64),
});

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function failure(error: unknown, fallback: string): ActionResult {
  if (isAgentelseError(error)) {
    if (error.code === "LOGIN_REQUIRED" || error.code === "SESSION_EXPIRED") {
      return { ok: false, message: SIGN_IN_AGAIN };
    }
    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "NOT_FOUND" ||
      error.code === "PROJECT_MISMATCH"
    ) {
      return { ok: false, message: PROJECT_UNAVAILABLE };
    }
  }
  // Yalnız hata adı: mesaj kimlik ya da Google verisi taşıyabilir.
  console.error(
    "[seo-reports] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function revalidateGoals(projectId: string) {
  revalidatePath(`/projects/${projectId}/arama`);
  revalidatePath(`/projects/${projectId}`);
}

export async function createSeoGoalAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(
      userId,
      field(formData, "projectId").trim(),
    );
    if (!seoReportsActiveFor(access.projectId)) {
      return { ok: false, message: NOT_ON };
    }
    const parsed = CreateSchema.safeParse({
      projectId: field(formData, "projectId"),
      metricKey: field(formData, "metricKey"),
      target: field(formData, "target"),
    });
    if (!parsed.success) return { ok: false, message: INVALID };
    const { metricKey, target: rawTarget } = parsed.data;
    if (!isSeoGoalMetric(metricKey)) {
      return { ok: false, message: INVALID_METRIC };
    }
    const target = Number(rawTarget);
    if (!validSeoGoalTarget(metricKey, target)) {
      return { ok: false, message: INVALID_TARGET };
    }

    const { goalId } = await upsertSeoGoal({
      workspaceId: access.workspaceId,
      projectId: access.projectId,
      brandId: access.defaultBrandId,
      userId,
      metricKey,
      target,
    });
    // Yeni hedefin güncel değeri hemen görünsün; başarısızlık eylemi bozmaz.
    await refreshSeoGoals(access.projectId).catch(() => 0);

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: access.projectId,
      actorType: "USER",
      actorId: userId,
      action: "seo_goal.saved",
      entityType: "ProjectGoal",
      entityId: goalId,
      metadata: { metricKey, target },
    });
    revalidateGoals(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The goal could not be saved.");
  }
}

export async function archiveSeoGoalAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(
      userId,
      field(formData, "projectId").trim(),
    );
    if (!seoReportsActiveFor(access.projectId)) {
      return { ok: false, message: NOT_ON };
    }
    const parsed = ArchiveSchema.safeParse({
      projectId: field(formData, "projectId"),
      goalId: field(formData, "goalId"),
    });
    if (!parsed.success) return { ok: false, message: INVALID };
    const { goalId } = parsed.data;

    // Denetim kaydı için ölçüt anahtarı arşivlemeden ÖNCE okunur.
    const goals = await listSeoGoals(access.projectId).catch(() => []);
    const metricKey = goals.find((goal) => goal.goalId === goalId)?.metricKey;

    const archived = await archiveSeoGoal(access.projectId, goalId);
    if (!archived) return { ok: false, message: GOAL_NOT_FOUND };

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: access.projectId,
      actorType: "USER",
      actorId: userId,
      action: "seo_goal.archived",
      entityType: "ProjectGoal",
      entityId: goalId,
      metadata: { metricKey: metricKey ?? null },
    });
    revalidateGoals(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The goal could not be archived.");
  }
}
