import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: syncGaFixApprovalState Approval satırını değişikliğe
// doğru yansıtır (APPROVED -> onay, REJECTED/REVISION_REQUESTED -> reddedildi,
// CANCELLED/EXPIRED -> süresi doldu, PENDING -> dokunulmaz), CAS kaybında güncel
// durumu döner ve idempotenttir; onGaTaskApproved asla fırlatmaz, bitmeyen bir
// uygulamayı beklemeden bütçe sonunda döner, değişiklik yoksa Task'ı iptal eder
// ve geçersiz Task geçişlerini yutar.

const mocks = vi.hoisted(() => ({
  changeFindUnique: vi.fn(),
  changeFindFirst: vi.fn(),
  changeUpdateMany: vi.fn(),
  approvalFindUnique: vi.fn(),
  taskTransition: vi.fn(),
  apply: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaConfigChange: {
      findUnique: mocks.changeFindUnique,
      findFirst: mocks.changeFindFirst,
      updateMany: mocks.changeUpdateMany,
    },
    approval: { findUnique: mocks.approvalFindUnique },
  },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: mocks.taskTransition },
}));
vi.mock("./apply", () => ({ applyGaConfigChange: mocks.apply }));
vi.mock("./audit", () => ({ recordGaFixAudit: mocks.audit }));

const { syncGaFixApprovalState, onGaTaskApproved } = await import(
  "./approval-hook"
);

const NOW = new Date("2026-10-07T09:00:00.000Z");
const CHANGE = {
  id: "chg-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  kind: "KEY_EVENT_CREATE",
  status: "PROPOSED",
  taskId: "task-1",
  approvalId: "appr-1",
};
const TASK = { id: "task-1", projectId: "proj-1", workspaceId: "ws-1" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.changeFindUnique.mockResolvedValue({ ...CHANGE });
  mocks.changeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.taskTransition.mockResolvedValue({});
  mocks.apply.mockResolvedValue({ state: "verified" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncGaFixApprovalState", () => {
  it("returns null for an unknown change", async () => {
    mocks.changeFindUnique.mockResolvedValue(null);
    expect(await syncGaFixApprovalState("nope")).toBeNull();
  });

  it("APPROVED moves PROPOSED to APPROVED with the reviewer and audits it", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "APPROVED",
      reviewedByUserId: "owner-1",
    });
    expect(await syncGaFixApprovalState("chg-1", { now: NOW })).toBe("APPROVED");
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "chg-1", status: "PROPOSED" },
      data: {
        status: "APPROVED",
        approvedByUserId: "owner-1",
        approvedAt: NOW,
      },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      "ga_config_change.approved",
      { changeId: "chg-1", kind: "KEY_EVENT_CREATE" },
      expect.objectContaining({ userId: "owner-1" }),
    );
    expect(mocks.taskTransition).not.toHaveBeenCalled();
  });

  it.each(["REJECTED", "REVISION_REQUESTED"])(
    "%s closes the change as REJECTED, frees openKey and cancels the Task",
    async (approvalStatus) => {
      mocks.approvalFindUnique.mockResolvedValue({
        status: approvalStatus,
        reviewedByUserId: "u",
      });
      expect(await syncGaFixApprovalState("chg-1")).toBe("REJECTED");
      expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
        where: { id: "chg-1", status: "PROPOSED" },
        data: { status: "REJECTED", openKey: null },
      });
      expect(mocks.taskTransition).toHaveBeenCalledWith(
        "task-1",
        "proj-1",
        "CANCELLED",
        expect.objectContaining({ failureReason: expect.any(String) }),
      );
      expect(mocks.audit).toHaveBeenCalledWith(
        "ga_config_change.rejected",
        { changeId: "chg-1", kind: "KEY_EVENT_CREATE" },
        expect.anything(),
      );
    },
  );

  it.each(["CANCELLED", "EXPIRED"])(
    "%s closes the change as EXPIRED and cancels the Task",
    async (approvalStatus) => {
      mocks.approvalFindUnique.mockResolvedValue({
        status: approvalStatus,
        reviewedByUserId: null,
      });
      expect(await syncGaFixApprovalState("chg-1")).toBe("EXPIRED");
      expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
        where: { id: "chg-1", status: "PROPOSED" },
        data: { status: "EXPIRED", openKey: null },
      });
      expect(mocks.taskTransition).toHaveBeenCalledTimes(1);
      expect(mocks.audit).toHaveBeenCalledWith(
        "ga_config_change.expired",
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it("a PENDING approval leaves the change alone", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "PENDING",
      reviewedByUserId: null,
    });
    expect(await syncGaFixApprovalState("chg-1")).toBe("PROPOSED");
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
  });

  it("a missing approval row expires the change", async () => {
    mocks.approvalFindUnique.mockResolvedValue(null);
    expect(await syncGaFixApprovalState("chg-1")).toBe("EXPIRED");
  });

  it("is idempotent: a change past PROPOSED is returned untouched", async () => {
    for (const status of ["APPROVED", "APPLYING", "VERIFIED", "REJECTED"]) {
      mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, status });
      expect(await syncGaFixApprovalState("chg-1")).toBe(status);
    }
    expect(mocks.approvalFindUnique).not.toHaveBeenCalled();
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("a lost CAS returns the current status without audit or Task change", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "REJECTED",
      reviewedByUserId: "u",
    });
    mocks.changeUpdateMany.mockResolvedValue({ count: 0 });
    mocks.changeFindUnique
      .mockResolvedValueOnce({ ...CHANGE })
      .mockResolvedValueOnce({ status: "APPROVED" });
    expect(await syncGaFixApprovalState("chg-1")).toBe("APPROVED");
    expect(mocks.taskTransition).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("a Task that cannot be cancelled does not break the sync", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "REJECTED",
      reviewedByUserId: "u",
    });
    mocks.taskTransition.mockRejectedValue(new Error("invalid transition"));
    expect(await syncGaFixApprovalState("chg-1")).toBe("REJECTED");
  });
});

describe("onGaTaskApproved", () => {
  it("syncs, moves the Task to QUEUED then RUNNING and applies", async () => {
    mocks.changeFindFirst.mockResolvedValue({ id: "chg-1" });
    mocks.approvalFindUnique.mockResolvedValue({
      status: "APPROVED",
      reviewedByUserId: "owner-1",
    });
    await onGaTaskApproved(TASK);
    expect(mocks.taskTransition.mock.calls.map((call) => call[2])).toEqual([
      "QUEUED",
      "RUNNING",
    ]);
    expect(mocks.apply).toHaveBeenCalledWith("chg-1", {});
  });

  it("cancels the Task when its change is gone and never applies", async () => {
    mocks.changeFindFirst.mockResolvedValue(null);
    await onGaTaskApproved(TASK);
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      { failureReason: "Google Analytics change no longer exists" },
    );
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("does not apply or run the Task when the approval did not end APPROVED", async () => {
    mocks.changeFindFirst.mockResolvedValue({ id: "chg-1" });
    mocks.approvalFindUnique.mockResolvedValue({
      status: "REJECTED",
      reviewedByUserId: "u",
    });
    await onGaTaskApproved(TASK);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(
      mocks.taskTransition.mock.calls.map((call) => call[2]),
    ).not.toContain("RUNNING");
  });

  it("swallows invalid Task transitions and still applies", async () => {
    mocks.changeFindFirst.mockResolvedValue({ id: "chg-1" });
    mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, status: "APPROVED" });
    mocks.taskTransition.mockRejectedValue(new Error("invalid transition"));
    await expect(onGaTaskApproved(TASK)).resolves.toBeUndefined();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when the lookup or the apply fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.changeFindFirst.mockRejectedValue(new Error("db down"));
    await expect(onGaTaskApproved(TASK)).resolves.toBeUndefined();

    mocks.changeFindFirst.mockResolvedValue({ id: "chg-1" });
    mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, status: "APPROVED" });
    mocks.apply.mockRejectedValue(new Error("boom"));
    await expect(onGaTaskApproved(TASK)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("returns within the inline budget when the apply never resolves", async () => {
    vi.useFakeTimers();
    mocks.changeFindFirst.mockResolvedValue({ id: "chg-1" });
    mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, status: "APPROVED" });
    mocks.apply.mockReturnValue(new Promise(() => undefined));

    let done = false;
    const pending = onGaTaskApproved(TASK).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(done).toBe(true);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
});
