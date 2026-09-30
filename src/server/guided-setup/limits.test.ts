import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT,
  DISCOVERY_LIMITS,
  parseDiscoveryCaps,
  type DiscoveryCaps,
} from "@/lib/guided-setup/contract";
import { makeAuditFake, type AuditFake } from "@/test-support/audit-fake";

// Guards G04, G05, G08, G53, G64 (pre-count) and G65 of the durable discovery
// caps. The audit table is an in-memory fake with an injected clock; the real
// AuditLogRepository sits on top of it.

const holder = vi.hoisted(() => ({ fake: null as unknown }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: (args: unknown) =>
        (holder.fake as AuditFake).create(args as Record<string, unknown>),
      update: (args: unknown) =>
        (holder.fake as AuditFake).update(args as Record<string, unknown>),
      count: (args: unknown) =>
        (holder.fake as AuditFake).count(args as Record<string, unknown>),
    },
  },
}));

const { releaseDiscovery, reserveDiscovery, resetDiscoveryCapLog } =
  await import("./limits");

const NOW = Date.UTC(2026, 8, 30, 12);
const HOUR = 3_600_000;
const CEILINGS = parseDiscoveryCaps("");

let clockMs = NOW;
let fake: AuditFake;

function reserve(
  overrides: Partial<{
    workspaceId: string;
    userId: string;
    projectId: string;
    runId: string;
    attempt: number;
    nowMs: number;
    caps: DiscoveryCaps;
  }> = {},
) {
  return reserveDiscovery({
    workspaceId: "w1",
    userId: "u1",
    projectId: "p1",
    runId: "r1",
    attempt: 1,
    nowMs: clockMs,
    caps: CEILINGS,
    ...overrides,
  });
}

function rowsOf(action: string) {
  return fake.snapshot().filter((row) => row.action === action);
}

beforeEach(() => {
  clockMs = NOW;
  fake = makeAuditFake({ now: () => new Date(clockMs) });
  holder.fake = fake;
  resetDiscoveryCapLog();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defaults", () => {
  it("the ceilings are 5 / 10 / 20 per 24 h (DISCOVERY_LIMITS, no module state)", () => {
    expect(CEILINGS).toEqual({
      perUserPer24h: 5,
      perWorkspacePer24h: 10,
      globalPer24h: 20,
    });
    expect(DISCOVERY_LIMITS.windowMs).toBe(24 * HOUR);
  });
});

describe("G04: the (N+1)th start is refused", () => {
  it("per user", async () => {
    for (let n = 1; n <= 5; n += 1) {
      const result = await reserve({ projectId: `p${n}`, runId: `r${n}` });
      expect(result.ok, `start ${n}`).toBe(true);
    }
    expect(await reserve({ projectId: "p6", runId: "r6" })).toEqual({
      ok: false,
      scope: "user",
    });
    expect(rowsOf(AUDIT.discoveryStarted)).toHaveLength(5);
  });

  it("per workspace (each user stays under its own cap)", async () => {
    for (let n = 1; n <= 10; n += 1) {
      const result = await reserve({
        userId: `u${Math.ceil(n / 3)}`,
        projectId: `p${n}`,
        runId: `r${n}`,
      });
      expect(result.ok, `start ${n}`).toBe(true);
    }
    // A fresh user, so only the workspace cap can refuse.
    expect(await reserve({ userId: "u9", projectId: "p11" })).toEqual({
      ok: false,
      scope: "workspace",
    });
  });

  it("globally (each workspace and user stays under its own cap)", async () => {
    for (let n = 1; n <= 20; n += 1) {
      const result = await reserve({
        workspaceId: `w${n}`,
        userId: `u${n}`,
        projectId: `p${n}`,
        runId: `r${n}`,
      });
      expect(result.ok, `start ${n}`).toBe(true);
    }
    expect(
      await reserve({ workspaceId: "w99", userId: "u99", projectId: "p99" }),
    ).toEqual({ ok: false, scope: "global" });
  });

  it("uses the caps it is given (a lowered cap refuses sooner)", async () => {
    const lowered = parseDiscoveryCaps("1,2,4");
    expect((await reserve({ caps: lowered })).ok).toBe(true);
    expect(await reserve({ caps: lowered, projectId: "p2" })).toEqual({
      ok: false,
      scope: "user",
    });
  });

  it("0,0,0 pauses ideas: refused with no write", async () => {
    const paused = parseDiscoveryCaps("0,0,0");
    expect(await reserve({ caps: paused })).toEqual({
      ok: false,
      scope: "user",
    });
    expect(fake.snapshot()).toHaveLength(0);
  });

  it("only rows inside the trailing 24 h count", async () => {
    for (let n = 1; n <= 5; n += 1) {
      await reserve({ projectId: `p${n}`, runId: `r${n}` });
    }
    expect((await reserve({ projectId: "p6" })).ok).toBe(false);

    clockMs += 24 * HOUR + 1;
    expect((await reserve({ projectId: "p7", runId: "r7" })).ok).toBe(true);
  });

  it("counts only the started action (a refused or finished row does not count)", async () => {
    for (let n = 1; n <= 5; n += 1) {
      await fake.create({
        data: {
          workspaceId: "w1",
          actorId: "u1",
          action: n % 2 ? AUDIT.discoveryRefused : AUDIT.discoveryFinished,
          entityId: `p${n}`,
        },
      });
    }
    expect((await reserve()).ok).toBe(true);
  });
});

describe("G64: pre-count", () => {
  it("over the cap performs ZERO inserts and ZERO updates", async () => {
    for (let n = 1; n <= 5; n += 1) {
      await reserve({ projectId: `p${n}`, runId: `r${n}` });
    }
    const create = vi.spyOn(fake, "create");
    const update = vi.spyOn(fake, "update");

    for (let n = 0; n < 4; n += 1) {
      expect((await reserve({ projectId: `x${n}` })).ok).toBe(false);
    }

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(fake.snapshot()).toHaveLength(5);
  });
});

describe("G05: races", () => {
  it("two concurrent reservations at a cap of 1 are never both admitted", async () => {
    const caps: DiscoveryCaps = { ...CEILINGS, perUserPer24h: 1 };
    const results = await Promise.all([
      reserve({ caps, projectId: "pa", runId: "ra" }),
      reserve({ caps, projectId: "pb", runId: "rb" }),
    ]);

    const admitted = results.filter((result) => result.ok);
    expect(admitted.length).toBeLessThanOrEqual(1);
    // Every loser released its row: what still counts is exactly what was admitted.
    expect(rowsOf(AUDIT.discoveryStarted)).toHaveLength(admitted.length);
  });

  it("many concurrent reservations never admit more than the cap", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        reserve({ projectId: `p${n}`, runId: `r${n}` }),
      ),
    );
    expect(results.filter((result) => result.ok).length).toBeLessThanOrEqual(5);
    expect(rowsOf(AUDIT.discoveryStarted).length).toBeLessThanOrEqual(5);
  });
});

describe("G08: release", () => {
  it("a refused reservation is converted and stops counting", async () => {
    const caps: DiscoveryCaps = { ...CEILINGS, perUserPer24h: 1 };
    // Two racers: both may be refused, but the losers' rows are converted.
    const results = await Promise.all([
      reserve({ caps, projectId: "pa", runId: "ra", attempt: 2 }),
      reserve({ caps, projectId: "pb", runId: "rb", attempt: 3 }),
    ]);
    const refusedRows = rowsOf(AUDIT.discoveryRefused);
    expect(refusedRows).toHaveLength(results.filter((r) => !r.ok).length);
    expect(refusedRows.length).toBeGreaterThan(0);
    for (const row of refusedRows) {
      expect(row.metadata).toMatchObject({ reason: "user" });
      expect(row.metadata).toHaveProperty("runId");
      expect(row.metadata).toHaveProperty("attempt");
    }
  });

  it("releaseDiscovery reclassifies an admitted row with {runId, attempt, reason} and frees the slot", async () => {
    const caps: DiscoveryCaps = { ...CEILINGS, perUserPer24h: 1 };
    const first = await reserve({ caps, runId: "r1", attempt: 1 });
    if (!first.ok) throw new Error("expected the first start to be admitted");
    expect((await reserve({ caps, projectId: "p2" })).ok).toBe(false);

    await releaseDiscovery({
      auditId: first.auditId,
      runId: "r1",
      attempt: 1,
      reason: "busy",
    });

    const released = fake.snapshot().find((row) => row.id === first.auditId);
    expect(released?.action).toBe(AUDIT.discoveryRefused);
    expect(released?.metadata).toEqual({
      runId: "r1",
      attempt: 1,
      reason: "busy",
    });
    expect(rowsOf(AUDIT.discoveryStarted)).toHaveLength(0);
    // The slot is free again.
    expect((await reserve({ caps, projectId: "p3", runId: "r3" })).ok).toBe(
      true,
    );
  });
});

describe("G53: the caps survive project deletion", () => {
  it("the object passed to create has no projectId and no brandId key", async () => {
    const create = vi.spyOn(fake, "create");
    await reserve({ projectId: "P" });

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(Object.keys(arg.data)).not.toContain("projectId");
    expect(Object.keys(arg.data)).not.toContain("brandId");
    expect(arg.data).toMatchObject({
      workspaceId: "w1",
      actorType: "USER",
      actorId: "u1",
      action: AUDIT.discoveryStarted,
      entityType: "Project",
      entityId: "P",
      metadata: { runId: "r1", attempt: 1 },
    });
  });

  it("the count queries never mention projectId", async () => {
    const count = vi.spyOn(fake, "count");
    await reserve();
    expect(count).toHaveBeenCalled();
    for (const [args] of count.mock.calls) {
      expect(JSON.stringify(args)).not.toContain("projectId");
    }
  });

  it("a create-reserve-delete loop admits exactly the cap", async () => {
    let admitted = 0;
    for (let n = 0; n < 12; n += 1) {
      const result = await reserve({ projectId: `P${n}`, runId: `r${n}` });
      if (result.ok) admitted += 1;
      // What ProjectDeletionService does to every table with a projectId column.
      await fake.deleteMany({ where: { projectId: `P${n}` } });
    }
    expect(admitted).toBe(5);
    expect(rowsOf(AUDIT.discoveryStarted)).toHaveLength(5);
  });

  it("reserve for P, delete P's rows: it still counts and a NEW project of the same user is refused at cap+1", async () => {
    const caps: DiscoveryCaps = { ...CEILINGS, perUserPer24h: 1 };
    expect((await reserve({ caps, projectId: "P" })).ok).toBe(true);

    await fake.deleteMany({ where: { projectId: "P" } });

    expect(rowsOf(AUDIT.discoveryStarted)).toHaveLength(1);
    expect(await reserve({ caps, projectId: "Q", runId: "r2" })).toEqual({
      ok: false,
      scope: "user",
    });
  });
});

describe("fail closed", () => {
  it("a repository throw on the count propagates and writes nothing", async () => {
    vi.spyOn(fake, "count").mockRejectedValue(new Error("db down"));
    await expect(reserve()).rejects.toThrow("db down");
    expect(fake.snapshot()).toHaveLength(0);
  });

  it("a repository throw on the insert propagates", async () => {
    vi.spyOn(fake, "create").mockRejectedValue(new Error("insert failed"));
    await expect(reserve()).rejects.toThrow("insert failed");
  });

  it("a throw while releasing propagates", async () => {
    vi.spyOn(fake, "update").mockRejectedValue(new Error("update failed"));
    const caps: DiscoveryCaps = { ...CEILINGS, perUserPer24h: 1 };
    await expect(
      Promise.all([
        reserve({ caps, projectId: "pa" }),
        reserve({ caps, projectId: "pb" }),
      ]),
    ).rejects.toThrow("update failed");
  });
});

describe("G65: the refusal log", () => {
  const logged = () =>
    vi
      .mocked(console.error)
      .mock.calls.filter(
        (call) => call[0] === "[guided-setup] discovery cap reached",
      );

  it("fires once per scope per hour", async () => {
    const caps: DiscoveryCaps = { ...CEILINGS, perUserPer24h: 1 };
    await reserve({ caps });

    for (let n = 0; n < 5; n += 1) {
      await reserve({ caps, projectId: `x${n}` });
    }
    expect(logged()).toHaveLength(1);
    expect(logged()[0]?.[1]).toEqual({ scope: "user" });

    clockMs += HOUR - 1;
    await reserve({ caps, projectId: "y" });
    expect(logged()).toHaveLength(1);

    clockMs += 1;
    await reserve({ caps, projectId: "z" });
    expect(logged()).toHaveLength(2);
  });

  it("throttles each scope on its own", async () => {
    const caps: DiscoveryCaps = {
      perUserPer24h: 1,
      perWorkspacePer24h: 10,
      globalPer24h: 1,
    };
    await reserve({ caps });
    // Same user: user scope. Another workspace and user: global scope.
    await reserve({ caps, projectId: "a" });
    await reserve({ caps, workspaceId: "w2", userId: "u2", projectId: "b" });
    await reserve({ caps, projectId: "c" });
    await reserve({ caps, workspaceId: "w2", userId: "u2", projectId: "d" });

    const scopes = logged().map((call) => (call[1] as { scope: string }).scope);
    expect(scopes.sort()).toEqual(["global", "user"]);
  });

  it("does not log an admitted start", async () => {
    await reserve();
    expect(logged()).toHaveLength(0);
  });
});
