import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: Disconnect temizliği bekleyen değişiklikleri
// kapatır (PROPOSED/APPROVED -> EXPIRED, bekleyen onay CANCELLED, açık Task
// CANCELLED); sitenin HER değişikliğinin (her durum) Task metni silinir; onay
// isteği kartı VE karar kartı sabit başlığa çevrilir, ayrıntı alanları
// kalkar, replyText sabit olur; SEO_APPLY kapalıyken de çalışır; hata asla
// dışarı çıkmaz.

const mocks = vi.hoisted(() => ({
  changeFindMany: vi.fn(),
  changeUpdateMany: vi.fn(),
  approvalUpdateMany: vi.fn(),
  taskUpdateMany: vi.fn(),
  commandFindMany: vi.fn(),
  commandUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoChange: {
      findMany: mocks.changeFindMany,
      updateMany: mocks.changeUpdateMany,
    },
    approval: { updateMany: mocks.approvalUpdateMany },
    task: { updateMany: mocks.taskUpdateMany },
    command: { findMany: mocks.commandFindMany, update: mocks.commandUpdate },
  },
}));

const { cleanupSeoApplyForSite } = await import("./cleanup");

const ROWS = [
  { id: "c1", projectId: "p1", status: "PROPOSED", taskId: "t1", approvalId: "a1" },
  { id: "c2", projectId: "p1", status: "APPROVED", taskId: "t2", approvalId: "a2" },
  { id: "c3", projectId: "p1", status: "VERIFIED", taskId: "t3", approvalId: "a3" },
  { id: "c4", projectId: "p1", status: "FAILED", taskId: "t4", approvalId: null },
  { id: "c5", projectId: "p1", status: "REJECTED", taskId: null, approvalId: null },
];

const REQUEST_CARD = {
  card: {
    kind: "approval-request",
    approvalId: "a1",
    taskId: "t1",
    title: "Create a WordPress draft",
    riskLevel: "HIGH",
    details: [{ label: "Page", value: "/pricing" }],
    category: "action",
  },
  departmentKey: "SEO",
};
const DECISION_CARD = {
  card: {
    kind: "approval-decision",
    approvalId: "a3",
    title: "Create a WordPress draft",
    entityType: "Task",
    decision: "APPROVED",
    note: "looks good for /pricing",
  },
  departmentKey: "SEO",
};

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.changeFindMany.mockResolvedValue(ROWS);
  mocks.changeUpdateMany.mockResolvedValue({ count: 2 });
  mocks.approvalUpdateMany.mockResolvedValue({ count: 3 });
  mocks.taskUpdateMany.mockResolvedValue({ count: 4 });
  mocks.commandFindMany.mockResolvedValue([]);
  mocks.commandUpdate.mockResolvedValue({});
});

describe("cleanupSeoApplyForSite", () => {
  it("does nothing for a site without changes", async () => {
    mocks.changeFindMany.mockResolvedValue([]);
    expect(await cleanupSeoApplyForSite("site1")).toBe(0);
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.commandFindMany).not.toHaveBeenCalled();
  });

  it("runs with every SEO flag off", async () => {
    expect(await cleanupSeoApplyForSite("site1")).toBe(2);
    expect(mocks.changeFindMany).toHaveBeenCalledWith({
      where: { siteId: "site1" },
      select: {
        id: true,
        projectId: true,
        status: true,
        taskId: true,
        approvalId: true,
      },
    });
  });

  it("expires PROPOSED and APPROVED rows and cancels their approvals and tasks", async () => {
    await cleanupSeoApplyForSite("site1");
    expect(mocks.changeUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["c1", "c2"] }, status: { in: ["PROPOSED", "APPROVED"] } },
      data: {
        status: "EXPIRED",
        openKey: null,
        leaseUntil: null,
        leaseOwner: null,
      },
    });
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2", "a3"] }, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["t1", "t2", "t3", "t4"] },
        status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] },
      },
      data: { status: "CANCELLED" },
    });
  });

  it("scrubs the Task text of every change, whatever its status", async () => {
    await cleanupSeoApplyForSite("site1");
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["t1", "t2", "t3", "t4"] } },
      data: { title: "WordPress change", description: null, payload: {} },
    });
  });

  it("scrubs the approval request card and the approval decision card", async () => {
    mocks.commandFindMany.mockResolvedValue([
      { id: "m1", parsedIntent: REQUEST_CARD },
      { id: "m2", parsedIntent: DECISION_CARD },
    ]);
    await cleanupSeoApplyForSite("site1");

    const query = mocks.commandFindMany.mock.calls[0]?.[0];
    expect(query.where.source).toBe("SYSTEM");
    expect(query.where.projectId).toEqual({ in: ["p1"] });
    expect(query.where.OR).toContainEqual({
      parsedIntent: { path: ["card", "approvalId"], equals: "a3" },
    });
    expect(query.where.OR).toContainEqual({
      parsedIntent: { path: ["card", "taskId"], equals: "t1" },
    });

    const updates = mocks.commandUpdate.mock.calls.map((call) => call[0]);
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.data.replyText).toBe("WordPress change");
      expect(update.data.parsedIntent.card.title).toBe("WordPress change");
      expect(update.data.parsedIntent.card.details).toBeUndefined();
      expect(update.data.parsedIntent.card.note).toBeUndefined();
      expect(update.data.parsedIntent.departmentKey).toBe("SEO");
    }
    expect(updates[0].data.parsedIntent.card.kind).toBe("approval-request");
    expect(updates[1].data.parsedIntent.card.kind).toBe("approval-decision");
    expect(updates[1].data.parsedIntent.card.decision).toBe("APPROVED");
  });

  it("leaves rows without a card untouched", async () => {
    mocks.commandFindMany.mockResolvedValue([
      { id: "m1", parsedIntent: null },
      { id: "m2", parsedIntent: { departmentKey: "SEO" } },
    ]);
    await cleanupSeoApplyForSite("site1");
    expect(mocks.commandUpdate).not.toHaveBeenCalled();
  });

  it("never throws and still runs the later steps after a failure", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.changeUpdateMany.mockRejectedValue(new Error("db down"));
    mocks.approvalUpdateMany.mockRejectedValue(new Error("db down"));
    await expect(cleanupSeoApplyForSite("site1")).resolves.toBe(0);
    expect(mocks.taskUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.commandFindMany).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("returns 0 when even the first read fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.changeFindMany.mockRejectedValue(new Error("db down"));
    await expect(cleanupSeoApplyForSite("site1")).resolves.toBe(0);
    expect(quiet).toHaveBeenCalledWith(
      "[seo-apply] disconnect cleanup failed:",
      "Error",
    );
    quiet.mockRestore();
  });
});
