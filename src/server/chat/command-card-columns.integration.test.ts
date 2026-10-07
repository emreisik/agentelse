import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { describeIntegration } from "@/test-support/integration-suite";

// Command.cardKind / cardTaskId / cardCreativeId are STORED generated columns
// (migration 20261007110000) that copy parsedIntent.card.{kind,taskId,
// creativeId}. The chat page and the card repositories filter on them with
// plain equality instead of a JSON-path scan, so they must be filled by the
// database itself: on create, recomputed on update, empty for a row without a
// card, and never written by Prisma.

describeIntegration("Command card columns", () => {
  const run = randomUUID().slice(0, 8);
  const projectId = `proj-card-cols-${run}`;
  const ids: string[] = [];

  async function commandWith(parsedIntent: unknown) {
    const id = `cmd-card-cols-${randomUUID()}`;
    ids.push(id);
    return prisma.command.create({
      data: {
        id,
        workspaceId: `ws-card-cols-${run}`,
        projectId,
        source: "SYSTEM",
        rawText: "x",
        parsedIntent: parsedIntent as never,
      },
    });
  }

  afterAll(async () => {
    await prisma.command.deleteMany({ where: { id: { in: ids } } });
  });

  it("fills the columns from the card, and a filter on them finds the row", async () => {
    const ready = await commandWith({
      card: { kind: "creative-ready", taskId: "t-1", creativeId: "cr-1" },
    });
    expect(ready.cardKind).toBe("creative-ready");
    expect(ready.cardTaskId).toBe("t-1");
    expect(ready.cardCreativeId).toBe("cr-1");

    const byTask = await prisma.command.findMany({
      where: { projectId, cardTaskId: "t-1", cardKind: "creative-ready" },
      select: { id: true },
    });
    expect(byTask.map((row) => row.id)).toEqual([ready.id]);
    const byCreative = await prisma.command.findMany({
      where: { projectId, cardCreativeId: "cr-1" },
      select: { id: true },
    });
    expect(byCreative.map((row) => row.id)).toEqual([ready.id]);
  });

  it("leaves them empty for a row that has no card", async () => {
    for (const parsedIntent of [
      { kind: "CAPABILITY" },
      { card: "not-an-object" },
      null,
    ]) {
      const row = await commandWith(parsedIntent ?? undefined);
      expect(row.cardKind).toBeNull();
      expect(row.cardTaskId).toBeNull();
      expect(row.cardCreativeId).toBeNull();
    }
  });

  it("recomputes them when the card is rewritten in place", async () => {
    const row = await commandWith({
      card: { kind: "task-running", taskId: "t-2" },
    });
    expect(row.cardKind).toBe("task-running");

    const updated = await prisma.command.update({
      where: { id: row.id },
      data: { parsedIntent: { card: { kind: "task-result", taskId: "t-2" } } },
    });
    expect(updated.cardKind).toBe("task-result");
    expect(updated.cardTaskId).toBe("t-2");
    expect(updated.cardCreativeId).toBeNull();
  });
});
