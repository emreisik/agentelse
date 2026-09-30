import "server-only";

import {
  AUDIT,
  DISCOVERY_LIMITS,
  type DiscoveryCaps,
} from "@/lib/guided-setup/contract";
import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// Durable caps on the paid "Get ideas" run (spec 8.3).
//
// The counters are AuditLog rows of action AUDIT.discoveryStarted, and those
// rows are WORKSPACE-LEVEL: no projectId and no brandId (the project id rides in
// entityId). ProjectDeletionService deletes every row that has a projectId
// value, so a row that carried one would vanish with its project and a
// "create project, Get ideas, delete project" loop would never reach a cap
// (guard G53). The count queries therefore never mention projectId either.

export type DiscoveryScope = "user" | "workspace" | "global";

export type ReserveDiscoveryInput = {
  workspaceId: string;
  userId: string;
  projectId: string;
  runId: string;
  attempt: number;
  nowMs: number;
  // discoveryCaps(): the ceilings, or lower via GUIDED_SETUP_DISCOVERY_CAPS.
  caps: DiscoveryCaps;
};

export type ReserveDiscoveryResult =
  { ok: true; auditId: string } | { ok: false; scope: DiscoveryScope };

// Last time a refusal was logged, per scope (in-memory: a log throttle, never a
// spend control). The clock is the caller's nowMs.
const lastLoggedAtMs = new Map<DiscoveryScope, number>();

function logCapReached(scope: DiscoveryScope, nowMs: number): void {
  const last = lastLoggedAtMs.get(scope);
  if (last !== undefined && nowMs - last < DISCOVERY_LIMITS.capLogIntervalMs) {
    return;
  }
  lastLoggedAtMs.set(scope, nowMs);
  console.error("[guided-setup] discovery cap reached", { scope });
}

// Test hook: forgets which scopes were logged.
export function resetDiscoveryCapLog(): void {
  lastLoggedAtMs.clear();
}

type Counts = { user: number; workspace: number; global: number };

// The first scope (user, then workspace, then global) whose count is over.
function firstScopeOver(
  counts: Counts,
  caps: DiscoveryCaps,
  over: (count: number, cap: number) => boolean,
): DiscoveryScope | null {
  if (over(counts.user, caps.perUserPer24h)) return "user";
  if (over(counts.workspace, caps.perWorkspacePer24h)) return "workspace";
  if (over(counts.global, caps.globalPer24h)) return "global";
  return null;
}

async function countStarted(
  i: ReserveDiscoveryInput,
  since: Date,
): Promise<Counts> {
  const base = { action: AUDIT.discoveryStarted, createdAt: { gte: since } };
  const [user, workspace, global] = await Promise.all([
    prisma.auditLog.count({
      where: { ...base, workspaceId: i.workspaceId, actorId: i.userId },
    }),
    prisma.auditLog.count({ where: { ...base, workspaceId: i.workspaceId } }),
    prisma.auditLog.count({ where: base }),
  ]);
  return { user, workspace, global };
}

// A refused reservation is converted so it stops counting as "started".
export async function releaseDiscovery(i: {
  auditId: string;
  runId: string;
  attempt: number;
  reason: string;
}): Promise<void> {
  await AuditLogRepository.reclassify(i.auditId, AUDIT.discoveryRefused, {
    runId: i.runId,
    attempt: i.attempt,
    reason: i.reason,
  });
}

// Read-only pre-count, then insert-then-count. Two racing starts at the cap may
// BOTH be refused (fail closed); more than the cap can never both be admitted.
// A repository error propagates: the caller claims nothing (fail closed).
export async function reserveDiscovery(
  i: ReserveDiscoveryInput,
): Promise<ReserveDiscoveryResult> {
  const since = new Date(i.nowMs - DISCOVERY_LIMITS.windowMs);

  // 1. Already at a cap: refuse without writing, so hammering a capped button
  // costs reads only.
  const early = firstScopeOver(
    await countStarted(i, since),
    i.caps,
    (count, cap) => count >= cap,
  );
  if (early) {
    logCapReached(early, i.nowMs);
    return { ok: false, scope: early };
  }

  // 2. Insert first so racing starts see each other. No projectId, no brandId.
  const mine = await AuditLogRepository.record({
    workspaceId: i.workspaceId,
    actorType: "USER",
    actorId: i.userId,
    action: AUDIT.discoveryStarted,
    entityType: "Project",
    entityId: i.projectId,
    metadata: { runId: i.runId, attempt: i.attempt },
  });

  // 3. Count again, the row just written included: over the cap means we lost.
  const late = firstScopeOver(
    await countStarted(i, since),
    i.caps,
    (count, cap) => count > cap,
  );
  if (late) {
    await releaseDiscovery({
      auditId: mine.id,
      runId: i.runId,
      attempt: i.attempt,
      reason: late,
    });
    logCapReached(late, i.nowMs);
    return { ok: false, scope: late };
  }

  return { ok: true, auditId: mine.id };
}
