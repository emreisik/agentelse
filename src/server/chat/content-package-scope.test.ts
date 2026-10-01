import { beforeEach, describe, expect, it, vi } from "vitest";

const commandFindMany = vi.fn();
const commandUpdate = vi.fn().mockResolvedValue(undefined);
const updateCommandCard = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { command: { findMany: commandFindMany, update: commandUpdate } },
}));
vi.mock("./card-store", () => ({ updateCommandCard }));

const { supersedeOpenPackages } = await import("./content-package");

beforeEach(() => vi.clearAllMocks());

describe("supersedeOpenPackages", () => {
  it("without a workId keeps the old query and plain update", async () => {
    commandFindMany.mockResolvedValue([
      { id: "a", parsedIntent: { card: { kind: "content-package", state: "draft" } } },
      { id: "b", parsedIntent: { card: { kind: "content-package", state: "started" } } },
    ]);
    await supersedeOpenPackages("p", "new");
    expect(commandFindMany.mock.calls.at(0)?.[0]).toStrictEqual({
      where: {
        projectId: "p",
        id: { not: "new" },
        parsedIntent: { path: ["card", "kind"], equals: "content-package" },
      },
      select: { id: true, parsedIntent: true },
    });
    expect(commandUpdate).toHaveBeenCalledTimes(1);
    expect(updateCommandCard).not.toHaveBeenCalled();
  });

  it("with a workId filters by Work and uses the atomic writer with a state check", async () => {
    commandFindMany.mockResolvedValue([{ id: "a" }]);
    await supersedeOpenPackages("p", "new", "w");
    const arg = commandFindMany.mock.calls.at(0)?.[0] as { where: { workId: string } };
    expect(arg.where.workId).toBe("w");
    expect(commandUpdate).not.toHaveBeenCalled();
    const input = updateCommandCard.mock.calls.at(0)?.[0] as {
      update: (c: Record<string, unknown>) => unknown;
    };
    expect(input.update({ kind: "content-package", state: "draft" })).toEqual({
      kind: "content-package",
      state: "superseded",
    });
    expect(input.update({ kind: "content-package", state: "started" })).toBeNull();
  });
});
