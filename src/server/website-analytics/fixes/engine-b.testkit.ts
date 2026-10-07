import { Prisma } from "@prisma/client";
import { vi } from "vitest";

import { createMockGaAdminWriter } from "@/server/integrations/google-analytics/admin-write-mock";
import type { GaAdminWriter } from "@/server/integrations/google-analytics/admin-write";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";

// apply.test.ts ve undo.test.ts ortak test düzeneği (P4b): GaConfigChange için
// bellek içi sahte Prisma, bağ/kimlik bilgisi/onay/Task satırları ve mock
// yazıcıyı saran küçük yardımcılar. Prisma'ya vi.spyOn yapılmaz; test dosyası
// "@/lib/prisma" modülünü bu sahteyle değiştirir.

type Row = Record<string, unknown>;

export const NOW = new Date("2026-10-07T10:00:00.000Z");
export const PROPERTY_ID = "424242";
export const STREAM_ID = "555";

function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

function same(a: unknown, b: unknown): boolean {
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const left = isDate(a) ? a.getTime() : Number(a);
  const right = isDate(b) ? b.getTime() : Number(b);
  return left - right;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((w) => matches(row, w));
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === "object" && !isDate(cond)) {
      const ops = cond as Row;
      if ("lt" in ops) return value !== null && compare(value, ops.lt) < 0;
      if ("lte" in ops) return value !== null && compare(value, ops.lte) <= 0;
      if ("not" in ops) return !same(value, ops.not);
      return false;
    }
    return same(value, cond);
  });
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in value) {
      row[key] = Number(row[key] ?? 0) + Number((value as Row).increment);
    } else if (value === Prisma.DbNull) {
      row[key] = null;
    } else {
      row[key] = value;
    }
  }
}

export type FakeState = {
  changes: Map<string, Row>;
  link: Row;
  credential: Row | null;
  approval: Row | null;
  task: Row | null;
  members: Map<string, string>;
  linkUpdates: Row[];
  healthRuns: Row[];
};

export function makeLink(overrides: Row = {}): Row {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    credentialId: "cred-1",
    propertyId: PROPERTY_ID,
    isPrimary: true,
    isMock: true,
    streamId: STREAM_ID,
    serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
    keyEvents: null,
    dataRetention: null,
    ...overrides,
  };
}

export function makeChange(overrides: Row = {}): Row {
  return {
    id: "chg-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    linkId: "link-1",
    kind: "KEY_EVENT_CREATE",
    status: "APPROVED",
    source: "PANEL",
    title: "Mark generate_lead as a key event",
    params: { kind: "KEY_EVENT_CREATE", eventName: "generate_lead" },
    before: null,
    after: null,
    resourceName: null,
    dedupeKey: "KEY_EVENT_CREATE:generate_lead",
    openKey: "KEY_EVENT_CREATE:generate_lead",
    noop: false,
    taskId: "task-1",
    approvalId: "appr-1",
    proposedByType: "USER",
    proposedByUserId: "user-1",
    approvedByUserId: "owner-1",
    undoneByUserId: null,
    attempts: 0,
    nextAttemptAt: null,
    leaseUntil: null,
    leaseOwner: null,
    expiresAt: new Date("2026-10-14T10:00:00.000Z"),
    approvedAt: new Date("2026-10-07T09:00:00.000Z"),
    appliedAt: null,
    verifiedAt: null,
    rolledBackAt: null,
    failedAt: null,
    error: null,
    ...overrides,
  };
}

export const fake: FakeState = {
  changes: new Map(),
  link: makeLink(),
  credential: null,
  approval: null,
  task: null,
  members: new Map(),
  linkUpdates: [],
  healthRuns: [],
};

export function resetFake(
  options: { link?: Row; change?: Row | null } = {},
): void {
  fake.changes.clear();
  fake.link = makeLink(options.link);
  fake.credential = {
    id: "cred-1",
    workspaceId: "ws-1",
    status: "ACTIVE",
    encryptedSecret: "enc",
  };
  fake.approval = { id: "appr-1", status: "APPROVED", expiresAt: null };
  fake.task = { id: "task-1", status: "WAITING_APPROVAL" };
  fake.members = new Map([["ws-1:owner-1", "OWNER"]]);
  fake.linkUpdates = [];
  fake.healthRuns = [];
  if (options.change !== null) {
    const change = makeChange(options.change);
    fake.changes.set(String(change.id), change);
  }
}

export function change(id = "chg-1"): Row {
  const row = fake.changes.get(id);
  if (!row) throw new Error(`no change ${id}`);
  return row;
}

function withLink(row: Row | undefined, args: Row): Row | null {
  if (!row) return null;
  const copy: Row = { ...row };
  if ((args.include as Row | undefined)?.link) copy.link = { ...fake.link };
  return copy;
}

export const fakePrisma = {
  gaConfigChange: {
    findUnique: vi.fn(async (args: Row) => {
      const where = args.where as Row;
      return withLink(fake.changes.get(String(where.id)), args);
    }),
    findFirst: vi.fn(async (args: Row) => {
      const where = args.where as Row;
      const row = [...fake.changes.values()].find((item) =>
        matches(item, where),
      );
      return withLink(row, args);
    }),
    updateMany: vi.fn(async (args: Row) => {
      const where = args.where as Row;
      let count = 0;
      for (const row of fake.changes.values()) {
        if (!matches(row, where)) continue;
        apply(row, args.data as Row);
        count += 1;
      }
      return { count };
    }),
  },
  approval: {
    findFirst: vi.fn(async () => (fake.approval ? { ...fake.approval } : null)),
  },
  integrationCredential: {
    findUnique: vi.fn(async () =>
      fake.credential ? { ...fake.credential } : null,
    ),
  },
  gaPropertyLink: {
    update: vi.fn(async (args: Row) => {
      fake.linkUpdates.push(args.data as Row);
      return {};
    }),
  },
  gaHealthRun: {
    updateMany: vi.fn(async (args: Row) => {
      fake.healthRuns.push(args as Row);
      return { count: 1 };
    }),
  },
  task: {
    findFirst: vi.fn(async () => (fake.task ? { ...fake.task } : null)),
  },
  workspaceMember: {
    findUnique: vi.fn(async (args: Row) => {
      const key = args.where as { workspaceId_userId: Row };
      const { workspaceId, userId } = key.workspaceId_userId;
      const role = fake.members.get(`${String(workspaceId)}:${String(userId)}`);
      return role ? { role } : null;
    }),
  },
};

export const MUTATING_CALLS = [
  "createKeyEvent",
  "deleteKeyEvent",
  "updateDataRetention",
  "updateEnhancedMeasurement",
  "createChannelGroup",
  "deleteChannelGroup",
  "createAnnotation",
  "deleteAnnotation",
];

export function mutating(calls: string[]): string[] {
  return calls.filter((name) => MUTATING_CALLS.includes(name));
}

// Mock yazıcının `method` çağrısı `from`'uncu çağrıdan (0 tabanlı) `to`'ya
// (hariç) kadar hata verir.
export function failingFrom(
  writer: GaAdminWriter,
  method: keyof GaAdminWriter,
  from: number,
  error: GoogleApiError,
  to = Number.POSITIVE_INFINITY,
): GaAdminWriter {
  let count = 0;
  const original = writer[method] as (...args: unknown[]) => Promise<unknown>;
  return {
    ...writer,
    [method]: async (...args: unknown[]) => {
      const index = count;
      count += 1;
      if (index >= from && index < to) throw error;
      return original.apply(writer, args);
    },
  } as GaAdminWriter;
}

export function transientError(): GoogleApiError {
  return new GoogleApiError("Service unavailable", "UNAVAILABLE", {
    httpStatus: 503,
    errorClass: "SERVER_ERROR",
  });
}

export function classedError(
  errorClass: GoogleErrorClass,
  httpStatus?: number,
): GoogleApiError {
  return new GoogleApiError("boom", undefined, { errorClass, httpStatus });
}

export { createMockGaAdminWriter };
