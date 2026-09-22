import "server-only";

import type { AgencyLoopStatus, AgencyTriggerType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// The shared pause check every autonomous engine should call before
// creating new work for a project — see AgencyLoopHeartbeat, which keeps
// AgencyLoopState.status synced from Project.status as the first step of
// every tick, before any other engine runs. Falls back to reading
// Project.status directly when no AgencyLoopState row exists yet (a
// brand-new project that hasn't had a heartbeat tick), so the check is
// correct even before the heartbeat has ever run for it.
export async function isProjectAgencyActive(
  projectId: string,
): Promise<boolean> {
  const state = await prisma.agencyLoopState.findUnique({
    where: { projectId },
    select: { status: true },
  });
  if (state) return state.status !== "PAUSED";

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true },
  });
  return project?.status !== "PAUSED";
}

export type AgencyLoopScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

// Control/telemetry for whether a project's agency loop is actually
// operating — see AgencyLoopState's schema comment. Every write here is
// best-effort from the caller's perspective (see continuous-agency-engine.ts,
// which wraps every call in .catch(() => undefined)) — this state must
// never be able to break real trigger/task processing.
export const AgencyLoopStateRepository = {
  getForProject(projectId: string) {
    return prisma.agencyLoopState.findUnique({ where: { projectId } });
  },

  // Idempotent lazy init — safe to call every tick for every project with
  // any agency activity. No backfill migration needed for existing
  // projects; the row is created on first contact.
  async getOrCreate(scope: AgencyLoopScope) {
    const existing = await prisma.agencyLoopState.findUnique({
      where: { projectId: scope.projectId },
    });
    if (existing) return existing;
    return prisma.agencyLoopState.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
      },
    });
  },

  // A processed cycle for this project did something real this tick
  // (a handler ran and had a task/check/handoff to act on) — resets the
  // no-progress streak and clears any stale PAUSED/BLOCKED reason left
  // over from before the work arrived.
  recordProgress(projectId: string, triggerType?: AgencyTriggerType) {
    const now = new Date();
    return prisma.agencyLoopState.update({
      where: { projectId },
      data: {
        status: "RUNNING",
        lastTickAt: now,
        lastProgressAt: now,
        lastTriggerType: triggerType,
        consecutiveNoProgressCycles: 0,
        blockedReason: null,
      },
    });
  },

  // A cycle was processed for this project but produced no observable
  // change (e.g. the trigger's payload had nothing left to act on).
  // Phase 7's circuit breaker reads consecutiveNoProgressCycles to decide
  // when to move a project to WAITING.
  recordNoProgress(projectId: string, triggerType?: AgencyTriggerType) {
    return prisma.agencyLoopState.update({
      where: { projectId },
      data: {
        lastTickAt: new Date(),
        lastTriggerType: triggerType,
        consecutiveNoProgressCycles: { increment: 1 },
      },
    });
  },

  // Heartbeat only, for a project with no trigger this tick — keeps
  // lastTickAt fresh without touching the no-progress streak (that streak
  // is reserved for an actually-processed cycle's outcome, not silence).
  touch(projectId: string) {
    return prisma.agencyLoopState.update({
      where: { projectId },
      data: { lastTickAt: new Date() },
    });
  },

  setPaused(projectId: string, blockedReason: string) {
    return prisma.agencyLoopState.update({
      where: { projectId },
      data: { status: "PAUSED", blockedReason, lastTickAt: new Date() },
    });
  },

  resumeFromPause(projectId: string) {
    return prisma.agencyLoopState.update({
      where: { projectId },
      data: { status: "RUNNING", blockedReason: null, lastTickAt: new Date() },
    });
  },

  setStatus(
    projectId: string,
    status: AgencyLoopStatus,
    extra?: { blockedReason?: string | null; nextWakeAt?: Date | null },
  ) {
    return prisma.agencyLoopState.update({
      where: { projectId },
      data: {
        status,
        blockedReason: extra?.blockedReason,
        nextWakeAt: extra?.nextWakeAt,
      },
    });
  },

  listForProjects(projectIds: string[]) {
    return prisma.agencyLoopState.findMany({
      where: { projectId: { in: projectIds } },
    });
  },
};
