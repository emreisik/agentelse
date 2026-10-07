import { beforeEach, describe, expect, it, vi } from "vitest";

// docs/meta-ads-plan.md F0b: a spending (L4) approval comes only from a
// workspace OWNER/ADMIN, an expired approval cannot be decided, and an expired
// approval's task is cancelled instead of "Still working" forever.

const approval = {
  findFirst: vi.fn(),
  findFirstOrThrow: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
};
const workspaceMember = { findUnique: vi.fn() };
const task = { findUnique: vi.fn() };
const autonomyPolicy = { findUnique: vi.fn() };

vi.mock("@/lib/prisma", () => ({
  prisma: { approval, workspaceMember, task, autonomyPolicy },
}));
vi.mock("@/server/notifications/telegram-approval-notifier", () => ({
  sendApprovalRequestToTelegram: vi.fn(),
  notifyApprovalDecision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn().mockResolvedValue(undefined) },
}));

const { ApprovalRepository } =
  await import("@/server/repositories/approval.repository");
const { TaskRepository } =
  await import("@/server/repositories/task.repository");

const NOW = Date.now();

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "ap-1",
    workspaceId: "ws-1",
    projectId: "p-1",
    taskId: "task-1",
    status: "PENDING",
    level: "LEVEL_4_CRITICAL",
    expiresAt: new Date(NOW + 3600_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  approval.findFirst.mockResolvedValue(row());
  approval.findFirstOrThrow.mockResolvedValue(row({ status: "APPROVED" }));
  approval.updateMany.mockResolvedValue({ count: 1 });
  workspaceMember.findUnique.mockResolvedValue({ role: "OWNER" });
  autonomyPolicy.findUnique.mockResolvedValue(null);
});

describe("ApprovalRepository.decide", () => {
  it("lets a workspace owner approve spending", async () => {
    await ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "user-1");
    expect(approval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "ap-1",
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it("refuses spending approval from a MEMBER", async () => {
    workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    await expect(
      ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "user-2"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(approval.updateMany).not.toHaveBeenCalled();
  });

  // F8: müşteri onaylayıcısı yalnız kendi projesinin harcamasını onaylar.
  it("lets this project's spend approver approve its spending", async () => {
    workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    autonomyPolicy.findUnique.mockResolvedValue({
      workspaceId: "ws-1",
      adsSpendApproverIds: ["client-1"],
    });
    await ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "client-1");
    expect(autonomyPolicy.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p-1" } }),
    );
    expect(approval.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses a spend approver of another project", async () => {
    workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    autonomyPolicy.findUnique.mockResolvedValue({
      workspaceId: "ws-1",
      adsSpendApproverIds: ["client-9"],
    });
    await expect(
      ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "client-1"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(approval.updateMany).not.toHaveBeenCalled();
  });

  it("refuses spending approval from Telegram's pseudo-user", async () => {
    await expect(
      ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "telegram:42"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("still lets anyone reject a spending approval", async () => {
    workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    await ApprovalRepository.decide("ap-1", "p-1", "REJECTED", "telegram:42");
    expect(approval.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not gate an ordinary (L3) approval by role", async () => {
    approval.findFirst.mockResolvedValue(row({ level: "LEVEL_3_CLIENT" }));
    await ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "telegram:42");
    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(approval.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired approval at decision time", async () => {
    approval.findFirst.mockResolvedValue(
      row({ expiresAt: new Date(NOW - 1000) }),
    );
    await expect(
      ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "user-1"),
    ).rejects.toThrow("This approval expired. Ask again.");
    expect(approval.updateMany).not.toHaveBeenCalled();
  });
});

// GA-F7: Google Analytics değişikliği onayı yalnız OWNER/ADMIN'den gelir.
describe("ApprovalRepository.decide: CRITICAL_CHANGE_APPROVAL", () => {
  const gaRow = () =>
    row({ type: "CRITICAL_CHANGE_APPROVAL", level: "LEVEL_3_CLIENT" });

  it("refuses approval from a plain MEMBER and does not update the approval", async () => {
    approval.findFirst.mockResolvedValue(gaRow());
    workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    await expect(
      ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "user-2"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(approval.updateMany).not.toHaveBeenCalled();
  });

  it("refuses Telegram's pseudo-user without a membership lookup", async () => {
    approval.findFirst.mockResolvedValue(gaRow());
    await expect(
      ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "telegram:123"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(approval.updateMany).not.toHaveBeenCalled();
  });

  it("does not fall back to the spend-approver list", async () => {
    approval.findFirst.mockResolvedValue(gaRow());
    workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    autonomyPolicy.findUnique.mockResolvedValue({
      workspaceId: "ws-1",
      adsSpendApproverIds: ["client-1"],
    });
    await expect(
      ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "client-1"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(autonomyPolicy.findUnique).not.toHaveBeenCalled();
  });

  it.each(["OWNER", "ADMIN"])("lets a workspace %s approve", async (role) => {
    approval.findFirst.mockResolvedValue(gaRow());
    workspaceMember.findUnique.mockResolvedValue({ role });
    await ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "user-1");
    expect(approval.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(["REJECTED", "REVISION_REQUESTED"] as const)(
    "refuses %s from a plain MEMBER too (chat path included)",
    async (to) => {
      approval.findFirst.mockResolvedValue(gaRow());
      workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
      await expect(
        ApprovalRepository.decide("ap-1", "p-1", to, "user-2"),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(approval.updateMany).not.toHaveBeenCalled();
    },
  );

  it("lets a workspace owner reject", async () => {
    approval.findFirst.mockResolvedValue(gaRow());
    workspaceMember.findUnique.mockResolvedValue({ role: "OWNER" });
    await ApprovalRepository.decide("ap-1", "p-1", "REJECTED", "user-1");
    expect(approval.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not gate the system's CANCELLED transition", async () => {
    approval.findFirst.mockResolvedValue(gaRow());
    await ApprovalRepository.decide("ap-1", "p-1", "CANCELLED", "system");
    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(approval.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not run this gate for another approval type", async () => {
    approval.findFirst.mockResolvedValue(
      row({ type: "PUBLISH_APPROVAL", level: "LEVEL_3_CLIENT" }),
    );
    await ApprovalRepository.decide("ap-1", "p-1", "APPROVED", "user-2");
    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(approval.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("ApprovalRepository.expireOverdue", () => {
  it("expires the approval and cancels its still-open task", async () => {
    approval.findMany.mockResolvedValue([
      { id: "ap-1", projectId: "p-1", taskId: "task-1" },
    ]);
    task.findUnique.mockResolvedValue({ status: "WAITING_APPROVAL" });

    await expect(ApprovalRepository.expireOverdue()).resolves.toEqual({
      count: 1,
    });
    expect(approval.updateMany).toHaveBeenCalledWith({
      where: { id: "ap-1", status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    expect(TaskRepository.transition).toHaveBeenCalledWith(
      "task-1",
      "p-1",
      "CANCELLED",
      { failureReason: "Approval expired" },
    );
  });

  it("leaves a terminal task alone", async () => {
    approval.findMany.mockResolvedValue([
      { id: "ap-1", projectId: "p-1", taskId: "task-1" },
    ]);
    task.findUnique.mockResolvedValue({ status: "CANCELLED" });

    await ApprovalRepository.expireOverdue();
    expect(TaskRepository.transition).not.toHaveBeenCalled();
  });
});
