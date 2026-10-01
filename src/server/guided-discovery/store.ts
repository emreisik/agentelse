import "server-only";

import { randomBytes } from "node:crypto";

import {
  DISCOVERY_ROW_TOPIC,
  discoveryRowId,
  parseDiscoveryRecord,
  type DiscoveryRecord,
} from "@/lib/guided-discovery/contract";
import { prisma } from "@/lib/prisma";
import { CommandRepository } from "@/server/repositories/command.repository";

// The discovery row (gd_<projectId>) lives on a Command row with a fixed id and
// its own topic: `parsedIntent.guidedDiscovery`. Every write replaces the whole
// parsedIntent through a compare-and-swap on `guidedDiscovery.rev`, like the
// guided-setup store (which is deliberately not imported here). Workspace and
// project scoping is the caller's job.

const KEY = "guidedDiscovery";

export type DiscoveryScope = {
  workspaceId: string;
  projectId: string;
  brandId?: string;
};

// What a `change` callback returns: the next record (its rev is ignored, the
// store assigns a fresh one) plus a value for the caller, or a refusal.
export type Change<T> = { next: DiscoveryRecord; value: T } | { error: string };

export type Modified<T> =
  // The row is absent, or present but unparseable (reads as absent).
  | { status: "NONE" }
  // `change` refused, or every attempt lost the compare-and-swap.
  | { status: "REJECTED"; error: string }
  | { status: "OK"; value: T; record: DiscoveryRecord };

export type Created = {
  // CREATED: we inserted it (also after replacing an unparseable row).
  // EXISTS: somebody else did, `record` is theirs.
  status: "CREATED" | "EXISTS";
  record: DiscoveryRecord;
};

export type StoreOptions = {
  attempts?: number;
  // Injected in tests; 12 hex chars in production.
  randomId?: () => string;
};

// Returned as REJECTED.error when every attempt lost the compare-and-swap.
export const STORE_CONFLICT =
  "The discovery was changed by another request; try again." as const;

const DEFAULT_ATTEMPTS = 3;
// A vanished row between a P2002 and the read that follows is possible only
// after a project deletion; one more create is enough.
const CREATE_ROUNDS = 3;

const defaultRandomId = () => randomBytes(6).toString("hex");

// Prisma's error carries `code`; the DB-less fake throws a plain Error with the
// same field, so duck-type instead of instanceof.
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function readDiscovery(
  projectId: string,
): Promise<DiscoveryRecord | null> {
  const row = await prisma.command.findUnique({
    where: { id: discoveryRowId(projectId) },
    select: { parsedIntent: true },
  });
  return row ? parseDiscoveryRecord(row.parsedIntent) : null;
}

export async function createDiscoveryIfAbsent(
  input: {
    scope: DiscoveryScope;
    userId: string;
    record: DiscoveryRecord;
  },
  options: StoreOptions = {},
): Promise<Created> {
  const { scope, userId } = input;
  const id = discoveryRowId(scope.projectId);
  const fresh: DiscoveryRecord = {
    ...input.record,
    rev: (options.randomId ?? defaultRandomId)(),
  };
  // A record that would not parse back would strand the project.
  if (!parseDiscoveryRecord({ [KEY]: fresh })) {
    throw new Error("guided discovery: refusing to store an invalid record");
  }

  for (let round = 0; round < CREATE_ROUNDS; round += 1) {
    try {
      await CommandRepository.create({
        id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        topic: DISCOVERY_ROW_TOPIC,
        source: "SYSTEM",
        rawText: DISCOVERY_ROW_TOPIC,
        parsedIntent: { [KEY]: fresh },
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
    const parsed = parseDiscoveryRecord(existing.parsedIntent);
    if (parsed) return { status: "EXISTS", record: parsed };

    // Unparseable (a rollback met a newer shape, or corruption): replace it by
    // id so the project can never be stranded on it.
    const { count } = await prisma.command.updateMany({
      where: { id },
      data: { parsedIntent: { [KEY]: fresh } as never },
    });
    if (count === 1) return { status: "CREATED", record: fresh };
  }
  throw new Error(`guided discovery: could not create ${id}`);
}

export async function modifyDiscovery<T>(
  projectId: string,
  change: (record: DiscoveryRecord) => Change<T>,
  options: StoreOptions = {},
): Promise<Modified<T>> {
  const id = discoveryRowId(projectId);
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const randomId = options.randomId ?? defaultRandomId;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const record = await readDiscovery(projectId);
    if (!record) return { status: "NONE" };
    const changed = change(record);
    if ("error" in changed) return { status: "REJECTED", error: changed.error };
    // `next` comes from the parsed record, so keys a newer deploy wrote survive.
    const next: DiscoveryRecord = { ...changed.next, rev: randomId() };
    const { count } = await prisma.command.updateMany({
      where: {
        id,
        parsedIntent: { path: [KEY, "rev"], equals: record.rev },
      },
      data: { parsedIntent: { [KEY]: next } as never },
    });
    if (count === 1)
      return { status: "OK", value: changed.value, record: next };
  }
  return { status: "REJECTED", error: STORE_CONFLICT };
}
