import { describe, expect, it } from "vitest";

import { makeAuditFake } from "./audit-fake";
import {
  APPLY_ALLOWED_OPS,
  type AllowListPrisma,
  makeAllowListPrisma,
  observedOps,
} from "./allow-list-prisma";
import { makeCommandFake } from "./command-fake";

// Test-side view: the proxy answers any model.operation dynamically.
type OpName =
  | "count"
  | "create"
  | "createMany"
  | "delete"
  | "deleteMany"
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "update"
  | "updateMany";
type Ops = Record<OpName, (...args: unknown[]) => Promise<unknown>>;
const model = (prisma: AllowListPrisma, name: string) => prisma[name] as Ops;

describe("allow-list prisma: generic fakes", () => {
  it("allowed operations answer with permissive generic results", async () => {
    const { prisma } = makeAllowListPrisma();
    expect(await model(prisma, "project").findUnique({})).toBeNull();
    expect(await model(prisma, "brandAssumption").findMany({})).toEqual([]);
    expect(await model(prisma, "brandDecision").create({})).toEqual({
      id: "x",
    });
    expect(await model(prisma, "brandConstitution").updateMany({})).toEqual({
      count: 0,
    });
    expect(await model(prisma, "brandFact").createMany({})).toEqual({
      count: 0,
    });
    expect(await model(prisma, "approvedClaim").deleteMany({})).toEqual({
      count: 0,
    });
    expect(await model(prisma, "auditLog").count({})).toBe(0);
    expect(await model(prisma, "brandDossier").update({})).toEqual({ id: "x" });
  });
});

describe("allow-list prisma: overrides", () => {
  it("an override wins over the generic fake for its model", async () => {
    const command = makeCommandFake();
    const { prisma } = makeAllowListPrisma({ overrides: { command } });
    await model(prisma, "command").create({
      data: { id: "c1", workspaceId: "w", source: "SYSTEM", rawText: "" },
    });
    expect(command.snapshot().map((r) => r.id)).toEqual(["c1"]);
    expect(
      await model(prisma, "command").findUnique({ where: { id: "c1" } }),
    ).toMatchObject({ id: "c1" });
    // the generic fake would have answered { count: 0 }
    expect(
      await model(prisma, "command").updateMany({
        where: { id: "c1" },
        data: { replyText: "ok" },
      }),
    ).toEqual({ count: 1 });
  });

  it("the audit override works alongside the command override", async () => {
    const audit = makeAuditFake();
    const { prisma } = makeAllowListPrisma({ overrides: { auditLog: audit } });
    await model(prisma, "auditLog").create({
      data: { workspaceId: "w", action: "a" },
    });
    expect(
      await model(prisma, "auditLog").count({ where: { action: "a" } }),
    ).toBe(1);
  });

  it("the operation allow-list still applies to an overridden model", () => {
    const command = makeCommandFake();
    const { prisma } = makeAllowListPrisma({ overrides: { command } });
    // command.update exists on the fake but is not in the allowed list
    expect(() =>
      model(prisma, "command").update({ where: { id: "c1" }, data: {} }),
    ).toThrow("forbidden command.update");
    // and an allowed op the override lacks fails loudly
    expect(() => model(prisma, "auditLog").count({})).not.toThrow();
    const partial = makeAllowListPrisma({ overrides: { auditLog: {} } });
    expect(() => model(partial.prisma, "auditLog").count({})).toThrow(
      /no count/,
    );
  });
});

describe("allow-list prisma: forbidden access", () => {
  it("a model outside the map throws", () => {
    const { prisma } = makeAllowListPrisma();
    expect(() => model(prisma, "user").findMany({})).toThrow(
      "forbidden user.findMany",
    );
    expect(() => model(prisma, "task").create({})).toThrow(
      "forbidden task.create",
    );
  });

  it("a disallowed operation on an allowed model throws", () => {
    const { prisma } = makeAllowListPrisma();
    expect(() => model(prisma, "project").update({})).toThrow(
      "forbidden project.update",
    );
    expect(() => model(prisma, "brand").update({})).toThrow(
      "forbidden brand.update",
    );
    expect(() => model(prisma, "brandDossier").delete({})).toThrow(
      "forbidden brandDossier.delete",
    );
  });

  it("every raw SQL entry point throws", () => {
    const { prisma, calls } = makeAllowListPrisma();
    for (const name of [
      "$executeRaw",
      "$executeRawUnsafe",
      "$queryRaw",
      "$queryRawUnsafe",
    ]) {
      expect(() => (prisma[name] as () => unknown)()).toThrow(
        `forbidden ${name}`,
      );
    }
    expect(calls).toEqual([
      "$executeRaw",
      "$executeRawUnsafe",
      "$queryRaw",
      "$queryRawUnsafe",
    ]);
  });

  it("a custom allow-list replaces the default map", async () => {
    const { prisma } = makeAllowListPrisma({
      allowed: { widget: ["findMany"] },
    });
    expect(await model(prisma, "widget").findMany({})).toEqual([]);
    expect(() => model(prisma, "project").findUnique({})).toThrow(
      "forbidden project.findUnique",
    );
  });

  it("the default map is the apply allow-list of the spec", () => {
    expect(APPLY_ALLOWED_OPS.project).toEqual(["findUnique"]);
    expect(APPLY_ALLOWED_OPS.command).toEqual([
      "create",
      "findUnique",
      "findFirst",
      "updateMany",
    ]);
    expect(APPLY_ALLOWED_OPS.auditLog).toEqual(["create", "update", "count"]);
    expect(APPLY_ALLOWED_OPS.brand).toEqual(["findUnique", "findFirst"]);
  });
});

describe("allow-list prisma: $transaction and calls", () => {
  it("$transaction runs the callback with the same proxy and shares calls", async () => {
    const { prisma, calls } = makeAllowListPrisma();
    const result = await prisma.$transaction(async (tx: unknown) => {
      expect(tx).toBe(prisma);
      await model(tx as AllowListPrisma, "brandFact").deleteMany({});
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toEqual(["brandFact.deleteMany"]);
  });

  it("a forbidden call inside $transaction still throws", async () => {
    const { prisma } = makeAllowListPrisma();
    await expect(
      prisma.$transaction(async (tx: unknown) => {
        model(tx as AllowListPrisma, "project").update({});
      }),
    ).rejects.toThrow("forbidden project.update");
  });

  it("observedOps returns the sorted unique model.operation set", async () => {
    const { prisma, calls } = makeAllowListPrisma();
    await model(prisma, "brandFact").createMany({});
    await model(prisma, "brandFact").deleteMany({});
    await model(prisma, "brandFact").createMany({});
    await model(prisma, "auditLog").create({});
    expect(calls).toEqual([
      "brandFact.createMany",
      "brandFact.deleteMany",
      "brandFact.createMany",
      "auditLog.create",
    ]);
    expect(observedOps(calls)).toEqual([
      "auditLog.create",
      "brandFact.createMany",
      "brandFact.deleteMany",
    ]);
  });

  it("a forbidden attempt is recorded, so a swallowed throw still shows in observedOps", () => {
    const { prisma, calls } = makeAllowListPrisma();
    try {
      model(prisma, "project").update({});
    } catch {
      // swallowed on purpose
    }
    expect(observedOps(calls)).toEqual(["project.update"]);
  });
});
