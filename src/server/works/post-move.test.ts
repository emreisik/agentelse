import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";

const { movePostInTx } = await import("./post-move");

function txWith(siblings: { id: string; status: string; excludedAt?: Date }[]) {
  return {
    creative: {
      findUnique: vi.fn(async () => ({ postId: "post-1" })),
      findMany: vi.fn(async () =>
        siblings.map((s) => ({ excludedAt: null, ...s })),
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    post: { update: vi.fn(async () => ({})) },
  };
}

const when = new Date("2026-10-09T07:00:00Z");
const input = {
  creativeId: "ig",
  projectId: "p1",
  scheduledFor: when,
  movable: ["DRAFT", "IN_REVIEW", "APPROVED"],
};

describe("movePostInTx", () => {
  it("moves the post's other channels and the post itself", async () => {
    const tx = txWith([
      { id: "story", status: "IN_REVIEW" },
      { id: "fb", status: "APPROVED" },
      { id: "old", status: "REJECTED" },
    ]);
    const out = await movePostInTx(tx as unknown as Prisma.TransactionClient, input);
    expect(out).toEqual({ ok: true, postId: "post-1", moved: ["story", "fb"] });
    expect(tx.creative.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["story", "fb"] }, projectId: "p1" },
      data: { scheduledFor: when },
    });
    expect(tx.post.update).toHaveBeenCalledWith({
      where: { id: "post-1" },
      data: { scheduledFor: when },
    });
  });

  it("refuses once part of the post is posted, unless that channel was left out", async () => {
    const posted = txWith([{ id: "fb", status: "PUBLISHED" }]);
    expect(
      await movePostInTx(posted as unknown as Prisma.TransactionClient, input),
    ).toEqual({ ok: false });
    expect(posted.post.update).not.toHaveBeenCalled();

    const left = txWith([
      { id: "fb", status: "PUBLISHED", excludedAt: new Date() },
    ]);
    expect(
      (await movePostInTx(left as unknown as Prisma.TransactionClient, input)).ok,
    ).toBe(true);
  });

  it("moves a piece outside a post alone", async () => {
    const tx = txWith([]);
    tx.creative.findUnique.mockResolvedValue({ postId: null } as never);
    expect(
      await movePostInTx(tx as unknown as Prisma.TransactionClient, input),
    ).toEqual({ ok: true, postId: null, moved: [] });
    expect(tx.creative.findMany).not.toHaveBeenCalled();
  });
});
