import { describe, expect, it } from "vitest";

import { makeAuditFake } from "./audit-fake";

function clock(start = Date.UTC(2026, 5, 1)) {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const HOUR = 3_600_000;

describe("audit fake", () => {
  it("create returns a row with id and the injected createdAt", async () => {
    const c = clock();
    const fake = makeAuditFake({ now: c.now });
    const row = await fake.create({
      data: { workspaceId: "w1", action: "a", actorId: "u1" },
    });
    expect(typeof row.id).toBe("string");
    expect(row.createdAt).toEqual(new Date(Date.UTC(2026, 5, 1)));
  });

  it("count honours workspaceId, actorId, projectId, action and createdAt.gte", async () => {
    const c = clock();
    const fake = makeAuditFake({ now: c.now });
    const create = (data: Record<string, unknown>) => fake.create({ data });
    await create({
      workspaceId: "w1",
      actorId: "u1",
      projectId: "p1",
      action: "x",
    });
    c.advance(2 * HOUR);
    await create({ workspaceId: "w1", actorId: "u2", action: "x" });
    await create({ workspaceId: "w2", actorId: "u1", action: "y" });

    expect(await fake.count({})).toBe(3);
    expect(await fake.count({ where: { workspaceId: "w1" } })).toBe(2);
    expect(await fake.count({ where: { actorId: "u1" } })).toBe(2);
    expect(await fake.count({ where: { projectId: "p1" } })).toBe(1);
    expect(await fake.count({ where: { action: "x" } })).toBe(2);
    expect(
      await fake.count({
        where: { action: "x", workspaceId: "w1", actorId: "u2" },
      }),
    ).toBe(1);

    const since = new Date(Date.UTC(2026, 5, 1) + HOUR);
    expect(await fake.count({ where: { createdAt: { gte: since } } })).toBe(2);
    // gte is inclusive of the boundary instant
    expect(
      await fake.count({
        where: {
          createdAt: { gte: new Date(Date.UTC(2026, 5, 1) + 2 * HOUR) },
        },
      }),
    ).toBe(2);
    expect(
      await fake.count({
        where: {
          createdAt: { gte: new Date(Date.UTC(2026, 5, 1) + 3 * HOUR) },
        },
      }),
    ).toBe(0);
  });

  it("update reclassifies a row in place without adding one", async () => {
    const fake = makeAuditFake();
    const row = await fake.create({
      data: { workspaceId: "w1", action: "started" },
    });
    await fake.update({ where: { id: row.id }, data: { action: "refused" } });
    expect(fake.snapshot()).toHaveLength(1);
    expect(await fake.count({ where: { action: "started" } })).toBe(0);
    expect(await fake.count({ where: { action: "refused" } })).toBe(1);
    await expect(
      fake.update({ where: { id: "ghost" }, data: {} }),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("findFirst returns the newest matching row for orderBy desc, or null", async () => {
    const c = clock();
    const fake = makeAuditFake({ now: c.now });
    await fake.create({
      data: { workspaceId: "w1", action: "a", entityId: "first" },
    });
    c.advance(HOUR);
    await fake.create({
      data: { workspaceId: "w1", action: "a", entityId: "second" },
    });
    const row = await fake.findFirst({
      where: { action: "a" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.entityId).toBe("second");
    expect(await fake.findFirst({ where: { action: "none" } })).toBeNull();
  });

  it("deleteMany by projectId removes only rows WITH that projectId", async () => {
    const fake = makeAuditFake();
    await fake.create({
      data: { workspaceId: "w1", projectId: "p1", action: "with" },
    });
    await fake.create({
      data: { workspaceId: "w1", projectId: "p2", action: "other" },
    });
    // The cap row: written without any projectId key, so it survives.
    const cap = await fake.create({
      data: { workspaceId: "w1", actorId: "u1", action: "cap" },
    });
    expect("projectId" in cap).toBe(false);

    expect(await fake.deleteMany({ where: { projectId: "p1" } })).toEqual({
      count: 1,
    });
    expect(
      fake
        .snapshot()
        .map((r) => r.action)
        .sort(),
    ).toEqual(["cap", "other"]);
    // A null projectId is not the same as a missing filter match on p1
    expect(await fake.count({ where: { action: "cap" } })).toBe(1);
  });

  it("snapshot() is a deep copy in insertion order", async () => {
    const fake = makeAuditFake();
    await fake.create({
      data: { workspaceId: "w1", action: "a", metadata: { n: 1 } },
    });
    await fake.create({ data: { workspaceId: "w1", action: "b" } });
    const snap = fake.snapshot();
    expect(snap.map((r) => r.action)).toEqual(["a", "b"]);
    const [first] = snap;
    (first?.metadata as { n: number }).n = 99;
    snap.pop();
    expect(fake.snapshot()).toHaveLength(2);
    expect((fake.snapshot()[0]?.metadata as { n: number }).n).toBe(1);
  });
});
