import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const tx = {
  command: { findUnique: vi.fn(), update: vi.fn() },
  work: { findFirst: vi.fn() },
};
const transaction = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...args: unknown[]) => transaction(...args) },
}));

import type { IdeaEventCardData } from "@/types/idea-event-card";

import { updateCardInTx, updateCommandCard } from "./card-store";

const card = {
  kind: "content-plan-draft",
  state: "open",
} as unknown as IdeaEventCardData;
const next = {
  kind: "content-plan-draft",
  state: "saved",
} as unknown as IdeaEventCardData;

function row(over: Record<string, unknown> = {}) {
  return {
    parsedIntent: { card, other: "keep" },
    projectId: "p1",
    workId: null,
    replyText: "old",
    ...over,
  };
}

function lastData(): Record<string, unknown> {
  const call = tx.command.update.mock.calls[0] as [{ data: Record<string, unknown> }];
  return call[0].data;
}

const base = { commandId: "c1", projectId: "p1" };

function conflict() {
  return Object.assign(new Error("conflict"), { code: "P2034" });
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.command.findUnique.mockResolvedValue(row());
  tx.command.update.mockResolvedValue({});
  transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) =>
    cb(tx),
  );
});

describe("updateCommandCard", () => {
  it("writes the card and keeps the other parsedIntent keys", async () => {
    const res = await updateCommandCard({ ...base, update: () => next });
    expect(res).toEqual({ ok: true, card: next, changed: true });
    const data = lastData();
    expect(data.parsedIntent).toEqual({ card: next, other: "keep" });
    expect(data).not.toHaveProperty("replyText");
    expect((transaction.mock.calls[0] as unknown[])[1]).toEqual({
      isolationLevel: "Serializable",
    });
  });

  it("writes nothing when the callback returns null", async () => {
    const res = await updateCommandCard({ ...base, update: () => null });
    expect(res).toEqual({ ok: true, card, changed: false });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("refuses with the reject message", async () => {
    const res = await updateCommandCard({
      ...base,
      update: () => ({ reject: "nope" }),
    });
    expect(res).toEqual({ ok: false, code: "REJECTED", message: "nope" });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("refuses a wrong kind", async () => {
    const res = await updateCommandCard({
      ...base,
      expectKinds: ["content-plan-options"],
      update: () => next,
    });
    expect(res).toMatchObject({ ok: false, code: "WRONG_KIND" });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a missing row and for another project", async () => {
    tx.command.findUnique.mockResolvedValueOnce(null);
    expect(
      await updateCommandCard({ ...base, update: () => next }),
    ).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    tx.command.findUnique.mockResolvedValueOnce(row({ projectId: "other" }));
    expect(
      await updateCommandCard({
        ...base,
        expectKinds: ["x"],
        update: () => next,
      }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(tx.command.update).not.toHaveBeenCalled();
  });

  it("with requireActiveWork refuses a DONE, ARCHIVED or missing Work", async () => {
    tx.command.findUnique.mockResolvedValue(row({ workId: "w1" }));
    for (const found of [{ status: "DONE" }, { status: "ARCHIVED" }, null]) {
      tx.work.findFirst.mockResolvedValueOnce(found);
      const res = await updateCommandCard({
        ...base,
        requireActiveWork: true,
        update: () => next,
      });
      expect(res).toEqual({
        ok: false,
        code: "WORK_INACTIVE",
        message: "This Work is completed. Reopen it to continue.",
      });
    }
    expect(tx.command.update).not.toHaveBeenCalled();
    expect(tx.work.findFirst).toHaveBeenCalledWith({
      where: { id: "w1", projectId: "p1" },
      select: { status: true },
    });
  });

  it("with requireActiveWork passes for an ACTIVE Work and a row without a Work", async () => {
    tx.command.findUnique.mockResolvedValueOnce(row({ workId: "w1" }));
    tx.work.findFirst.mockResolvedValueOnce({ status: "ACTIVE" });
    expect(
      await updateCommandCard({
        ...base,
        requireActiveWork: true,
        update: () => next,
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(
      await updateCommandCard({
        ...base,
        requireActiveWork: true,
        update: () => next,
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(tx.work.findFirst).toHaveBeenCalledTimes(1);
  });

  it("passes the workId to the callback", async () => {
    tx.command.findUnique.mockResolvedValueOnce(row({ workId: "w9" }));
    const update = vi.fn(() => null);
    await updateCommandCard({ ...base, update });
    expect(update).toHaveBeenCalledWith(card, { workId: "w9" });
  });

  it("{card, replyText} writes both in one update", async () => {
    await updateCommandCard({
      ...base,
      update: () => ({ card: next, replyText: "Picked it." }),
    });
    expect(tx.command.update).toHaveBeenCalledTimes(1);
    const data = lastData();
    expect(data.replyText).toBe("Picked it.");
    expect(data.parsedIntent).toEqual({ card: next, other: "keep" });
  });

  it("retries P2034 twice then succeeds", async () => {
    transaction
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict());
    const res = await updateCommandCard({ ...base, update: () => next });
    expect(res).toMatchObject({ ok: true });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("answers CONFLICT after three attempts", async () => {
    transaction.mockRejectedValue(conflict());
    const res = await updateCommandCard({ ...base, update: () => next });
    expect(res).toEqual({
      ok: false,
      code: "CONFLICT",
      message: "This card changed at the same time. Try again.",
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("rethrows an unrelated error", async () => {
    transaction.mockRejectedValue(new Error("db down"));
    await expect(
      updateCommandCard({ ...base, update: () => next }),
    ).rejects.toThrow("db down");
  });
});

describe("updateCardInTx", () => {
  it("runs on the given transaction client", async () => {
    const res = await updateCardInTx(tx as never, {
      ...base,
      update: () => next,
    });
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(transaction).not.toHaveBeenCalled();
  });
});
