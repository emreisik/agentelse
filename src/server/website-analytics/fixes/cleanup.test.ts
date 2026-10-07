import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Disconnect temizliği bekleyen değişiklikleri
// kapatır (satır EXPIRED, bekleyen onay CANCELLED, Task CANCELLED); görevi
// olan HER değişikliğin (kapanmış olanlar dahil) Task başlığı, açıklaması ve
// payload'ı silinir; sohbet kartı metni sabit başlığa çevrilir ve ayrıntı
// alanları kalkar; bağı olmayan kimlik için sorgu yapılmaz; hata asla
// dışarı çıkmaz.

const mocks = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  changeFindMany: vi.fn(),
  changeUpdateMany: vi.fn(),
  approvalUpdateMany: vi.fn(),
  taskUpdateMany: vi.fn(),
  commandFindMany: vi.fn(),
  commandUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaPropertyLink: { findMany: mocks.linkFindMany },
    gaConfigChange: {
      findMany: mocks.changeFindMany,
      updateMany: mocks.changeUpdateMany,
    },
    approval: { updateMany: mocks.approvalUpdateMany },
    task: { updateMany: mocks.taskUpdateMany },
    command: { findMany: mocks.commandFindMany, update: mocks.commandUpdate },
  },
}));

const { cancelPendingGaFixesForCredential, GA_FIX_SCRUBBED_TITLE } =
  await import("./cleanup");

const OPEN_ROWS = [
  { id: "c1", taskId: "t1", approvalId: "a1" },
  { id: "c2", taskId: "t2", approvalId: "a2" },
];
const TASK_ROWS = [
  { projectId: "p1", taskId: "t1", approvalId: "a1" },
  { projectId: "p1", taskId: "t3", approvalId: "a3" },
];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.linkFindMany.mockResolvedValue([{ id: "l1" }]);
  mocks.changeFindMany.mockImplementation(
    async (args: { where: { status?: unknown; taskId?: unknown } }) =>
      args.where.status ? OPEN_ROWS : TASK_ROWS,
  );
  mocks.changeUpdateMany.mockResolvedValue({ count: 2 });
  mocks.approvalUpdateMany.mockResolvedValue({ count: 2 });
  mocks.taskUpdateMany.mockResolvedValue({ count: 2 });
  mocks.commandFindMany.mockResolvedValue([]);
  mocks.commandUpdate.mockResolvedValue({});
});

describe("cancelPendingGaFixesForCredential", () => {
  it("does nothing for a credential without links", async () => {
    mocks.linkFindMany.mockResolvedValue([]);
    expect(await cancelPendingGaFixesForCredential("cred-1")).toBe(0);
    expect(mocks.changeFindMany).not.toHaveBeenCalled();
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it("expires PROPOSED and APPROVED rows, cancels pending approvals and tasks", async () => {
    expect(await cancelPendingGaFixesForCredential("cred-1")).toBe(2);

    expect(mocks.linkFindMany).toHaveBeenCalledWith({
      where: { credentialId: "cred-1" },
      select: { id: true },
    });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["c1", "c2"] },
        status: { in: ["PROPOSED", "APPROVED"] },
      },
      data: {
        status: "EXPIRED",
        openKey: null,
        leaseUntil: null,
        leaseOwner: null,
      },
    });
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2"] }, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["t1", "t2"] },
        status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] },
      },
      data: { status: "CANCELLED" },
    });
  });

  it("scrubs the text of every change with a task, whatever its status", async () => {
    await cancelPendingGaFixesForCredential("cred-1");
    // Kapanmış (t3) ve açık (t1) görev birlikte silinir; durum filtresi yok.
    const scrubCall = mocks.taskUpdateMany.mock.calls
      .map(
        ([args]) =>
          args as {
            where: { id: { in: string[] } };
            data: Record<string, unknown>;
          },
      )
      .find((args) => args.data.title !== undefined);
    expect(scrubCall).toEqual({
      where: { id: { in: ["t1", "t3"] } },
      data: { title: GA_FIX_SCRUBBED_TITLE, description: null, payload: {} },
    });
    expect(GA_FIX_SCRUBBED_TITLE).toBe("Google Analytics change");
    const terminalQuery = mocks.changeFindMany.mock.calls
      .map(([args]) => args as { where: Record<string, unknown> })
      .find((args) => args.where.taskId !== undefined);
    expect(terminalQuery?.where).toEqual({
      linkId: { in: ["l1"] },
      taskId: { not: null },
    });
  });

  it("scrubs only the tasks when nothing is pending", async () => {
    mocks.changeFindMany.mockImplementation(
      async (args: { where: { status?: unknown } }) =>
        args.where.status ? [] : TASK_ROWS,
    );
    expect(await cancelPendingGaFixesForCredential("cred-1")).toBe(0);
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled();
    expect(mocks.taskUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("rewrites chat cards: title replaced, details and result text removed", async () => {
    mocks.commandFindMany.mockResolvedValue([
      {
        id: "cmd-1",
        replyText:
          "⏸️ Awaiting approval: Mark generate_lead as a key event in Google Analytics",
        parsedIntent: {
          card: {
            kind: "approval-request",
            approvalId: "a1",
            taskId: "t1",
            title: "Mark generate_lead as a key event in Google Analytics",
            riskLevel: "MEDIUM",
            details: [{ label: "What happens", value: "secret-ish text" }],
          },
          departmentKey: "DATA_ANALYTICS",
        },
      },
      {
        id: "cmd-2",
        replyText: "✅ Task completed: Add a note",
        parsedIntent: {
          card: {
            kind: "task-result",
            taskId: "t3",
            title: "Add a note",
            status: "COMPLETED",
            resultText: "free text",
          },
        },
      },
    ]);
    await cancelPendingGaFixesForCredential("cred-1");

    expect(mocks.commandFindMany).toHaveBeenCalledWith({
      where: {
        source: "SYSTEM",
        projectId: { in: ["p1"] },
        OR: [
          { parsedIntent: { path: ["card", "taskId"], equals: "t1" } },
          { parsedIntent: { path: ["card", "taskId"], equals: "t3" } },
          { parsedIntent: { path: ["card", "approvalId"], equals: "a1" } },
          { parsedIntent: { path: ["card", "approvalId"], equals: "a3" } },
        ],
      },
      select: { id: true, replyText: true, parsedIntent: true },
    });
    expect(mocks.commandUpdate).toHaveBeenCalledWith({
      where: { id: "cmd-1" },
      data: {
        replyText: "⏸️ Awaiting approval: Google Analytics change",
        parsedIntent: {
          card: {
            kind: "approval-request",
            approvalId: "a1",
            taskId: "t1",
            title: "Google Analytics change",
            riskLevel: "MEDIUM",
          },
          departmentKey: "DATA_ANALYTICS",
        },
      },
    });
    expect(mocks.commandUpdate).toHaveBeenCalledWith({
      where: { id: "cmd-2" },
      data: {
        replyText: "✅ Task completed: Google Analytics change",
        parsedIntent: {
          card: {
            kind: "task-result",
            taskId: "t3",
            title: "Google Analytics change",
            status: "COMPLETED",
          },
        },
      },
    });
  });

  it("leaves a command without a card untouched", async () => {
    mocks.commandFindMany.mockResolvedValue([
      { id: "cmd-3", replyText: "text", parsedIntent: { other: true } },
      { id: "cmd-4", replyText: null, parsedIntent: null },
    ]);
    await cancelPendingGaFixesForCredential("cred-1");
    expect(mocks.commandUpdate).not.toHaveBeenCalled();
  });

  it("scrubs a card whose reply text is empty", async () => {
    mocks.commandFindMany.mockResolvedValue([
      {
        id: "cmd-5",
        replyText: null,
        parsedIntent: {
          card: {
            kind: "approval-decision",
            title: "Old title",
            decision: "REJECTED",
          },
        },
      },
    ]);
    await cancelPendingGaFixesForCredential("cred-1");
    expect(mocks.commandUpdate).toHaveBeenCalledWith({
      where: { id: "cmd-5" },
      data: {
        replyText: null,
        parsedIntent: {
          card: {
            kind: "approval-decision",
            title: "Google Analytics change",
            decision: "REJECTED",
          },
        },
      },
    });
  });

  it("batches the chat card lookup in groups of 50 filters", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      projectId: "p1",
      taskId: `t${index}`,
      approvalId: null,
    }));
    mocks.changeFindMany.mockImplementation(
      async (args: { where: { status?: unknown } }) =>
        args.where.status ? [] : many,
    );
    await cancelPendingGaFixesForCredential("cred-1");
    expect(mocks.commandFindMany).toHaveBeenCalledTimes(2);
    const first = mocks.commandFindMany.mock.calls[0]?.[0] as {
      where: { OR: unknown[] };
    };
    expect(first.where.OR).toHaveLength(50);
  });

  it("never throws and logs only the error name", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.linkFindMany.mockRejectedValue(
      new Error("secret property 424242 failed"),
    );
    await expect(cancelPendingGaFixesForCredential("cred-1")).resolves.toBe(0);
    expect(errors).toHaveBeenCalledWith(
      "[ga-fixes] disconnect cleanup failed:",
      "Error",
    );
    errors.mockRestore();
  });

  it("still reports the closed rows when a later step fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.commandFindMany.mockRejectedValue(new Error("db"));
    await expect(cancelPendingGaFixesForCredential("cred-1")).resolves.toBe(2);
    errors.mockRestore();
  });
});
