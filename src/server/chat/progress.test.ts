import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: the chat's progress poll says "out of date" for any
// change the page could show (a task or creative updated, a row posted, an
// in-flight row settled or gone) and stays quiet otherwise, so the chat stops
// re-rendering the whole page while nothing moves.

const taskFindFirst = vi.fn();
const creativeFindFirst = vi.fn();
const commandFindFirst = vi.fn();
const commandFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findFirst: taskFindFirst },
    creative: { findFirst: creativeFindFirst },
    command: { findFirst: commandFindFirst, findMany: commandFindMany },
  },
}));

const { hasChatProgressSince } = await import("./progress");

const since = new Date("2026-10-05T10:00:00.000Z");
const loading = { parsedIntent: { card: { kind: "creative-loading" } } };

beforeEach(() => {
  vi.clearAllMocks();
  taskFindFirst.mockResolvedValue(null);
  creativeFindFirst.mockResolvedValue(null);
  commandFindFirst.mockResolvedValue(null);
  commandFindMany.mockResolvedValue([loading]);
});

describe("hasChatProgressSince", () => {
  it("stays quiet while nothing changed and the rows are still in flight", async () => {
    expect(await hasChatProgressSince("p1", since, ["c1"])).toBe(false);
    // Scoped to the project, with a little room for clock skew.
    const where = taskFindFirst.mock.calls[0]![0].where;
    expect(where.projectId).toBe("p1");
    expect(where.updatedAt.gt.getTime()).toBeLessThan(since.getTime());
    expect(commandFindMany.mock.calls[0]![0].where).toEqual({
      id: { in: ["c1"] },
      projectId: "p1",
    });
  });

  it("is out of date when a task, a creative or a new row changed after the render", async () => {
    taskFindFirst.mockResolvedValueOnce({ id: "t1" });
    expect(await hasChatProgressSince("p1", since, ["c1"])).toBe(true);
    creativeFindFirst.mockResolvedValueOnce({ id: "cr1" });
    expect(await hasChatProgressSince("p1", since, ["c1"])).toBe(true);
    commandFindFirst.mockResolvedValueOnce({ id: "c2" });
    expect(await hasChatProgressSince("p1", since, ["c1"])).toBe(true);
  });

  it("is out of date when an in-flight row settled in place or is gone", async () => {
    commandFindMany.mockResolvedValueOnce([
      { parsedIntent: { card: { kind: "creative-ready" } } },
    ]);
    expect(await hasChatProgressSince("p1", since, ["c1"])).toBe(true);
    commandFindMany.mockResolvedValueOnce([]);
    expect(await hasChatProgressSince("p1", since, ["c1"])).toBe(true);
  });

  it("asks about no rows when the page showed none in flight", async () => {
    expect(await hasChatProgressSince("p1", since, [])).toBe(false);
    expect(commandFindMany).not.toHaveBeenCalled();
  });
});
