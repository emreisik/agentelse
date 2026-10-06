"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/components/shared/action-form";
import { prisma } from "@/lib/prisma";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { gaReportsEnabledFor } from "@/lib/website-analytics/reports/flags";
import { readWebsiteReportCard } from "@/lib/website-analytics/reports/card";
import { isWebsiteGoalKey } from "@/lib/website-analytics/reports/goal-keys";
import { parseGaReportSettingsForm } from "@/lib/website-analytics/reports/settings";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { primaryGaLink } from "@/server/website-analytics/store";
import { GaGoals } from "@/server/website-analytics/reports/goals";
import { saveGaReportSettings } from "@/server/website-analytics/reports/settings";

// Website reports eylemleri (GA-F5, docs/website-reports.md): rapor ayarları
// (Settings → Autonomy) ve "Use these targets" (Next month plan kartı). İkisi de
// oturumu ve proje erişimini doğrular, sonra bayrağı sınar. Hiç fırlatmaz;
// hata metni istemciye aynen gitmez (erişim hataları kimlik taşır).

const REPORTS_OFF = "Website reports are off.";
const PLAN_NOT_FOUND = "Plan not found.";
const PAST_PLAN = "This plan is for a past month.";
const NO_TARGETS = "Pick at least one target.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";

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
  // Yalnız hata adı: mesaj Google verisi ya da kimlik taşıyabilir.
  console.error(
    "[website-reports] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// Command.parsedIntent = { card: ... }; biçimi bozuk satır null verir.
function storedCardOf(parsedIntent: unknown): unknown {
  if (
    parsedIntent &&
    typeof parsedIntent === "object" &&
    !Array.isArray(parsedIntent)
  ) {
    return (parsedIntent as { card?: unknown }).card;
  }
  return null;
}

export async function updateGaReportSettingsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!gaReportsEnabledFor(projectId)) {
      return { ok: false, message: REPORTS_OFF };
    }
    const parsed = parseGaReportSettingsForm(formData);
    if (!parsed.ok) return { ok: false, message: parsed.message };

    await saveGaReportSettings({
      workspaceId: access.workspaceId,
      projectId,
      userId,
      value: parsed.value,
    });
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "website_report_settings.updated",
      entityType: "GaReportSettings",
      entityId: projectId,
      metadata: parsed.value,
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the report settings.");
  }
}

// "Use these targets": hedefler yalnız SAKLI karttaki önerilerden yazılır;
// istemciden gelen sayılar hiç okunmaz (yalnız hangi metricKey'lerin seçildiği).
export async function applyGaPlanTargetsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const commandId = field(formData, "commandId");
    const selected = formData
      .getAll("metricKey")
      .filter((value): value is string => typeof value === "string")
      .filter(isWebsiteGoalKey);

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!gaReportsEnabledFor(projectId)) {
      return { ok: false, message: REPORTS_OFF };
    }

    // projectId koşulu başka projenin kartını reddeder.
    const command = commandId
      ? await prisma.command.findFirst({
          where: { id: commandId, projectId },
          select: { parsedIntent: true },
        })
      : null;
    const card = command
      ? readWebsiteReportCard(storedCardOf(command.parsedIntent))
      : null;
    if (!card || card.body.variant !== "plan") {
      return { ok: false, message: PLAN_NOT_FOUND };
    }
    const plan = card.body;

    // Geçmiş aya ait plan hedef yazmaz (ProjectGoal'da dönem kolonu yok).
    const timeZone = await getProjectTimezone(projectId);
    const currentMonth = utcToZonedDateTimeLocal(new Date(), timeZone).slice(
      0,
      7,
    );
    if (plan.month < currentMonth) return { ok: false, message: PAST_PLAN };

    const offered = new Set(plan.proposals.map((p) => p.metricKey));
    const metricKeys = selected.filter((key) => offered.has(key));
    if (metricKeys.length === 0) return { ok: false, message: NO_TARGETS };

    const link = await primaryGaLink(projectId);
    const result = await GaGoals.applyPlanTargets({
      projectId,
      workspaceId: access.workspaceId,
      userId,
      proposals: plan.proposals,
      metricKeys,
      isMock: link?.isMock ?? card.isMock,
    });
    // Yeni hedefin bu ayki ilerlemesi hemen görünsün; başarısızlık eylemi bozmaz.
    await GaGoals.refreshProject(projectId).catch(() => 0);

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "website_goals.applied",
      entityType: "Command",
      entityId: commandId,
      metadata: {
        month: plan.month,
        metricKeys,
        created: result.created,
        updated: result.updated,
      },
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the targets.");
  }
}
