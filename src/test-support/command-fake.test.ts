import { describe, expect, it } from "vitest";

import { makeCommandFake } from "./command-fake";

const KEY = "guidedSetup";

function sessionData(
  id: string,
  rev: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    workspaceId: "w1",
    projectId: "p1",
    topic: "GUIDED_SETUP",
    source: "SYSTEM",
    rawText: "",
    parsedIntent: { [KEY]: { rev, answers: {} } },
    ...extra,
  };
}

function casWhere(id: string, rev: string) {
  return { id, parsedIntent: { path: [KEY, "rev"], equals: rev } };
}

describe("command fake: create and reads", () => {
  it("stores the row under the given id and reads it back by findUnique", async () => {
    const fake = makeCommandFake();
    const created = await fake.create({ data: sessionData("c1", "r1") });
    expect(created.id).toBe("c1");
    expect(await fake.findUnique({ where: { id: "c1" } })).toMatchObject({
      id: "c1",
      projectId: "p1",
      brandId: null,
    });
    expect(await fake.findUnique({ where: { id: "nope" } })).toBeNull();
  });

  it("generates an id when none is given", async () => {
    const fake = makeCommandFake();
    const a = await fake.create({
      data: { workspaceId: "w", source: "WEB", rawText: "a" },
    });
    const b = await fake.create({
      data: { workspaceId: "w", source: "WEB", rawText: "b" },
    });
    expect(typeof a.id).toBe("string");
    expect(a.id).not.toBe(b.id);
  });

  it("throws P2002 on a duplicate id and leaves the first row untouched", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    const before = fake.snapshot();
    await expect(
      fake.create({ data: sessionData("c1", "other") }),
    ).rejects.toMatchObject({
      code: "P2002",
    });
    expect(fake.snapshot()).toEqual(before);
  });

  it("findFirst filters, orders by createdAt desc and honours select", async () => {
    let tick = 0;
    const fake = makeCommandFake({ now: () => new Date(1000 + tick++) });
    await fake.create({ data: sessionData("old", "r1") });
    await fake.create({ data: sessionData("new", "r2") });
    await fake.create({
      data: sessionData("other", "r3", { projectId: "p2" }),
    });
    const row = await fake.findFirst({
      where: { projectId: "p1", topic: "GUIDED_SETUP" },
      orderBy: { createdAt: "desc" },
      select: { id: true, parsedIntent: true },
    });
    expect(row).toEqual({
      id: "new",
      parsedIntent: { [KEY]: { rev: "r2", answers: {} } },
    });
    expect(await fake.findFirst({ where: { projectId: "none" } })).toBeNull();
  });

  it("a same-instant tie under desc returns the later insert", async () => {
    const fake = makeCommandFake({ now: () => new Date(5) });
    await fake.create({ data: sessionData("a", "r1") });
    await fake.create({ data: sessionData("b", "r1") });
    const row = await fake.findFirst({ orderBy: { createdAt: "desc" } });
    expect(row?.id).toBe("b");
  });

  it("update merges given fields and throws P2025 for a missing row", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    await fake.update({
      where: { id: "c1" },
      data: { replyText: "hi", brandId: undefined },
    });
    expect(await fake.findUnique({ where: { id: "c1" } })).toMatchObject({
      replyText: "hi",
      brandId: null,
      projectId: "p1",
    });
    await expect(
      fake.update({ where: { id: "zzz" }, data: { replyText: "x" } }),
    ).rejects.toMatchObject({
      code: "P2025",
    });
  });
});

describe("command fake: JSON-path compare-and-set", () => {
  it("the matching rev wins once, the same stale rev then returns count 0", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    const next = { parsedIntent: { [KEY]: { rev: "r2", answers: { a: 1 } } } };

    expect(
      await fake.updateMany({ where: casWhere("c1", "r1"), data: next }),
    ).toEqual({ count: 1 });
    expect(
      await fake.updateMany({ where: casWhere("c1", "r1"), data: next }),
    ).toEqual({ count: 0 });
    expect(
      await fake.updateMany({
        where: casWhere("c1", "r2"),
        data: { parsedIntent: { [KEY]: { rev: "r3" } } },
      }),
    ).toEqual({ count: 1 });
    expect(
      (await fake.findUnique({ where: { id: "c1" } }))?.parsedIntent,
    ).toEqual({ [KEY]: { rev: "r3" } });
  });

  it("racing writers holding the same rev produce exactly one winner", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        fake.updateMany({
          where: casWhere("c1", "r1"),
          data: { parsedIntent: { [KEY]: { rev: `w${i}` } } },
        }),
      ),
    );
    expect(results.filter((r) => r.count === 1)).toHaveLength(1);
  });

  it("a missing key, a null column and an unknown id return count 0 and write nothing", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    await fake.create({
      data: { id: "c2", workspaceId: "w1", source: "WEB", rawText: "x" },
    });
    const before = fake.snapshot();
    const data = { parsedIntent: { [KEY]: { rev: "zz" } } };

    expect(
      await fake.updateMany({
        where: {
          id: "c1",
          parsedIntent: { path: ["otherKey", "rev"], equals: "r1" },
        },
        data,
      }),
    ).toEqual({ count: 0 });
    expect(
      await fake.updateMany({ where: casWhere("c2", "r1"), data }),
    ).toEqual({ count: 0 });
    expect(
      await fake.updateMany({ where: casWhere("ghost", "r1"), data }),
    ).toEqual({ count: 0 });
    expect(fake.snapshot()).toEqual(before);
  });

  it("updateMany by id alone overwrites unconditionally", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    expect(
      await fake.updateMany({
        where: { id: "c1" },
        data: { parsedIntent: { [KEY]: { rev: "fresh" } } },
      }),
    ).toEqual({ count: 1 });
    expect(
      (await fake.findUnique({ where: { id: "c1" } }))?.parsedIntent,
    ).toEqual({ [KEY]: { rev: "fresh" } });
  });

  it("throws on a filter shape it does not model instead of silently matching", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    await expect(
      fake.updateMany({ where: { id: { startsWith: "c" } }, data: {} }),
    ).rejects.toThrow(/unsupported operator/);
  });
});

describe("command fake: isolation", () => {
  it("snapshot() is a deep copy: mutating it changes nothing in the fake", async () => {
    const fake = makeCommandFake();
    await fake.create({ data: sessionData("c1", "r1") });
    const snap = fake.snapshot();
    (snap[0]?.parsedIntent as { guidedSetup: { rev: string } }).guidedSetup.rev =
      "hacked";
    snap.pop();
    expect(fake.snapshot()).toHaveLength(1);
    expect(
      (fake.snapshot()[0]?.parsedIntent as { guidedSetup: { rev: string } })
        .guidedSetup.rev,
    ).toBe("r1");
  });

  it("rows do not alias the objects the caller passed or received", async () => {
    const fake = makeCommandFake();
    const input = sessionData("c1", "r1");
    const created = await fake.create({ data: input });
    (input.parsedIntent[KEY] as { rev: string }).rev = "mutated-input";
    (created.parsedIntent as { guidedSetup: { rev: string } }).guidedSetup.rev =
      "mutated-result";
    expect(
      (fake.snapshot()[0]?.parsedIntent as { guidedSetup: { rev: string } })
        .guidedSetup.rev,
    ).toBe("r1");
  });

  it("seed rows exist from the start", async () => {
    const fake = makeCommandFake({ seed: [sessionData("s1", "r1")] });
    expect(fake.snapshot().map((r) => r.id)).toEqual(["s1"]);
  });
});
