import { beforeEach, describe, expect, it, vi } from "vitest";

const isWorksEnabled = vi.fn();
vi.mock("./flag", () => ({ isWorksEnabled }));

const { worksProductionGate } = await import("./production-gate");

const db = {
  command: { findUnique: vi.fn() },
  work: { findFirst: vi.fn() },
};
const gate = () =>
  worksProductionGate(db as never, {
    projectId: "p1",
    commandId: "c1",
  });

beforeEach(() => {
  vi.clearAllMocks();
  isWorksEnabled.mockReturnValue(true);
  db.command.findUnique.mockResolvedValue({ workId: "w1" });
  db.work.findFirst.mockResolvedValue({ status: "ACTIVE" });
});

describe("worksProductionGate", () => {
  it("runs no query with the flag off", async () => {
    isWorksEnabled.mockReturnValue(false);
    expect(await gate()).toEqual({ ok: true });
    expect(db.command.findUnique).not.toHaveBeenCalled();
    expect(db.work.findFirst).not.toHaveBeenCalled();
  });

  it("passes a command without a Work", async () => {
    db.command.findUnique.mockResolvedValue({ workId: null });
    expect(await gate()).toEqual({ ok: true });
    expect(db.work.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a missing Work (also another project's) and scopes by project", async () => {
    db.work.findFirst.mockResolvedValue(null);
    expect((await gate()).ok).toBe(false);
    expect(db.work.findFirst.mock.calls[0]![0].where).toEqual({
      id: "w1",
      projectId: "p1",
    });
  });

  it.each(["DONE", "ARCHIVED"])("refuses a %s Work", async (status) => {
    db.work.findFirst.mockResolvedValue({ status });
    expect(await gate()).toEqual({
      ok: false,
      message: "This Work is completed. Reopen it to continue.",
    });
  });

  it("an ACTIVE Work passes whatever channels it has: a chat is not bound to one", async () => {
    expect(await gate()).toEqual({ ok: true });
    db.work.findFirst.mockResolvedValue({ status: "ACTIVE" });
    expect(await gate()).toEqual({ ok: true });
  });
});
