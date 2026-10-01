import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DISCOVERY_ROW_TOPIC,
  discoveryRowId,
  emptyRecord,
  type DiscoveryRecord,
} from "@/lib/guided-discovery/contract";
import { makeCommandFake, type CommandFake } from "@/test-support/command-fake";

// The discovery row: created by primary key, changed only by a compare-and-swap
// on `guidedDiscovery.rev`, and an unparseable row is replaced instead of
// stranding the project. Runs on the in-memory fake; no database.

type Delegates = {
  command: Pick<CommandFake, "create" | "findUnique" | "updateMany">;
};
const db = vi.hoisted(() => ({ current: null as unknown as Delegates }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get command() {
      return db.current.command;
    },
  },
}));

const {
  STORE_CONFLICT,
  createDiscoveryIfAbsent,
  modifyDiscovery,
  readDiscovery,
} = await import("./store");

const PROJECT = "proj_1";
const ROW_ID = discoveryRowId(PROJECT);
const SCOPE = { workspaceId: "ws_1", projectId: PROJECT, brandId: "brand_1" };
const USER = "usr_1";

function record(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    ...emptyRecord({
      rev: "aaaaaaaaaaaa",
      nowMs: 1_790_000_000_000,
      host: "example.com",
      stages: {
        site: "pending",
        identity: "pending",
        research: "pending",
        profile: "pending",
      },
    }),
    ...overrides,
  };
}

function counter() {
  let n = 0;
  return () => `r${String(++n).padStart(11, "0")}`;
}

let fake: CommandFake;

beforeEach(() => {
  fake = makeCommandFake();
  db.current = { command: fake };
});

describe("createDiscoveryIfAbsent", () => {
  it("creates the row with the fixed id, topic and a fresh rev", async () => {
    const result = await createDiscoveryIfAbsent(
      { scope: SCOPE, userId: USER, record: record() },
      { randomId: () => "bbbbbbbbbbbb" },
    );
    expect(result.status).toBe("CREATED");
    expect(result.record.rev).toBe("bbbbbbbbbbbb");
    const row = fake.snapshot()[0]!;
    expect(row.id).toBe(ROW_ID);
    expect(row.topic).toBe(DISCOVERY_ROW_TOPIC);
    expect(row.source).toBe("SYSTEM");
    expect(row.projectId).toBe(PROJECT);
    expect(await readDiscovery(PROJECT)).toEqual(result.record);
  });

  it("returns EXISTS with the stored record and writes nothing on a duplicate", async () => {
    const first = await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record({ host: "first.com" }),
    });
    const before = fake.snapshot();
    const second = await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record({ host: "second.com" }),
    });
    expect(second.status).toBe("EXISTS");
    expect(second.record.host).toBe("first.com");
    expect(second.record.rev).toBe(first.record.rev);
    expect(fake.snapshot()).toEqual(before);
  });

  it("replaces an unparseable row so the project is never stranded", async () => {
    fake = makeCommandFake({
      seed: [
        {
          id: ROW_ID,
          workspaceId: "ws_1",
          projectId: PROJECT,
          topic: DISCOVERY_ROW_TOPIC,
          source: "SYSTEM",
          rawText: DISCOVERY_ROW_TOPIC,
          parsedIntent: { guidedDiscovery: { v: 9, junk: true } },
        },
      ],
    });
    db.current = { command: fake };
    expect(await readDiscovery(PROJECT)).toBeNull();

    const result = await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record({ host: "fresh.com" }),
    });
    expect(result.status).toBe("CREATED");
    expect((await readDiscovery(PROJECT))?.host).toBe("fresh.com");
    expect(fake.snapshot()).toHaveLength(1);
  });

  it("refuses to store a record that would not parse back", async () => {
    const bad = { ...record(), status: "NOPE" } as unknown as DiscoveryRecord;
    await expect(
      createDiscoveryIfAbsent({ scope: SCOPE, userId: USER, record: bad }),
    ).rejects.toThrow(/invalid/);
    expect(fake.snapshot()).toHaveLength(0);
  });
});

describe("modifyDiscovery", () => {
  it("reports NONE when there is no row", async () => {
    const out = await modifyDiscovery(PROJECT, (r) => ({
      next: r,
      value: 1,
    }));
    expect(out).toEqual({ status: "NONE" });
  });

  it("changes the rev on every write", async () => {
    await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record(),
    });
    const revs = new Set<string>();
    const randomId = counter();
    for (let i = 0; i < 3; i += 1) {
      const out = await modifyDiscovery(
        PROJECT,
        (r) => ({ next: { ...r, attempts: i }, value: i }),
        { randomId },
      );
      expect(out.status).toBe("OK");
      if (out.status === "OK") revs.add(out.record.rev);
    }
    expect(revs.size).toBe(3);
  });

  it("lets exactly one of two racers win the compare-and-swap", async () => {
    await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record(),
    });
    // Both read the same rev before either writes; only one write may land, the
    // loser is rejected because attempts is 1 (no retry).
    const gate = Promise.withResolvers<void>();
    const racer = (label: string) =>
      modifyDiscovery(
        PROJECT,
        (r) => ({ next: { ...r, runId: label }, value: label }),
        { attempts: 1 },
      ).then(async (out) => {
        await gate.promise;
        return out;
      });
    const both = Promise.all([racer("a"), racer("b")]);
    gate.resolve();
    const outs = await both;
    const wins = outs.filter((o) => o.status === "OK");
    const losses = outs.filter((o) => o.status === "REJECTED");
    expect(wins.length + losses.length).toBe(2);
    expect(wins).toHaveLength(1);
    // The stored row belongs to a winner.
    const stored = await readDiscovery(PROJECT);
    expect(["a", "b"]).toContain(stored?.runId);
  });

  it("wins once when two writers hold the same stale rev", async () => {
    await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record(),
    });
    const real = fake.updateMany.bind(fake);
    // Interleave: the first writer's update lands between the second writer's
    // read and write, so the second sees a stale rev on its first attempt.
    let interfered = false;
    db.current = {
      command: {
        create: fake.create.bind(fake),
        findUnique: fake.findUnique.bind(fake),
        updateMany: async (args) => {
          if (!interfered) {
            interfered = true;
            await modifyDiscovery(
              PROJECT,
              (r) => ({ next: { ...r, attempts: 1 }, value: null }),
              { randomId: () => "cccccccccccc" },
            );
          }
          return real(args);
        },
      },
    };
    const out = await modifyDiscovery(PROJECT, (r) => ({
      next: { ...r, attempts: r.attempts + 10 },
      value: r.attempts,
    }));
    // Retried once on the interfering write: the change saw attempts === 1.
    expect(out.status).toBe("OK");
    if (out.status === "OK") expect(out.value).toBe(1);
    expect((await readDiscovery(PROJECT))?.attempts).toBe(11);
  });

  it("retries a stale rev, then gives up with a conflict result", async () => {
    await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record(),
    });
    let calls = 0;
    db.current = {
      command: {
        create: fake.create.bind(fake),
        findUnique: fake.findUnique.bind(fake),
        // Every compare-and-swap loses.
        updateMany: async () => {
          calls += 1;
          return { count: 0 };
        },
      },
    };
    const before = fake.snapshot();
    const out = await modifyDiscovery(PROJECT, (r) => ({
      next: { ...r, attempts: 2 },
      value: 1,
    }));
    expect(out).toEqual({ status: "REJECTED", error: STORE_CONFLICT });
    expect(calls).toBe(3);
    expect(fake.snapshot()).toEqual(before);
  });

  it("passes a refusal from the change callback through without writing", async () => {
    await createDiscoveryIfAbsent({
      scope: SCOPE,
      userId: USER,
      record: record(),
    });
    const before = fake.snapshot();
    const out = await modifyDiscovery(PROJECT, () => ({ error: "nope" }));
    expect(out).toEqual({ status: "REJECTED", error: "nope" });
    expect(fake.snapshot()).toEqual(before);
  });

  it("keeps unknown keys a newer build wrote", async () => {
    fake = makeCommandFake({
      seed: [
        {
          id: ROW_ID,
          workspaceId: "ws_1",
          projectId: PROJECT,
          topic: DISCOVERY_ROW_TOPIC,
          source: "SYSTEM",
          rawText: DISCOVERY_ROW_TOPIC,
          parsedIntent: { guidedDiscovery: { ...record(), futureKey: "keep" } },
        },
      ],
    });
    db.current = { command: fake };
    const out = await modifyDiscovery(PROJECT, (r) => ({
      next: { ...r, attempts: 2 },
      value: null,
    }));
    expect(out.status).toBe("OK");
    const row = fake.snapshot()[0]!;
    const stored = (
      row.parsedIntent as { guidedDiscovery: Record<string, unknown> }
    ).guidedDiscovery;
    expect(stored.futureKey).toBe("keep");
    expect(stored.attempts).toBe(2);
  });
});
