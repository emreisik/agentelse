import "server-only";

import { randomBytes } from "node:crypto";

import type { z } from "zod";

import {
  AUDIT,
  IDEAS_TOPIC,
  IdeasRecordSchema,
  SESSION_TOPIC,
  SessionRecordSchema,
  ideasRowId,
  sessionRowId,
  type IdeasRecord,
  type SessionRecord,
} from "@/lib/guided-setup/contract";
import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CommandRepository } from "@/server/repositories/command.repository";

// The two guided-setup rows (spec 6.1) live on Command rows with fixed ids and
// their own topics: `parsedIntent.guidedSetup` and `parsedIntent.guidedIdeas`.
// Every write replaces the whole parsedIntent through a compare-and-swap on
// `<key>.rev`, exactly like the work-session store. This file parses with the
// contract's schemas directly and imports neither session.ts nor ideas.ts.

export type StoreScope = {
  workspaceId: string;
  projectId: string;
  brandId?: string;
};

// What a `change` callback returns: the next record (its rev is ignored, the
// store assigns a fresh one) plus a value for the caller, or a refusal.
export type Change<R, T> = { next: R; value: T } | { error: string };

export type Modified<R, T> =
  // The row is absent, or present but unparseable (reads as absent).
  | { status: "NONE" }
  // `change` refused, or every attempt lost the compare-and-swap.
  | { status: "REJECTED"; error: string }
  | { status: "OK"; value: T; record: R };

export type Created<R> = {
  // CREATED: we inserted it. EXISTS: somebody else did, `record` is theirs.
  // RESET: an unparseable row was replaced by ours (and audited).
  status: "CREATED" | "EXISTS" | "RESET";
  record: R;
};

export type ModifyOptions = { attempts?: number };

// Returned as REJECTED.error when every attempt lost the compare-and-swap.
export const STORE_CONFLICT =
  "The setup was changed by another request; try again." as const;

const DEFAULT_ATTEMPTS = 3;
// A vanished row between a P2002 and the read that follows is possible only
// after a project deletion; one more create is enough.
const CREATE_ROUNDS = 3;

const newRev = () => randomBytes(6).toString("hex");

// Prisma's PrismaClientKnownRequestError carries `code`; the DB-less test fake
// throws a plain Error with the same field, so duck-type instead of instanceof.
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

type RowKind<R extends { rev: string }> = {
  key: "guidedSetup" | "guidedIdeas";
  topic: string;
  auditRow: "session" | "ideas";
  idOf: (projectId: string) => string;
  schema: z.ZodType<R>;
};

const SESSION_KIND: RowKind<SessionRecord> = {
  key: "guidedSetup",
  topic: SESSION_TOPIC,
  auditRow: "session",
  idOf: sessionRowId,
  schema: SessionRecordSchema as z.ZodType<SessionRecord>,
};

const IDEAS_KIND: RowKind<IdeasRecord> = {
  key: "guidedIdeas",
  topic: IDEAS_TOPIC,
  auditRow: "ideas",
  idOf: ideasRowId,
  schema: IdeasRecordSchema as z.ZodType<IdeasRecord>,
};

function parseRow<R extends { rev: string }>(
  kind: RowKind<R>,
  parsedIntent: unknown,
): R | null {
  if (typeof parsedIntent !== "object" || parsedIntent === null) return null;
  const parsed = kind.schema.safeParse(
    (parsedIntent as Record<string, unknown>)[kind.key],
  );
  return parsed.success ? parsed.data : null;
}

async function read<R extends { rev: string }>(
  kind: RowKind<R>,
  projectId: string,
): Promise<R | null> {
  const row = await prisma.command.findUnique({
    where: { id: kind.idOf(projectId) },
    select: { parsedIntent: true },
  });
  return row ? parseRow(kind, row.parsedIntent) : null;
}

// Best effort: the trail must never turn a repaired row into a failure. The
// row is workspace-level (no projectId), so a project deletion cannot erase the
// only evidence that a reset happened.
async function auditReset(
  kind: RowKind<{ rev: string }>,
  scope: StoreScope,
  userId: string,
  rowId: string,
): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: scope.workspaceId,
      actorType: "USER",
      actorId: userId,
      action: AUDIT.sessionReset,
      entityType: "Command",
      entityId: rowId,
      metadata: { row: kind.auditRow },
    });
  } catch {
    // Nothing to do: the reset itself already succeeded.
  }
}

async function create<R extends { rev: string }>(
  kind: RowKind<R>,
  input: { scope: StoreScope; userId: string; record: R },
): Promise<Created<R>> {
  // A record that would not parse back would strand the project again.
  if (!kind.schema.safeParse(input.record).success) {
    throw new Error(`guided setup: refusing to store an invalid ${kind.key}`);
  }
  const { scope, userId } = input;
  const id = kind.idOf(scope.projectId);
  const fresh: R = { ...input.record, rev: newRev() };

  for (let round = 0; round < CREATE_ROUNDS; round += 1) {
    try {
      await CommandRepository.create({
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        topic: kind.topic,
        source: "SYSTEM",
        rawText: kind.topic,
        parsedIntent: { [kind.key]: fresh },
        createdByUserId: userId,
      });
      return { status: "CREATED", record: fresh };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await prisma.command.findUnique({
      where: { id },
      select: { parsedIntent: true },
    });
    if (!existing) continue; // deleted in between: insert again
    const parsed = parseRow(kind, existing.parsedIntent);
    if (parsed) return { status: "EXISTS", record: parsed };

    // Unparseable (a rollback met a newer shape, or corruption): replace it
    // unconditionally by id, so the project can never be stranded on it.
    const { count } = await prisma.command.updateMany({
      where: { id },
      data: { parsedIntent: { [kind.key]: fresh } as never },
    });
    if (count === 1) {
      await auditReset(kind, scope, userId, id);
      return { status: "RESET", record: fresh };
    }
  }
  throw new Error(`guided setup: could not create ${id}`);
}

async function modify<R extends { rev: string }, T>(
  kind: RowKind<R>,
  projectId: string,
  change: (record: R) => Change<R, T>,
  attempts: number,
): Promise<Modified<R, T>> {
  const id = kind.idOf(projectId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const record = await read(kind, projectId);
    if (!record) return { status: "NONE" };
    const changed = change(record);
    if ("error" in changed) return { status: "REJECTED", error: changed.error };
    // `next` comes from the parsed record, so keys a newer deploy wrote survive.
    const next: R = { ...changed.next, rev: newRev() };
    const { count } = await prisma.command.updateMany({
      where: {
        id,
        parsedIntent: { path: [kind.key, "rev"], equals: record.rev },
      },
      data: { parsedIntent: { [kind.key]: next } as never },
    });
    if (count === 1)
      return { status: "OK", value: changed.value, record: next };
  }
  return { status: "REJECTED", error: STORE_CONFLICT };
}

// Session row (gs_<projectId>): user actions only.
export const readSession = (projectId: string) => read(SESSION_KIND, projectId);

export const createSessionIfAbsent = (input: {
  scope: StoreScope;
  userId: string;
  record: SessionRecord;
}) => create(SESSION_KIND, input);

export const modifySession = <T>(
  projectId: string,
  change: (record: SessionRecord) => Change<SessionRecord, T>,
  options: ModifyOptions = {},
) =>
  modify(SESSION_KIND, projectId, change, options.attempts ?? DEFAULT_ATTEMPTS);

// Ideas row (gi_<projectId>): the paid-run claim, the runner, adoption.
export const readIdeas = (projectId: string) => read(IDEAS_KIND, projectId);

export const createIdeas = (input: {
  scope: StoreScope;
  userId: string;
  record: IdeasRecord;
}) => create(IDEAS_KIND, input);

export const modifyIdeas = <T>(
  projectId: string,
  change: (record: IdeasRecord) => Change<IdeasRecord, T>,
  options: ModifyOptions = {},
) =>
  modify(IDEAS_KIND, projectId, change, options.attempts ?? DEFAULT_ATTEMPTS);
