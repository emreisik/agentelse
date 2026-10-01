import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard W56 (hold-fail-closed): a piece whose plan Command is gone stays under
// the Works rules; a legacy plan and a plan-less piece do not.

const creativeFindUnique = vi.fn();
const commandFindUnique = vi.fn();
const commandFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findUnique: creativeFindUnique },
    command: { findUnique: commandFindUnique, findMany: commandFindMany },
  },
}));

const { workOwnershipOf, ownedPlanIds } = await import("./work-owned");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workOwnershipOf", () => {
  it("a creative without a plan is not owned (one read only)", async () => {
    creativeFindUnique.mockResolvedValue({ planId: null });
    await expect(workOwnershipOf("c1")).resolves.toEqual({
      owned: false,
      workId: null,
    });
    expect(commandFindUnique).not.toHaveBeenCalled();
  });

  it("a plan Command with a workId is owned by that Work", async () => {
    creativeFindUnique.mockResolvedValue({ planId: "p1" });
    commandFindUnique.mockResolvedValue({ workId: "w1" });
    await expect(workOwnershipOf("c1")).resolves.toEqual({
      owned: true,
      workId: "w1",
    });
    expect(creativeFindUnique).toHaveBeenCalledTimes(1);
    expect(commandFindUnique).toHaveBeenCalledTimes(1);
  });

  it("a MISSING plan Command is owned (fail closed)", async () => {
    creativeFindUnique.mockResolvedValue({ planId: "gone" });
    commandFindUnique.mockResolvedValue(null);
    await expect(workOwnershipOf("c1")).resolves.toEqual({
      owned: true,
      workId: null,
    });
  });

  it("a legacy plan Command (no workId) is not owned", async () => {
    creativeFindUnique.mockResolvedValue({ planId: "p1" });
    commandFindUnique.mockResolvedValue({ workId: null });
    await expect(workOwnershipOf("c1")).resolves.toEqual({
      owned: false,
      workId: null,
    });
  });

  it("a missing creative is not owned", async () => {
    creativeFindUnique.mockResolvedValue(null);
    await expect(workOwnershipOf("c1")).resolves.toEqual({
      owned: false,
      workId: null,
    });
  });
});

describe("ownedPlanIds", () => {
  it("answers many ids with ONE query and treats missing rows as owned", async () => {
    commandFindMany.mockResolvedValue([
      { id: "a", workId: "w1" },
      { id: "b", workId: null },
    ]);
    const owned = await ownedPlanIds(["a", "b", "missing", "a"]);
    expect([...owned].sort()).toEqual(["a", "missing"]);
    expect(commandFindMany).toHaveBeenCalledTimes(1);
  });

  it("makes no query for an empty list", async () => {
    expect((await ownedPlanIds([])).size).toBe(0);
    expect(commandFindMany).not.toHaveBeenCalled();
  });
});
