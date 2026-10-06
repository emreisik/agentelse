"use server";

import { revalidatePath } from "next/cache";

import { AdsFlags } from "@/lib/ads/flags";
import { prisma } from "@/lib/prisma";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { AdsSync } from "@/server/ads/sync/runner";
import { driveJobInline } from "@/server/chat/inline-job";
import { TaskPlanner } from "@/server/commands/task-planner";
import { loadAdsAccount } from "@/server/modules/ads/account";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Ads sayfası ve Ads sohbet kartının güvenlik eylemleri (docs/meta-ads-plan.md
// F2): "Pause all" ve tek nesne duraklatma META_SAFETY_ACTION görevidir;
// kullanıcının tıklaması onaydır (L0) ve iş hemen, satır içinde sürülür.

export type PauseResult =
  | { ok: true; paused: number; failed: number; message?: string }
  | { ok: false; message: string };

async function runSafety(
  projectId: string,
  payload: Record<string, unknown>,
  request: string,
): Promise<PauseResult> {
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  const account = await loadAdsAccount(projectId);
  if (!account.adAccountId) {
    return { ok: false, message: "Connect a Meta ad account first." };
  }
  const planned = await TaskPlanner.planForCapability({
    workspaceId: access.workspaceId,
    projectId,
    brandId: access.defaultBrandId,
    capability: "META_SAFETY_ACTION",
    request,
    createdByType: "USER",
    createdByUserId: userId,
    departmentKey: "PERFORMANCE_MARKETING",
    payloadExtra: { ...payload, adAccountId: account.adAccountId },
  });
  if (!planned.dispatched || !("job" in planned) || !planned.job) {
    return { ok: false, message: "Couldn't start the pause. Try again." };
  }
  const settled = await driveJobInline(planned.job.id, "LOW");
  const job = await prisma.executionJob.findUnique({
    where: { id: planned.job.id },
    select: { rawResult: true },
  });
  const raw = (job?.rawResult ?? {}) as {
    paused?: unknown[];
    failed?: unknown[];
    providerResult?: { rawResult?: { paused?: unknown[]; failed?: unknown[] } };
  };
  const result = raw.providerResult?.rawResult ?? raw;
  const paused = Array.isArray(result.paused) ? result.paused.length : 0;
  const failed = Array.isArray(result.failed) ? result.failed.length : 0;
  revalidatePath(`/projects/${projectId}/ads`);
  if (settled.status === "COMPLETED") return { ok: true, paused, failed };
  if (settled.status === "QUEUED" || settled.status === "RUNNING") {
    return {
      ok: true,
      paused,
      failed,
      message: "Pausing is still going. It finishes in a moment.",
    };
  }
  return {
    ok: false,
    message: settled.errorMessage ?? "Meta didn't accept the pause. Try again.",
  };
}

export async function pauseAllAdsAction(projectId: string): Promise<PauseResult> {
  try {
    return await runSafety(
      projectId,
      { action: "PAUSE_ALL", reason: "User pressed Pause all" },
      "Pause all ads",
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Couldn't pause your ads.",
    };
  }
}

export async function pauseAdsObjectAction(
  projectId: string,
  level: "CAMPAIGN" | "ADSET" | "AD",
  externalId: string,
): Promise<PauseResult> {
  try {
    if (!/^\d+$/.test(externalId)) {
      return { ok: false, message: "Unknown ad object." };
    }
    return await runSafety(
      projectId,
      { action: "PAUSE", targets: [{ level, id: externalId }], reason: "User pressed Pause" },
      `Pause ${level.toLowerCase()} ${externalId}`,
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Couldn't pause it.",
    };
  }
}

export async function refreshAdsMirrorAction(
  projectId: string,
): Promise<{ ok: true; state: "refreshed" | "throttled" | "busy" | "unavailable" } | { ok: false; message: string }> {
  try {
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    if (!AdsFlags.sync()) return { ok: true, state: "unavailable" };
    const state = await AdsSync.refreshNow(projectId);
    if (state === "refreshed") revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true, state };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Couldn't refresh.",
    };
  }
}

export async function muteAdsAlertAction(
  projectId: string,
  alertId: string,
): Promise<{ ok: boolean }> {
  const { userId } = await requireUser();
  await requireProjectAccess(userId, projectId);
  await AdsAlerts.mute(alertId, projectId, 7);
  revalidatePath(`/projects/${projectId}/ads`);
  return { ok: true };
}
