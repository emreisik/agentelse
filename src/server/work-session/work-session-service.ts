import "server-only";

import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CommandRepository } from "@/server/repositories/command.repository";

import {
  WORK_SESSION_TOPIC,
  WorkSessionSchema,
  applyUpdate,
  createSession,
  isLive,
  progressOf,
  recordSpend,
  type SessionUpdate,
  type UpdateOutcome,
  type WorkSession,
} from "./session";

// Stores work sessions (session.ts) on Command rows tagged with
// WORK_SESSION_TOPIC: the checkpoint is `parsedIntent.workSession`. No table,
// no queue, nothing the legacy agency loop reads. A project has one live
// session at a time, and only its newest row is ever looked at.

export type SessionScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type StoredSession = { id: string; session: WorkSession };

// Two requests can update the same session at once (two tabs). Every write
// says which version it read; the loser re-reads and applies its change again.
const COMMIT_ATTEMPTS = 3;

const newRev = () => randomBytes(6).toString("hex");

async function latestRow(projectId: string): Promise<StoredSession | null> {
  const row = await prisma.command.findFirst({
    where: { projectId, topic: WORK_SESSION_TOPIC },
    orderBy: { createdAt: "desc" },
    select: { id: true, parsedIntent: true },
  });
  if (!row) return null;
  const parsed = WorkSessionSchema.safeParse(
    (row.parsedIntent as { workSession?: unknown } | null)?.workSession,
  );
  return parsed.success ? { id: row.id, session: parsed.data } : null;
}

async function commit(row: StoredSession, next: WorkSession): Promise<boolean> {
  const { count } = await prisma.command.updateMany({
    where: {
      id: row.id,
      parsedIntent: { path: ["workSession", "rev"], equals: row.session.rev },
    },
    data: { parsedIntent: { workSession: next } as never },
  });
  return count === 1;
}

type Change<T> = { next: WorkSession; value: T } | { error: string };

type Modified<T> =
  | { status: "NONE" }
  | { status: "REJECTED"; error: string }
  | { status: "OK"; id: string; value: T; session: WorkSession };

// Read the project's live session, let `change` produce the next state, write
// it if nobody else did in between.
async function modifyLive<T>(
  projectId: string,
  now: Date,
  change: (session: WorkSession) => Change<T>,
  sessionId?: string,
): Promise<Modified<T>> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    const row = await latestRow(projectId);
    if (!row || !isLive(row.session, now)) return { status: "NONE" };
    if (sessionId && row.id !== sessionId) return { status: "NONE" };
    const changed = change(row.session);
    if ("error" in changed) return { status: "REJECTED", error: changed.error };
    const next = { ...changed.next, rev: newRev() };
    if (await commit(row, next)) {
      return { status: "OK", id: row.id, value: changed.value, session: next };
    }
  }
  return {
    status: "REJECTED",
    error: "The session was changed by another request; try again.",
  };
}

// Best effort: the trail must never turn a saved checkpoint into a failure.
async function audit(
  scope: SessionScope,
  action: string,
  entityId: string,
  userId: string | undefined,
  metadata: Record<string, unknown>,
) {
  await AuditLogRepository.record({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    actorType: userId ? "USER" : "SYSTEM",
    actorId: userId,
    action,
    entityType: "Command",
    entityId,
    metadata,
  }).catch((error) => {
    console.error(`[work-session] audit ${action} failed:`, error);
  });
}

type Applied = Extract<UpdateOutcome, { ok: true }>;

export type StartResult =
  | { status: "STARTED"; id: string; session: WorkSession }
  | { status: "ALREADY_ACTIVE"; id: string; session: WorkSession }
  | { status: "INVALID"; error: string };

export type UpdateResult =
  | {
      status: "UPDATED";
      session: WorkSession;
      ended: "COMPLETED" | "CANCELLED" | null;
      ignored: string[];
    }
  | { status: "NONE" }
  | { status: "REJECTED"; error: string };

export const WorkSessionService = {
  // The project's live session, if any.
  async getLive(
    projectId: string,
    now = new Date(),
  ): Promise<StoredSession | null> {
    const row = await latestRow(projectId);
    return row && isLive(row.session, now) ? row : null;
  },

  async start(
    scope: SessionScope,
    input: { goal: string; steps: readonly string[]; userId?: string },
    now = new Date(),
  ): Promise<StartResult> {
    const live = await WorkSessionService.getLive(scope.projectId, now);
    if (live) return { status: "ALREADY_ACTIVE", ...live };

    const created = createSession(input, now, newRev());
    if (!created.ok) return { status: "INVALID", error: created.error };

    const command = await CommandRepository.create({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      source: "SYSTEM",
      topic: WORK_SESSION_TOPIC,
      rawText: created.session.goal,
      parsedIntent: { workSession: created.session },
      createdByUserId: input.userId,
    });
    await audit(scope, "work_session.started", command.id, input.userId, {
      steps: created.session.steps.length,
    });
    return { status: "STARTED", id: command.id, session: created.session };
  },

  async update(
    scope: SessionScope,
    update: SessionUpdate,
    options: { freeText: boolean; userId?: string },
    now = new Date(),
  ): Promise<UpdateResult> {
    const modified = await modifyLive<Applied>(
      scope.projectId,
      now,
      (session): Change<Applied> => {
        const outcome = applyUpdate(session, update, {
          now,
          freeText: options.freeText,
        });
        return outcome.ok
          ? { next: outcome.session, value: outcome }
          : { error: outcome.error };
      },
    );
    if (modified.status !== "OK") return modified;

    const { ended, ignored } = modified.value;
    if (ended) {
      await audit(
        scope,
        ended === "COMPLETED"
          ? "work_session.completed"
          : "work_session.cancelled",
        modified.id,
        options.userId,
        {
          ...progressOf(modified.session),
          reason: modified.session.endReason,
        },
      );
    }
    return { status: "UPDATED", session: modified.session, ended, ignored };
  },

  // One more message of the session has used `usd` of model spend. Reaching
  // the session's ceiling closes it (session.ts). `sessionId` keeps a message
  // from charging a newer session it never touched.
  async addSpend(
    scope: SessionScope,
    sessionId: string,
    usd: number,
    now = new Date(),
  ): Promise<void> {
    const modified = await modifyLive(
      scope.projectId,
      now,
      (session) => ({ next: recordSpend(session, usd, now), value: null }),
      sessionId,
    );
    if (
      modified.status === "OK" &&
      modified.session.status === "CANCELLED" &&
      modified.session.endReason === "budget"
    ) {
      await audit(scope, "work_session.cancelled", sessionId, undefined, {
        ...progressOf(modified.session),
        reason: "budget",
        spentUsd: modified.session.spentUsd,
      });
    }
  },
};
