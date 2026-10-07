import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: syncSeoChangeApprovalState Approval satırını
// değişikliğe OKUYARAK yansıtır (APPROVED -> onay + uygulama, REJECTED ve
// REVISION_REQUESTED -> reddedildi, CANCELLED ve EXPIRED -> süresi doldu,
// expireOverdue'nun iptal ettiği görev PROPOSED satır bırakmaz, süresi geçmiş
// PENDING -> süresi doldu), CAS kaybında güncel durumu döner ve idempotenttir;
// onSeoApplyTaskApproved asla fırlatmaz, değişiklik kimliğini Task yükünden
// okur, Task'ı RUNNING'e alır, bitmeyen bir uygulamayı beklemeden bütçe
// sonunda döner, uygulama hatalarını yutar ve geçersiz Task geçişlerini yutar.

const mocks = vi.hoisted(() => ({
  changeFindUnique: vi.fn(),
  changeUpdateMany: vi.fn(),
  approvalFindUnique: vi.fn(),
  approvalUpdateMany: vi.fn(),
  taskFindFirst: vi.fn(),
  taskTransition: vi.fn(),
  apply: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoChange: {
      findUnique: mocks.changeFindUnique,
      updateMany: mocks.changeUpdateMany,
    },
    approval: {
      findUnique: mocks.approvalFindUnique,
      updateMany: mocks.approvalUpdateMany,
    },
    task: { findFirst: mocks.taskFindFirst },
  },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: mocks.taskTransition },
}));
vi.mock("./apply", () => ({ applySeoChange: mocks.apply }));
vi.mock("./audit", () => ({ recordSeoApplyAudit: mocks.audit }));

const { syncSeoChangeApprovalState, onSeoApplyTaskApproved } = await import(
  "./approval-hook"
);

const NOW = new Date("2026-10-07T09:00:00.000Z");
const CHANGE = {
  id: "chg-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  kind: "TITLE_META",
  status: "PROPOSED",
  taskId: "task-1",
  approvalId: "appr-1",
};
const TASK = { id: "task-1", projectId: "proj-1", workspaceId: "ws-1" };
const PAYLOAD = {
  seoApply: { v: 1, changeId: "chg-1", kind: "TITLE_META" },
  details: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.changeFindUnique.mockResolvedValue({ ...CHANGE });
  mocks.changeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.approvalUpdateMany.mockResolvedValue({ count: 1 });
  mocks.taskFindFirst.mockResolvedValue({ payload: PAYLOAD });
  mocks.taskTransition.mockResolvedValue({});
  mocks.apply.mockResolvedValue({ state: "verified" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncSeoChangeApprovalState", () => {
  it("returns null for an unknown change", async () => {
    mocks.changeFindUnique.mockResolvedValue(null);
    expect(await syncSeoChangeApprovalState("nope")).toBeNull();
  });

  it("returns a non-PROPOSED status untouched, with no approval read", async () => {
    mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, status: "VERIFIED" });
    expect(await syncSeoChangeApprovalState("chg-1")).toBe("VERIFIED");
    expect(mocks.approvalFindUnique).not.toHaveBeenCalled();
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("stays PROPOSED while the approval is pending and not overdue", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "PENDING",
      reviewedByUserId: null,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
    });
    expect(await syncSeoChangeApprovalState("chg-1", { now: NOW })).toBe(
      "PROPOSED",
    );
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
  });

  it("APPROVED moves PROPOSED to APPROVED with the reviewer, audits it and starts the apply", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "APPROVED",
      reviewedByUserId: "owner-1",
      expiresAt: null,
    });
    mocks.changeFindUnique
      .mockResolvedValueOnce({ ...CHANGE })
      .mockResolvedValueOnce({ status: "VERIFIED" });

    expect(await syncSeoChangeApprovalState("chg-1", { now: NOW })).toBe(
      "VERIFIED",
    );
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "chg-1", status: "PROPOSED" },
      data: {
        status: "APPROVED",
        approvedByUserId: "owner-1",
        approvedAt: NOW,
      },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      "seo_change.approved",
      { changeId: "chg-1", kind: "TITLE_META" },
      expect.objectContaining({ userId: "owner-1" }),
    );
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith("chg-1", { now: NOW });
  });

  it("losing the CAS returns the current status and does not apply again", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "APPROVED",
      reviewedByUserId: "owner-1",
      expiresAt: null,
    });
    mocks.changeUpdateMany.mockResolvedValue({ count: 0 });
    mocks.changeFindUnique
      .mockResolvedValueOnce({ ...CHANGE })
      .mockResolvedValueOnce({ status: "APPLYING" });

    expect(await syncSeoChangeApprovalState("chg-1")).toBe("APPLYING");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(["REJECTED", "REVISION_REQUESTED"])(
    "%s closes the change as REJECTED, frees openKey and cancels the Task",
    async (approvalStatus) => {
      mocks.approvalFindUnique.mockResolvedValue({
        status: approvalStatus,
        reviewedByUserId: "u",
        expiresAt: null,
      });
      expect(await syncSeoChangeApprovalState("chg-1")).toBe("REJECTED");
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
        "seo_change.rejected",
        { changeId: "chg-1", kind: "TITLE_META" },
        expect.anything(),
      );
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["CANCELLED", "EXPIRED"])(
    "%s (a task cancelled by expireOverdue) leaves no PROPOSED row: EXPIRED",
    async (approvalStatus) => {
      mocks.approvalFindUnique.mockResolvedValue({
        status: approvalStatus,
        reviewedByUserId: null,
        expiresAt: null,
      });
      expect(await syncSeoChangeApprovalState("chg-1")).toBe("EXPIRED");
      expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
        where: { id: "chg-1", status: "PROPOSED" },
        data: { status: "EXPIRED", openKey: null },
      });
      expect(mocks.audit).toHaveBeenCalledWith(
        "seo_change.expired",
        { changeId: "chg-1", kind: "TITLE_META" },
        expect.anything(),
      );
    },
  );

  it("a PENDING approval past its expiry becomes EXPIRED on both rows", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "PENDING",
      reviewedByUserId: null,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    expect(await syncSeoChangeApprovalState("chg-1", { now: NOW })).toBe(
      "EXPIRED",
    );
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: "appr-1", status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      expect.anything(),
    );
  });

  it("a deleted approval row counts as expired", async () => {
    mocks.approvalFindUnique.mockResolvedValue(null);
    expect(await syncSeoChangeApprovalState("chg-1")).toBe("EXPIRED");
  });

  it("a PROPOSED row without an approval id is left alone", async () => {
    mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, approvalId: null });
    expect(await syncSeoChangeApprovalState("chg-1")).toBe("PROPOSED");
    expect(mocks.approvalFindUnique).not.toHaveBeenCalled();
  });

  it("is idempotent when the close CAS was lost to another caller", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "REJECTED",
      reviewedByUserId: "u",
      expiresAt: null,
    });
    mocks.changeUpdateMany.mockResolvedValue({ count: 0 });
    mocks.changeFindUnique
      .mockResolvedValueOnce({ ...CHANGE })
      .mockResolvedValueOnce({ status: "REJECTED" });
    expect(await syncSeoChangeApprovalState("chg-1")).toBe("REJECTED");
    expect(mocks.taskTransition).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("onSeoApplyTaskApproved", () => {
  function approvedApproval() {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "APPROVED",
      reviewedByUserId: "owner-1",
      expiresAt: null,
    });
  }

  it("reads the change id from the task payload, approves, moves the Task to RUNNING and applies", async () => {
    approvedApproval();
    await onSeoApplyTaskApproved(TASK, { now: NOW });

    expect(mocks.taskFindFirst).toHaveBeenCalledWith({
      where: { id: "task-1", projectId: "proj-1" },
      select: { payload: true },
    });
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: "chg-1", status: "PROPOSED" },
      data: expect.objectContaining({
        status: "APPROVED",
        approvedByUserId: "owner-1",
      }),
    });
    const statuses = mocks.taskTransition.mock.calls.map((call) => call[2]);
    expect(statuses).toEqual(["QUEUED", "RUNNING"]);
    expect(mocks.apply).toHaveBeenCalledWith("chg-1", { now: NOW });
  });

  it("applies an already APPROVED change (the sync won first) without a second CAS write", async () => {
    mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, status: "APPROVED" });
    await onSeoApplyTaskApproved(TASK);
    expect(mocks.changeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledWith("chg-1", {});
  });

  it("cancels the Task when its payload has no seoApply marker", async () => {
    mocks.taskFindFirst.mockResolvedValue({ payload: { request: "x" } });
    await onSeoApplyTaskApproved(TASK);
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      expect.objectContaining({ failureReason: expect.any(String) }),
    );
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("cancels the Task when the change belongs to another project or task", async () => {
    for (const other of [{ projectId: "proj-2" }, { taskId: "task-9" }]) {
      mocks.taskTransition.mockClear();
      mocks.apply.mockClear();
      mocks.changeFindUnique.mockResolvedValue({ ...CHANGE, ...other });
      await onSeoApplyTaskApproved(TASK);
      expect(mocks.taskTransition).toHaveBeenCalledWith(
        "task-1",
        "proj-1",
        "CANCELLED",
        expect.anything(),
      );
      expect(mocks.apply).not.toHaveBeenCalled();
    }
  });

  it("cancels the Task when the change row is gone", async () => {
    mocks.changeFindUnique.mockResolvedValue(null);
    await onSeoApplyTaskApproved(TASK);
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      expect.anything(),
    );
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("does not start the Task or the apply when the approval was rejected", async () => {
    mocks.approvalFindUnique.mockResolvedValue({
      status: "REJECTED",
      reviewedByUserId: "u",
      expiresAt: null,
    });
    await onSeoApplyTaskApproved(TASK);
    const statuses = mocks.taskTransition.mock.calls.map((call) => call[2]);
    expect(statuses).not.toContain("RUNNING");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("swallows invalid Task transitions", async () => {
    approvedApproval();
    mocks.taskTransition.mockRejectedValue(new Error("invalid transition"));
    await expect(onSeoApplyTaskApproved(TASK)).resolves.toBeUndefined();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("swallows apply errors", async () => {
    approvedApproval();
    mocks.apply.mockRejectedValue(new Error("wp down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(onSeoApplyTaskApproved(TASK)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("never throws, even when the database read fails", async () => {
    mocks.taskFindFirst.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(onSeoApplyTaskApproved(TASK)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("returns at the inline budget while the apply keeps running", async () => {
    vi.useFakeTimers();
    approvedApproval();
    let finish: (value: { state: string }) => void = () => undefined;
    let finished = false;
    mocks.apply.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = (value) => {
            finished = true;
            resolve(value);
          };
        }),
    );

    let returned = false;
    const hook = onSeoApplyTaskApproved(TASK).then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await hook;
    expect(returned).toBe(true);
    // Uygulama bittiğinde değil, bütçe dolunca dönmüştür.
    expect(finished).toBe(false);
    finish({ state: "verified" });
  });
});
