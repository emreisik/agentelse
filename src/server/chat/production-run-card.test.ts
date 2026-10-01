import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn().mockResolvedValue(undefined);
const updateCommandCard = vi.fn().mockResolvedValue({ ok: true });
const isWorksEnabled = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { command: { findUnique, update } },
}));
vi.mock("@/server/works/flag", () => ({ isWorksEnabled }));
vi.mock("./card-store", () => ({ updateCommandCard }));
vi.mock("@/server/commands/task-planner", () => ({ TaskPlanner: class {} }));
vi.mock("@/server/commands/limit-notice", () => ({
  limitNoticeFromError: vi.fn(),
  limitNoticeReplyText: vi.fn(),
}));
vi.mock("@/server/media/creative-progress", () => ({
  subscribeCreativeProgress: vi.fn(),
}));
vi.mock("./inline-job", () => ({ driveJobInline: vi.fn() }));

const { patchCommandCard } = await import("./production-run");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("patchCommandCard", () => {
  // W13
  it("flag off: plain findUnique + update, no atomic writer", async () => {
    isWorksEnabled.mockReturnValue(false);
    findUnique.mockResolvedValue({ parsedIntent: { card: { a: 1 }, x: 2 } });
    await patchCommandCard("c1", { b: 2 });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "c1" },
      select: { parsedIntent: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { parsedIntent: { card: { a: 1, b: 2 }, x: 2 } },
    });
    expect(updateCommandCard).not.toHaveBeenCalled();
  });

  it("flag on: delegates to updateCommandCard, no plain update", async () => {
    isWorksEnabled.mockReturnValue(true);
    findUnique.mockResolvedValue({
      projectId: "p1",
      parsedIntent: { card: { kind: "k", a: 1 } },
    });
    await patchCommandCard("c1", { b: 2 });
    expect(update).not.toHaveBeenCalled();
    const input = updateCommandCard.mock.calls.at(0)?.[0] as {
      commandId: string;
      projectId: string;
      update: (c: Record<string, unknown>) => unknown;
    };
    expect(input.commandId).toBe("c1");
    expect(input.projectId).toBe("p1");
    expect(input.update({ kind: "k", a: 1 })).toEqual({ kind: "k", a: 1, b: 2 });
  });

  it.each([false, true])("no card is a no-op (flag %s)", async (flag) => {
    isWorksEnabled.mockReturnValue(flag);
    findUnique.mockResolvedValue({ projectId: "p1", parsedIntent: {} });
    await patchCommandCard("c1", { b: 2 });
    expect(update).not.toHaveBeenCalled();
    expect(updateCommandCard).not.toHaveBeenCalled();
  });
  describe("flag on: a lost write conflict is not swallowed", () => {
    beforeEach(() => {
      updateCommandCard.mockReset().mockResolvedValue({ ok: true });
      isWorksEnabled.mockReturnValue(true);
      findUnique.mockResolvedValue({
        projectId: "p1",
        parsedIntent: { card: { kind: "k" } },
      });
    });
    const conflict = { ok: false, code: "CONFLICT", message: "changed" };

    it("tries once more and succeeds", async () => {
      updateCommandCard
        .mockResolvedValueOnce(conflict)
        .mockResolvedValueOnce({ ok: true });
      await expect(patchCommandCard("c1", { b: 2 })).resolves.toBeUndefined();
      expect(updateCommandCard).toHaveBeenCalledTimes(2);
    });

    it("throws after the second conflict so the caller can log it", async () => {
      updateCommandCard.mockResolvedValue(conflict);
      await expect(patchCommandCard("c1", { b: 2 })).rejects.toThrow(
        /write conflict/,
      );
      expect(updateCommandCard).toHaveBeenCalledTimes(2);
    });

    it("a card that is gone or replaced is a quiet no-op", async () => {
      updateCommandCard.mockResolvedValue({
        ok: false,
        code: "NOT_FOUND",
        message: "x",
      });
      await expect(patchCommandCard("c1", { b: 2 })).resolves.toBeUndefined();
      expect(updateCommandCard).toHaveBeenCalledTimes(1);
    });
  });
});
