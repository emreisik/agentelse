import { beforeEach, describe, expect, it, vi } from "vitest";

// Billing (Faz 3C): automatic work that would cost more than the approval size waits for a
// person; the planner only passes the numbers to the approval policy (which is real here).

const costApprovalContext = vi.fn();
vi.mock("@/server/billing/approval-threshold", () => ({ costApprovalContext }));

const create = vi.fn();
const transition = vi.fn();
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { create, transition },
}));
const approvalCreate = vi.fn();
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: approvalCreate },
}));
const postApprovalRequestCard = vi.fn();
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: { postApprovalRequestCard },
}));
vi.mock("@/server/context/context-snapshot.service", () => ({
  ContextSnapshotService: {
    create: vi.fn().mockResolvedValue({ id: "snap-1" }),
  },
}));
const dispatch = vi.fn();
vi.mock("@/server/execution/execution-service", () => ({
  ExecutionService: { dispatch },
}));

const { TaskPlanner } = await import("@/server/commands/task-planner");

const CHEAP = { estimatedCostUsd: 0.4, approveAboveUsd: 1 };
const COSTLY = {
  estimatedCostUsd: 1.2,
  approveAboveUsd: 1,
  note: "This automatic task would use 3 post images of your plan.",
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "w1",
    projectId: "p1",
    brandId: "b1",
    capability: "CREATE_SOCIAL_CREATIVE" as const,
    request: "a post for Friday",
    createdByType: "SYSTEM" as const,
    payloadExtra: { variantCount: 3 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockImplementation(async (data: Record<string, unknown>) => ({
    id: "task-1",
    ...data,
  }));
  transition.mockResolvedValue(undefined);
  approvalCreate.mockResolvedValue({
    id: "ap-1",
    type: "GENERIC",
    level: "LEVEL_3_CLIENT",
  });
  postApprovalRequestCard.mockResolvedValue(undefined);
  dispatch.mockResolvedValue({ id: "job-1" });
  costApprovalContext.mockResolvedValue({});
});

describe("planForCapability and the approval size", () => {
  it("asks the size for the task it is about to create, with the same payload dispatch will get", async () => {
    await TaskPlanner.planForCapability(input());

    expect(costApprovalContext).toHaveBeenCalledWith({
      workspaceId: "w1",
      projectId: "p1",
      capability: "CREATE_SOCIAL_CREATIVE",
      payload: {
        request: "a post for Friday",
        platform: undefined,
        variantCount: 3,
      },
      createdByType: "SYSTEM",
    });
  });

  it("parks costly automatic work behind an approval, with the reason on the card, and runs nothing", async () => {
    costApprovalContext.mockResolvedValue(COSTLY);

    const result = await TaskPlanner.planForCapability(input());

    expect(result.dispatched).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith("task-1", "p1", "WAITING_APPROVAL");
    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ level: "LEVEL_3_CLIENT" }),
    );
    expect(postApprovalRequestCard).toHaveBeenCalledWith(
      expect.objectContaining({
        details: [{ label: "Why you are asked", value: COSTLY.note }],
      }),
    );
  });

  it("lets automatic work that is within the size go straight on", async () => {
    costApprovalContext.mockResolvedValue(CHEAP);

    const result = await TaskPlanner.planForCapability(
      input({ payloadExtra: {} }),
    );

    expect(result.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("does not hold back the user's own request, whatever the helper says", async () => {
    costApprovalContext.mockResolvedValue({}); // the helper returns nothing for a user
    const result = await TaskPlanner.planForCapability(
      input({ createdByType: "USER" }),
    );
    expect(result.dispatched).toBe(true);
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("a plan-node task is created ready but marked as needing approval when it is costly", async () => {
    costApprovalContext.mockResolvedValue(COSTLY);

    const result = await TaskPlanner.planForCapability(
      input({ deferDispatch: true }),
    );

    expect(result).toMatchObject({ deferred: true, level: "LEVEL_3_CLIENT" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ requiresApproval: true }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("requestApproval for a task that was deferred", () => {
  const stored = {
    id: "task-9",
    workspaceId: "w1",
    projectId: "p1",
    brandId: "b1",
    title: "A post",
    capability: "CREATE_SOCIAL_CREATIVE" as const,
    riskLevel: "LOW" as const,
    createdByType: "SYSTEM" as const,
    createdByUserId: null,
    departmentKey: null,
    payload: { request: "a post", variantCount: 3 },
  };

  it("asks the size again from the stored task and parks it at the person's level", async () => {
    costApprovalContext.mockResolvedValue(COSTLY);

    await TaskPlanner.requestApproval(stored);

    expect(costApprovalContext).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: stored.payload,
        createdByType: "SYSTEM",
      }),
    );
    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ level: "LEVEL_3_CLIENT" }),
    );
    expect(postApprovalRequestCard).toHaveBeenCalledWith(
      expect.objectContaining({
        details: [{ label: "Why you are asked", value: COSTLY.note }],
      }),
    );
  });

  it("does not ask again when the caller already decided the level", async () => {
    await TaskPlanner.requestApproval(stored, "LEVEL_3_CLIENT", COSTLY.note);

    expect(costApprovalContext).not.toHaveBeenCalled();
    expect(postApprovalRequestCard).toHaveBeenCalledWith(
      expect.objectContaining({
        details: [{ label: "Why you are asked", value: COSTLY.note }],
      }),
    );
  });
});

describe("approvalNow: what a stored task needs right now", () => {
  const stored = {
    workspaceId: "w1",
    projectId: "p1",
    capability: "CREATE_SOCIAL_CREATIVE" as const,
    riskLevel: "LOW" as const,
    createdByType: "SYSTEM" as const,
    payload: { request: "a post", variantCount: 3 },
  };

  it("sizes the task with its own stored payload and says it needs a person when it is costly", async () => {
    costApprovalContext.mockResolvedValue(COSTLY);

    const answer = await TaskPlanner.approvalNow(stored);

    expect(costApprovalContext).toHaveBeenCalledWith({
      workspaceId: "w1",
      projectId: "p1",
      capability: "CREATE_SOCIAL_CREATIVE",
      payload: stored.payload,
      createdByType: "SYSTEM",
    });
    expect(answer).toEqual({
      level: "LEVEL_3_CLIENT",
      requiresApproval: true,
      note: COSTLY.note,
      sizeUnknown: false,
    });
  });

  it("says it does not for work within the size, and for the user's own", async () => {
    costApprovalContext.mockResolvedValue(CHEAP);
    expect(await TaskPlanner.approvalNow(stored)).toEqual({
      level: "LEVEL_1_INTERNAL_AUTOMATIC",
      requiresApproval: false,
      note: undefined,
      sizeUnknown: false,
    });

    costApprovalContext.mockResolvedValue({});
    expect(
      await TaskPlanner.approvalNow({ ...stored, createdByType: "USER" }),
    ).toMatchObject({ level: "LEVEL_0_AUTO_OBSERVE", requiresApproval: false });
  });

  it("passes on that the cost could not be sized, instead of passing it off as 'under the size'", async () => {
    costApprovalContext.mockResolvedValue({
      unknown: true,
      note: "This automatic task would use 3 post images of your plan.",
    });

    const answer = await TaskPlanner.approvalNow(stored);

    expect(answer).toMatchObject({
      level: "LEVEL_1_INTERNAL_AUTOMATIC",
      requiresApproval: false,
      sizeUnknown: true,
      note: "This automatic task would use 3 post images of your plan.",
    });
  });

  it("keeps the capability's own floor whatever the cost", async () => {
    costApprovalContext.mockResolvedValue({});

    const answer = await TaskPlanner.approvalNow({
      ...stored,
      capability: "TIKTOK_PUBLISH",
    });

    expect(answer).toMatchObject({
      level: "LEVEL_3_CLIENT",
      requiresApproval: true,
    });
  });
});
