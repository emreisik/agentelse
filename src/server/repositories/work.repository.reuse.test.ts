import { beforeEach, describe, expect, it, vi } from "vitest";

// The interleavings a real database cannot be paused into: the blank Work is read,
// then, before it is reopened, another tab deletes it or writes its first message
// (the advisory lock only serialises New Chat taps). The tap must then open a
// fresh Work instead of failing. Control flow only, so the transaction client is
// a stand-in; the query semantics are proven in work.repository.integration.test.ts.

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  work: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));
// Imported by the repository for ensureToday; heavy module, same duck-typing.
vi.mock("@/server/guided-setup/store", () => ({
  isUniqueViolation: () => false,
}));

const { WorkRepository } = await import("./work.repository");

const row = (id: string) => ({
  id,
  title: "New Work",
  summary: null,
  status: "ACTIVE" as const,
  channels: [],
  acknowledgedUnconnected: [],
  lastActivityAt: new Date("2026-10-02T10:00:00Z"),
});

type Where = { AND?: Record<string, unknown>[] };
const isReopen = (where: Where) =>
  (where.AND ?? []).some((part) => typeof part.id === "string");
const isArchive = (where: Where) =>
  (where.AND ?? []).some(
    (part) =>
      typeof part.id === "object" && part.id !== null && "not" in part.id,
  );

const input = { workspaceId: "ws1", projectId: "p1", createdByUserId: "u1" };

beforeEach(() => {
  vi.resetAllMocks();
  tx.$executeRaw.mockResolvedValue(1);
  tx.work.create.mockResolvedValue(row("wFresh"));
});

describe("createOrReuseBlank: the blank Work changes under the tap", () => {
  it("reopens it while it is still blank", async () => {
    tx.work.findFirst.mockResolvedValue(row("wBlank"));
    tx.work.updateMany.mockImplementation(
      async ({ where }: { where: Where }) => ({
        count: isReopen(where) ? 1 : 0,
      }),
    );
    const out = await WorkRepository.createOrReuseBlank(input);
    expect(out).toMatchObject({ reused: true, work: { id: "wBlank" } });
    expect(tx.work.create).not.toHaveBeenCalled();
  });

  it("reopens it only on the same blank conditions it was found with", async () => {
    tx.work.findFirst.mockResolvedValue(row("wBlank"));
    tx.work.updateMany.mockResolvedValue({ count: 1 });
    await WorkRepository.createOrReuseBlank(input);
    const reopen = tx.work.updateMany.mock.calls
      .map(([arg]) => arg as { where: Where })
      .find(({ where }) => isReopen(where));
    expect(reopen?.where.AND).toEqual(
      expect.arrayContaining([
        { id: "wBlank" },
        expect.objectContaining({
          projectId: "p1",
          status: "ACTIVE",
          title: { in: ["New Chat", "New Work"] },
          commands: { none: {} },
        }),
      ]),
    );
  });

  it("deleted (or written in) after it was found: a fresh Work is made, the tap does not fail", async () => {
    tx.work.findFirst.mockResolvedValue(row("wGone"));
    tx.work.updateMany.mockResolvedValue({ count: 0 });
    const out = await WorkRepository.createOrReuseBlank(input);
    expect(out).toMatchObject({ reused: false, work: { id: "wFresh" } });
    expect(tx.work.create).toHaveBeenCalledTimes(1);
  });

  it("gone between the reopen and the re-read: still a fresh Work, never a crash", async () => {
    tx.work.findFirst
      .mockResolvedValueOnce(row("wBlank")) // the blank lookup
      .mockResolvedValueOnce(null); // the re-read after reopening
    tx.work.updateMany.mockImplementation(
      async ({ where }: { where: Where }) => ({
        count: isReopen(where) ? 1 : 0,
      }),
    );
    const out = await WorkRepository.createOrReuseBlank(input);
    expect(out).toMatchObject({ reused: false, work: { id: "wFresh" } });
  });

  it("reports how many empty copies it archived, on either path", async () => {
    tx.work.findFirst.mockResolvedValue(row("wGone"));
    tx.work.updateMany.mockImplementation(
      async ({ where }: { where: Where }) => ({
        count: isArchive(where) ? 2 : 0,
      }),
    );
    const out = await WorkRepository.createOrReuseBlank(input);
    expect(out).toMatchObject({ reused: false, archived: 2 });
  });

  it("takes the project's lock before reading anything", async () => {
    const order: string[] = [];
    tx.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    tx.work.findFirst.mockImplementation(async () => {
      order.push("read");
      return null;
    });
    await WorkRepository.createOrReuseBlank(input);
    expect(order[0]).toBe("lock");
    expect(order).toContain("read");
  });

  // Modules: the blank Work opened is for what the tap asked for, on both paths.
  const reopenOf = () =>
    tx.work.updateMany.mock.calls
      .map(([arg]) => arg as { where: Where; data: Record<string, unknown> })
      .find(({ where }) => isReopen(where));

  it("the reopened and the fresh Work both carry the module asked for", async () => {
    tx.work.findFirst.mockResolvedValue(row("wGone"));
    tx.work.updateMany.mockResolvedValue({ count: 0 });
    await WorkRepository.createOrReuseBlank({ ...input, module: "social" });
    expect(reopenOf()?.data).toMatchObject({ module: "social" });
    expect(tx.work.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ module: "social" }),
      }),
    );
  });

  it("a plain tap makes the blank Work a general chat again", async () => {
    tx.work.findFirst.mockResolvedValue({ ...row("wBlank"), module: "ads" });
    tx.work.updateMany.mockResolvedValue({ count: 1 });
    await WorkRepository.createOrReuseBlank(input);
    expect(reopenOf()?.data).toMatchObject({ module: null });
  });
});
