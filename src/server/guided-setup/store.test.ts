import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT,
  IDEAS_TOPIC,
  SESSION_TOPIC,
  ideasRowId,
  sessionRowId,
  type IdeasRecord,
  type SessionRecord,
} from "@/lib/guided-setup/contract";
import { makeAuditFake, type AuditFake } from "@/test-support/audit-fake";
import { makeCommandFake, type CommandFake } from "@/test-support/command-fake";

// The two guided-setup rows on Command: created by primary key, changed only by
// a compare-and-swap on `<key>.rev`, and an unparseable row is replaced instead
// of stranding the project. Everything runs on the in-memory fakes; the shared
// database is never touched.

type Delegates = {
  command: Pick<CommandFake, "create" | "findUnique" | "updateMany">;
  auditLog: Pick<AuditFake, "create">;
};
const db = vi.hoisted(() => ({ current: null as unknown as Delegates }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get command() {
      return db.current.command;
    },
    get auditLog() {
      return db.current.auditLog;
    },
  },
}));

const {
  STORE_CONFLICT,
  createIdeas,
  createSessionIfAbsent,
  isUniqueViolation,
  modifyIdeas,
  modifySession,
  readIdeas,
  readSession,
} = await import("./store");

const PROJECT = "proj_1";
const SCOPE = { workspaceId: "ws_1", projectId: PROJECT, brandId: "brand_1" };
const USER = "usr_1";
const SESSION_ID = sessionRowId(PROJECT);
const IDEAS_ID = ideasRowId(PROJECT);

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    v: 1,
    rev: "aaaaaaaaaaaa",
    editRev: "eeeeeeeeeeee",
    status: "OPEN",
    step: "goal",
    more: false,
    seedFirst: false,
    staticFirst: true,
    answers: {},
    seed: null,
    applyingSinceMs: null,
    applyToken: null,
    goalId: null,
    applied: null,
    lastFailure: null,
    createdAtMs: 1_790_000_000_000,
    updatedAtMs: 1_790_000_000_000,
    updatedByUserId: USER,
    ...overrides,
  };
}

function ideas(overrides: Partial<IdeasRecord> = {}): IdeasRecord {
  return {
    v: 1,
    rev: "bbbbbbbbbbbb",
    status: "RUNNING",
    source: "discovery",
    runId: "run00001",
    attempts: 1,
    options: { business: [], audience: [], angle: [] },
    stats: { kept: 0, dropped: 0 },
    updatedAtMs: 1_790_000_000_000,
    ...overrides,
  };
}

function rowFor(id: string, topic: string, parsedIntent: unknown) {
  return {
    id,
    workspaceId: SCOPE.workspaceId,
    projectId: PROJECT,
    topic,
    source: "SYSTEM",
    rawText: topic,
    parsedIntent,
  };
}

let command: CommandFake;
let audit: AuditFake;

function install(seed: Parameters<typeof makeCommandFake>[0] = {}) {
  command = makeCommandFake(seed);
  audit = makeAuditFake();
  db.current = { command, auditLog: audit };
}

beforeEach(() => install());

function parsedIntentOf(id: string): Record<string, unknown> | null {
  const row = command.snapshot().find((r) => r.id === id);
  return (row?.parsedIntent as Record<string, unknown> | null) ?? null;
}

// A wrapper around the fake whose updateMany lets a rival write first: it bumps
// the stored rev N times right before our compare-and-swap, so our expected rev
// is stale that many times.
function withRivalWrites(key: string, id: string, times: number) {
  let left = times;
  db.current = {
    auditLog: audit,
    command: {
      create: (args) => command.create(args),
      findUnique: (args) => command.findUnique(args),
      updateMany: async (args) => {
        const where = args.where as { parsedIntent?: unknown };
        if (left > 0 && where.parsedIntent) {
          left -= 1;
          const current = parsedIntentOf(id);
          const record = current?.[key] as Record<string, unknown>;
          await command.updateMany({
            where: { id },
            data: {
              parsedIntent: { [key]: { ...record, rev: `rival${left}rev` } },
            },
          });
        }
        return command.updateMany(args);
      },
    },
  };
}

describe("isUniqueViolation", () => {
  it("accepts a real Prisma P2002 and any object with that code", () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
    });
    expect(isUniqueViolation(prismaError)).toBe(true);
    expect(
      isUniqueViolation(Object.assign(new Error("x"), { code: "P2002" })),
    ).toBe(true);
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("P2002"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("P2002")).toBe(false);
  });
});

describe("createSessionIfAbsent", () => {
  it("inserts the row by primary key with the row invariants", async () => {
    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session(),
    });

    expect(result.status).toBe("CREATED");
    const rows = command.snapshot();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      id: SESSION_ID,
      workspaceId: "ws_1",
      projectId: PROJECT,
      brandId: "brand_1",
      topic: SESSION_TOPIC,
      source: "SYSTEM",
      ideaId: null,
      createdByUserId: USER,
    });
    // One key, and never a `card` (several readers match on parsedIntent.card).
    expect(Object.keys(row?.parsedIntent as object)).toEqual(["guidedSetup"]);
    expect(row?.parsedIntent).not.toHaveProperty("card");
    expect(audit.snapshot()).toEqual([]);
  });

  it("assigns a fresh rev instead of trusting the caller's", async () => {
    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session({ rev: "callerrev123" }),
    });
    expect(result.record.rev).not.toBe("callerrev123");
    expect(result.record.rev).toMatch(/^[0-9a-f]{12}$/);
    expect(await readSession(PROJECT)).toEqual(result.record);
  });

  it("tolerates P2002: an existing valid row is returned and nothing changes", async () => {
    const existing = session({
      rev: "existing0001",
      answers: { goal: { picked: ["goal.leads"] } },
    });
    install({
      seed: [rowFor(SESSION_ID, SESSION_TOPIC, { guidedSetup: existing })],
    });
    const before = command.snapshot();

    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session(),
    });

    expect(result).toEqual({ status: "EXISTS", record: existing });
    expect(command.snapshot()).toEqual(before);
    expect(audit.snapshot()).toEqual([]);
  });

  it("G72: an existing row with an unknown extra key still parses and is not reset", async () => {
    const withExtra = {
      ...session({ rev: "existing0002" }),
      futureField: { nested: 1 },
    };
    install({
      seed: [rowFor(SESSION_ID, SESSION_TOPIC, { guidedSetup: withExtra })],
    });

    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session(),
    });

    expect(result.status).toBe("EXISTS");
    expect(result.record).toMatchObject({ futureField: { nested: 1 } });
    expect(audit.snapshot()).toEqual([]);
  });

  it("G72: an UNPARSEABLE existing row is replaced and audited at workspace level", async () => {
    install({
      seed: [
        rowFor(SESSION_ID, SESSION_TOPIC, {
          // A question id this deploy does not know: the whole row fails to parse.
          guidedSetup: {
            ...session(),
            answers: { brandNewQuestion: { picked: ["x"] } },
          },
        }),
      ],
    });
    expect(await readSession(PROJECT)).toBeNull();

    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session({ answers: { goal: { picked: ["goal.leads"] } } }),
    });

    expect(result.status).toBe("RESET");
    expect(await readSession(PROJECT)).toEqual(result.record);
    expect(result.record.answers).toEqual({ goal: { picked: ["goal.leads"] } });
    expect(command.snapshot()).toHaveLength(1);

    const [entry] = audit.snapshot();
    expect(entry).toMatchObject({
      workspaceId: "ws_1",
      actorType: "USER",
      actorId: USER,
      action: AUDIT.sessionReset,
      entityType: "Command",
      entityId: SESSION_ID,
      metadata: { row: "session" },
    });
    // Workspace level: project deletion must not erase the evidence.
    expect(entry).not.toHaveProperty("projectId");
    expect(entry).not.toHaveProperty("brandId");
  });

  it.each([
    ["a null parsedIntent", null],
    ["a parsedIntent without the key", { somethingElse: 1 }],
    ["a non-object record", { guidedSetup: "oops" }],
    ["an array parsedIntent", []],
  ])("replaces a row with %s", async (_label, parsedIntent) => {
    install({ seed: [rowFor(SESSION_ID, SESSION_TOPIC, parsedIntent)] });
    expect(await readSession(PROJECT)).toBeNull();

    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session(),
    });

    expect(result.status).toBe("RESET");
    expect(await readSession(PROJECT)).not.toBeNull();
    expect(audit.snapshot()).toHaveLength(1);
  });

  it("a failing audit write never fails the repair", async () => {
    install({ seed: [rowFor(SESSION_ID, SESSION_TOPIC, null)] });
    db.current = {
      command: db.current.command,
      auditLog: {
        create: () => Promise.reject(new Error("audit table is down")),
      },
    };

    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session(),
    });

    expect(result.status).toBe("RESET");
    expect(await readSession(PROJECT)).not.toBeNull();
  });

  it("inserts again when the row vanished between the P2002 and the read", async () => {
    let creates = 0;
    db.current = {
      auditLog: audit,
      command: {
        create: async (args) => {
          creates += 1;
          if (creates === 1) {
            throw Object.assign(new Error("dup"), { code: "P2002" });
          }
          return command.create(args);
        },
        findUnique: (args) => command.findUnique(args),
        updateMany: (args) => command.updateMany(args),
      },
    };

    const result = await createSessionIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: session(),
    });

    expect(result.status).toBe("CREATED");
    expect(creates).toBe(2);
  });

  it("rethrows an error that is not a unique violation", async () => {
    db.current = {
      auditLog: audit,
      command: {
        create: () =>
          Promise.reject(Object.assign(new Error("x"), { code: "P1001" })),
        findUnique: (args) => command.findUnique(args),
        updateMany: (args) => command.updateMany(args),
      },
    };

    await expect(
      createSessionIfAbsent({ scope: SCOPE, userId: USER, record: session() }),
    ).rejects.toThrow("x");
  });

  it("refuses to store a record that would not parse back", async () => {
    const broken = {
      ...session(),
      status: "WEIRD",
    } as unknown as SessionRecord;

    await expect(
      createSessionIfAbsent({ scope: SCOPE, userId: USER, record: broken }),
    ).rejects.toThrow(/invalid/);
    expect(command.snapshot()).toEqual([]);
  });

  it("eight concurrent starts leave exactly one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createSessionIfAbsent({
          scope: SCOPE,
          userId: USER,
          record: session(),
        }),
      ),
    );

    expect(results.filter((r) => r.status === "CREATED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "EXISTS")).toHaveLength(7);
    expect(command.snapshot()).toHaveLength(1);
    // Everybody sees the winner's record.
    const winner = results.find((r) => r.status === "CREATED");
    for (const result of results) expect(result.record).toEqual(winner?.record);
  });
});

describe("readSession / readIdeas", () => {
  it("read as absent when there is no row", async () => {
    expect(await readSession(PROJECT)).toBeNull();
    expect(await readIdeas(PROJECT)).toBeNull();
  });

  it("read an unparseable row as absent and never write", async () => {
    install({
      seed: [
        rowFor(IDEAS_ID, IDEAS_TOPIC, { guidedIdeas: { v: 2 } }),
        rowFor(SESSION_ID, SESSION_TOPIC, { guidedSetup: { v: 1 } }),
      ],
    });
    const before = command.snapshot();

    expect(await readSession(PROJECT)).toBeNull();
    expect(await readIdeas(PROJECT)).toBeNull();
    expect(command.snapshot()).toEqual(before);
  });

  it("reads only their own row", async () => {
    install({
      seed: [rowFor(IDEAS_ID, IDEAS_TOPIC, { guidedIdeas: ideas() })],
    });
    expect(await readSession(PROJECT)).toBeNull();
    expect(await readIdeas(PROJECT)).toEqual(ideas());
  });
});

describe("modifySession", () => {
  const seedSession = (record: unknown = session()) =>
    install({
      seed: [rowFor(SESSION_ID, SESSION_TOPIC, { guidedSetup: record })],
    });

  it("is NONE when the row is absent, and writes nothing", async () => {
    const change = vi.fn();
    expect(await modifySession(PROJECT, change)).toEqual({ status: "NONE" });
    expect(change).not.toHaveBeenCalled();
    expect(command.snapshot()).toEqual([]);
  });

  it("is NONE when the row does not parse", async () => {
    install({ seed: [rowFor(SESSION_ID, SESSION_TOPIC, null)] });
    const change = vi.fn();
    expect(await modifySession(PROJECT, change)).toEqual({ status: "NONE" });
    expect(change).not.toHaveBeenCalled();
  });

  it("commits the change with a fresh rev and hands back the value", async () => {
    seedSession();

    const result = await modifySession(PROJECT, (record) => ({
      next: { ...record, step: "audience", more: true },
      value: "saved",
    }));

    expect(result.status).toBe("OK");
    if (result.status !== "OK") return;
    expect(result.value).toBe("saved");
    expect(result.record.rev).not.toBe("aaaaaaaaaaaa");
    expect(await readSession(PROJECT)).toEqual(result.record);
    expect(result.record).toMatchObject({ step: "audience", more: true });
  });

  it("changes rev on every write, even when nothing else changed", async () => {
    seedSession();
    const revs = new Set<string>(["aaaaaaaaaaaa"]);

    for (let i = 0; i < 5; i += 1) {
      const result = await modifySession(PROJECT, (record) => ({
        next: record,
        value: null,
      }));
      if (result.status !== "OK") throw new Error("expected OK");
      revs.add(result.record.rev);
    }

    expect(revs.size).toBe(6);
  });

  it("ignores a rev the change callback tries to set", async () => {
    seedSession();
    const result = await modifySession(PROJECT, (record) => ({
      next: { ...record, rev: "chosenbycaller" },
      value: null,
    }));
    if (result.status !== "OK") throw new Error("expected OK");
    expect(result.record.rev).not.toBe("chosenbycaller");
  });

  it("G72: replaces the whole parsedIntent and keeps unknown keys of a loose row", async () => {
    seedSession({
      ...session({
        answers: { goal: { picked: ["goal.leads"], futureAnswerKey: 1 } },
        applied: {
          atMs: 1,
          editRev: "eeeeeeeeeeee",
          parts: ["profile"],
          goalMode: null,
          receiptId: null,
          futureAppliedKey: true,
        },
      }),
      futureTopKey: { a: [1, 2] },
    });

    const result = await modifySession(PROJECT, (record) => ({
      next: { ...record, step: "review" },
      value: null,
    }));
    expect(result.status).toBe("OK");

    const stored = parsedIntentOf(SESSION_ID);
    expect(Object.keys(stored ?? {})).toEqual(["guidedSetup"]);
    expect(stored?.guidedSetup).toMatchObject({
      step: "review",
      futureTopKey: { a: [1, 2] },
      answers: { goal: { picked: ["goal.leads"], futureAnswerKey: 1 } },
      applied: { futureAppliedKey: true },
    });
  });

  it("gives up with REJECTED after the default 3 attempts when every commit loses", async () => {
    seedSession();
    withRivalWrites("guidedSetup", SESSION_ID, 99);
    const change = vi.fn((record: SessionRecord) => ({
      next: record,
      value: null,
    }));

    const result = await modifySession(PROJECT, change);

    expect(result).toEqual({ status: "REJECTED", error: STORE_CONFLICT });
    expect(change).toHaveBeenCalledTimes(3);
  });

  it("honours a larger attempts budget and wins once the rival stops", async () => {
    seedSession();
    withRivalWrites("guidedSetup", SESSION_ID, 4);
    const change = vi.fn((record: SessionRecord) => ({
      next: { ...record, step: "tone" as const },
      value: "won",
    }));

    const result = await modifySession(PROJECT, change, { attempts: 5 });

    expect(result.status).toBe("OK");
    expect(change).toHaveBeenCalledTimes(5);
    expect((await readSession(PROJECT))?.step).toBe("tone");
  });

  it("retries on a fresh read, so the change sees the rival's write", async () => {
    seedSession();
    withRivalWrites("guidedSetup", SESSION_ID, 1);
    const seen: string[] = [];

    const result = await modifySession(PROJECT, (record) => {
      seen.push(record.rev);
      return { next: record, value: null };
    });

    expect(result.status).toBe("OK");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe("aaaaaaaaaaaa");
    expect(seen[1]).toBe("rival0rev");
  });

  it("attempts: 1 makes a single try", async () => {
    seedSession();
    withRivalWrites("guidedSetup", SESSION_ID, 1);
    const change = vi.fn((record: SessionRecord) => ({
      next: record,
      value: null,
    }));

    const result = await modifySession(PROJECT, change, { attempts: 1 });

    expect(result).toEqual({ status: "REJECTED", error: STORE_CONFLICT });
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("passes a refusal through and writes nothing", async () => {
    seedSession();
    const before = command.snapshot();

    const result = await modifySession(PROJECT, () => ({ error: "BUSY" }));

    expect(result).toEqual({ status: "REJECTED", error: "BUSY" });
    expect(command.snapshot()).toEqual(before);
  });

  it("never lets a lost commit apply: eight concurrent increments all land exactly once", async () => {
    seedSession();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        modifySession(
          PROJECT,
          (record) => ({
            next: { ...record, createdAtMs: record.createdAtMs + 1 },
            value: null,
          }),
          { attempts: 12 },
        ),
      ),
    );

    expect(results.every((r) => r.status === "OK")).toBe(true);
    expect((await readSession(PROJECT))?.createdAtMs).toBe(
      1_790_000_000_000 + 8,
    );
  });

  it("does not touch the ideas row", async () => {
    install({
      seed: [
        rowFor(SESSION_ID, SESSION_TOPIC, { guidedSetup: session() }),
        rowFor(IDEAS_ID, IDEAS_TOPIC, { guidedIdeas: ideas() }),
      ],
    });
    const ideasBefore = command.snapshot().find((r) => r.id === IDEAS_ID);

    await modifySession(PROJECT, (record) => ({ next: record, value: null }));

    expect(command.snapshot().find((r) => r.id === IDEAS_ID)).toEqual(
      ideasBefore,
    );
  });
});

describe("ideas rows", () => {
  it("createIdeas inserts by primary key with the ideas topic", async () => {
    const result = await createIdeas({
      scope: SCOPE,
      userId: USER,
      record: ideas(),
    });

    expect(result.status).toBe("CREATED");
    const [row] = command.snapshot();
    expect(row).toMatchObject({
      id: IDEAS_ID,
      topic: IDEAS_TOPIC,
      source: "SYSTEM",
      ideaId: null,
    });
    expect(Object.keys(row?.parsedIntent as object)).toEqual(["guidedIdeas"]);
  });

  it("createIdeas replaces an unparseable row and audits it as an ideas reset", async () => {
    install({
      seed: [
        rowFor(IDEAS_ID, IDEAS_TOPIC, {
          guidedIdeas: { ...ideas(), status: "SOMETHING_NEW" },
        }),
      ],
    });

    const result = await createIdeas({
      scope: SCOPE,
      userId: USER,
      record: ideas(),
    });

    expect(result.status).toBe("RESET");
    expect(await readIdeas(PROJECT)).toEqual(result.record);
    expect(audit.snapshot()[0]).toMatchObject({
      action: AUDIT.sessionReset,
      entityId: IDEAS_ID,
      metadata: { row: "ideas" },
    });
    expect(audit.snapshot()[0]).not.toHaveProperty("projectId");
  });

  it("createIdeas leaves a valid existing row (with an unknown key) alone", async () => {
    const existing = { ...ideas({ status: "READY" }), futureKey: 1 };
    install({
      seed: [rowFor(IDEAS_ID, IDEAS_TOPIC, { guidedIdeas: existing })],
    });
    const before = command.snapshot();

    const result = await createIdeas({
      scope: SCOPE,
      userId: USER,
      record: ideas(),
    });

    expect(result.status).toBe("EXISTS");
    expect(command.snapshot()).toEqual(before);
  });

  it("modifyIdeas uses 3 attempts by default and 5 when asked", async () => {
    install({
      seed: [rowFor(IDEAS_ID, IDEAS_TOPIC, { guidedIdeas: ideas() })],
    });
    withRivalWrites("guidedIdeas", IDEAS_ID, 99);
    const change = vi.fn((record: IdeasRecord) => ({
      next: record,
      value: null,
    }));

    expect((await modifyIdeas(PROJECT, change)).status).toBe("REJECTED");
    expect(change).toHaveBeenCalledTimes(3);

    change.mockClear();
    expect((await modifyIdeas(PROJECT, change, { attempts: 5 })).status).toBe(
      "REJECTED",
    );
    expect(change).toHaveBeenCalledTimes(5);
  });

  it("modifyIdeas commits with a new rev and keeps unknown keys", async () => {
    install({
      seed: [
        rowFor(IDEAS_ID, IDEAS_TOPIC, {
          guidedIdeas: { ...ideas(), futureKey: "keep" },
        }),
      ],
    });

    const result = await modifyIdeas(PROJECT, (record) => ({
      next: { ...record, status: "READY" },
      value: 1,
    }));

    expect(result.status).toBe("OK");
    const stored = parsedIntentOf(IDEAS_ID)?.guidedIdeas as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({ status: "READY", futureKey: "keep" });
    expect(stored.rev).not.toBe("bbbbbbbbbbbb");
  });

  it("modifyIdeas is NONE for an unparseable row", async () => {
    install({ seed: [rowFor(IDEAS_ID, IDEAS_TOPIC, { guidedIdeas: 5 })] });
    expect(await modifyIdeas(PROJECT, () => ({ error: "x" }))).toEqual({
      status: "NONE",
    });
  });
});
