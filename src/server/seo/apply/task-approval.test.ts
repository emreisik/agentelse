import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Task ve kart başlıkları sabittir (URL, sayfa yolu
// ve makale başlığı içermez), yük seoApply işaretini taşır, Approval
// CRITICAL_CHANGE_APPROVAL + LEVEL_3_CLIENT + notify:false ve çağıranın verdiği
// expiresAt ile kurulur, sohbet kartı sözleşmedeki tam argümanlarla gönderilir
// ve kart yazılamazsa onay yine de kurulur; onay kurulamazsa Task iptal edilir.

const mocks = vi.hoisted(() => ({
  taskCreate: vi.fn(),
  taskTransition: vi.fn(),
  approvalCreate: vi.fn(),
  postCard: vi.fn(),
}));

vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: {
    create: mocks.taskCreate,
    transition: mocks.taskTransition,
  },
}));
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: mocks.approvalCreate },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { postApprovalRequestCard: mocks.postCard },
}));

const { createSeoApplyTaskApproval } = await import("./task-approval");
const { SEO_CHANGE_TASK_TITLE } = await import("@/lib/seo/apply/copy");
const { isSeoApplyPayload } = await import("@/lib/seo/apply/approval-details");

const NOW = new Date("2026-10-07T09:00:00.000Z");
const EXPIRES = new Date("2026-10-14T09:00:00.000Z");
const DETAILS = [
  { label: "Where", value: "example.com" },
  { label: "Page", value: "/pricing" },
];

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    userId: "user-1",
    changeId: "chg-1",
    kind: "TITLE_META" as const,
    details: DETAILS,
    expiresAt: EXPIRES,
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.taskCreate.mockResolvedValue({ id: "task-1" });
  mocks.taskTransition.mockResolvedValue({});
  mocks.approvalCreate.mockResolvedValue({ id: "appr-1" });
  mocks.postCard.mockResolvedValue(undefined);
});

describe("createSeoApplyTaskApproval", () => {
  it("creates a WEBSITE_UPDATE task with a fixed title and the seoApply marker", async () => {
    const result = await createSeoApplyTaskApproval(input());
    expect(result).toEqual({ taskId: "task-1", approvalId: "appr-1" });

    const created = mocks.taskCreate.mock.calls[0]![0] as {
      capability: string;
      title: string;
      description: string;
      payload: unknown;
      requiresApproval: boolean;
      departmentKey: string;
      createdByType: string;
      createdByUserId: string;
      riskLevel: string;
    };
    expect(created.capability).toBe("WEBSITE_UPDATE");
    expect(created.title).toBe(SEO_CHANGE_TASK_TITLE.TITLE_META);
    expect(created.requiresApproval).toBe(true);
    expect(created.departmentKey).toBe("SEO");
    expect(created.createdByType).toBe("USER");
    expect(created.createdByUserId).toBe("user-1");
    expect(created.riskLevel).toBe("HIGH");
    expect(isSeoApplyPayload(created.payload)).toBe(true);
    expect(created.payload).toMatchObject({
      seoApply: { v: 1, changeId: "chg-1", kind: "TITLE_META" },
      details: DETAILS,
    });
  });

  it("keeps URLs, paths and article titles out of the task and card titles", async () => {
    await createSeoApplyTaskApproval(
      input({
        kind: "PUBLISH_ARTICLE",
        details: [
          { label: "Title", value: "Secret Launch Article" },
          { label: "Where", value: "example.com" },
        ],
      }),
    );
    const created = mocks.taskCreate.mock.calls[0]![0] as {
      title: string;
      description: string;
    };
    const card = mocks.postCard.mock.calls[0]![0] as { title: string };
    for (const text of [created.title, created.description, card.title]) {
      expect(text).not.toMatch(/https?:|example\.com|Secret Launch|\//i);
    }
    expect(card.title).toBe(SEO_CHANGE_TASK_TITLE.PUBLISH_ARTICLE);
  });

  it("moves the task to WAITING_APPROVAL before the approval is created", async () => {
    await createSeoApplyTaskApproval(input());
    expect(mocks.taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "WAITING_APPROVAL",
    );
    expect(mocks.taskTransition.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.approvalCreate.mock.invocationCallOrder[0]!,
    );
  });

  it("creates a CRITICAL_CHANGE_APPROVAL at LEVEL_3_CLIENT with notify:false and the given expiry", async () => {
    await createSeoApplyTaskApproval(input());
    expect(mocks.approvalCreate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      taskId: "task-1",
      entityType: "Task",
      entityId: "task-1",
      type: "CRITICAL_CHANGE_APPROVAL",
      level: "LEVEL_3_CLIENT",
      requestedByType: "USER",
      requestedById: "user-1",
      expiresAt: EXPIRES,
      notify: false,
    });
  });

  it("posts the approval card with the exact contract arguments", async () => {
    await createSeoApplyTaskApproval(input());
    expect(mocks.postCard).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      taskId: "task-1",
      approvalId: "appr-1",
      title: SEO_CHANGE_TASK_TITLE.TITLE_META,
      riskLevel: "HIGH",
      departmentKey: "SEO",
      category: "action",
      details: DETAILS,
    });
  });

  it("still returns the pair when the chat card cannot be posted", async () => {
    mocks.postCard.mockRejectedValue(new Error("chat down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createSeoApplyTaskApproval(input())).resolves.toEqual({
      taskId: "task-1",
      approvalId: "appr-1",
    });
    spy.mockRestore();
  });

  it("cancels the task with a fixed reason when the approval cannot be created", async () => {
    mocks.approvalCreate.mockRejectedValue(new Error("db down"));
    await expect(createSeoApplyTaskApproval(input())).rejects.toThrow("db down");
    expect(mocks.taskTransition).toHaveBeenLastCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      { failureReason: "The WordPress change could not be requested" },
    );
    expect(mocks.postCard).not.toHaveBeenCalled();
  });
});
