import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves: a job made for a content-plan slot fills THAT slot
// (and only an empty DRAFT of the same project, atomically), a job with no
// slot is left to the ordinary path, and a slot that could not be filled is
// handed back instead of staying "in review" with nothing in it.

const taskFindUnique = vi.fn();
const creativeUpdateMany = vi.fn();
const creativeFindUnique = vi.fn();
const creativeFindUniqueOrThrow = vi.fn();
const creativeUpdate = vi.fn();
const versionCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: taskFindUnique },
    creative: {
      updateMany: creativeUpdateMany,
      findUnique: creativeFindUnique,
      findUniqueOrThrow: creativeFindUniqueOrThrow,
      update: creativeUpdate,
    },
    creativeVersion: { create: versionCreate },
  },
}));

const approvalCreate = vi.fn();
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { create: approvalCreate },
}));

const {
  planCreativeIdOf,
  claimPlanCreative,
  releasePlanCreative,
  fillPlanCreativeWithText,
} = await import("./plan-creative-link");

beforeEach(() => {
  vi.clearAllMocks();
  taskFindUnique.mockResolvedValue({ payload: { planCreativeId: "slot-1" } });
  creativeUpdateMany.mockResolvedValue({ count: 1 });
  creativeFindUnique.mockResolvedValue({ id: "slot-1", platform: "INSTAGRAM" });
  creativeFindUniqueOrThrow.mockResolvedValue({
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
  });
  versionCreate.mockResolvedValue({ id: "ver-1" });
  creativeUpdate.mockResolvedValue({});
  approvalCreate.mockResolvedValue({ id: "appr-1" });
});

describe("planCreativeIdOf", () => {
  it("reads only a non-empty string", () => {
    expect(planCreativeIdOf({ planCreativeId: "c1" })).toBe("c1");
    expect(planCreativeIdOf({ planCreativeId: "" })).toBeUndefined();
    expect(planCreativeIdOf({ planCreativeId: 5 })).toBeUndefined();
    expect(planCreativeIdOf({})).toBeUndefined();
    expect(planCreativeIdOf(null)).toBeUndefined();
    expect(planCreativeIdOf("x")).toBeUndefined();
  });
});

describe("claimPlanCreative", () => {
  it("takes an empty draft slot of the same project, conditionally", async () => {
    const slot = await claimPlanCreative({
      taskId: "task-1",
      projectId: "proj-1",
    });
    expect(slot).toEqual({ id: "slot-1", platform: "INSTAGRAM" });
    // The guard IS the safety: same project, still a draft, still empty.
    expect(creativeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "slot-1",
        projectId: "proj-1",
        status: "DRAFT",
        currentVersionId: null,
      },
      data: { status: "IN_REVIEW", createdByTaskId: "task-1" },
    });
  });

  it("leaves a job with no slot to the ordinary path", async () => {
    taskFindUnique.mockResolvedValue({ payload: { request: "x" } });
    expect(
      await claimPlanCreative({ taskId: "task-1", projectId: "proj-1" }),
    ).toBeNull();
    expect(creativeUpdateMany).not.toHaveBeenCalled();
  });

  it("does not take a slot that is gone, filled or another project's", async () => {
    creativeUpdateMany.mockResolvedValue({ count: 0 });
    expect(
      await claimPlanCreative({ taskId: "task-1", projectId: "proj-1" }),
    ).toBeNull();
    expect(creativeFindUnique).not.toHaveBeenCalled();
  });
});

describe("releasePlanCreative", () => {
  it("only reverts a slot that is still empty and in review", async () => {
    await releasePlanCreative("slot-1");
    expect(creativeUpdateMany).toHaveBeenCalledWith({
      where: { id: "slot-1", status: "IN_REVIEW", currentVersionId: null },
      data: { status: "DRAFT", createdByTaskId: null },
    });
  });
});

describe("fillPlanCreativeWithText", () => {
  it("writes the text as version 1 and opens the creative approval", async () => {
    const filled = await fillPlanCreativeWithText({
      taskId: "task-1",
      projectId: "proj-1",
      text: "  Hook: ...\nScene 1  ",
    });
    expect(filled).toBe(true);
    expect(versionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creativeId: "slot-1",
        version: 1,
        copy: "Hook: ...\nScene 1",
      }),
    });
    expect(creativeUpdate).toHaveBeenCalledWith({
      where: { id: "slot-1" },
      data: { currentVersionId: "ver-1" },
    });
    expect(approvalCreate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      taskId: "task-1",
      entityType: "Creative",
      entityId: "slot-1",
      type: "CREATIVE_APPROVAL",
      requestedByType: "AI",
      notify: true,
    });
  });

  it("does not notify Telegram for a SYSTEM-created task (weekly-plan-produce.ts)", async () => {
    taskFindUnique.mockResolvedValue({
      payload: { planCreativeId: "slot-1" },
      createdByType: "SYSTEM",
    });
    await fillPlanCreativeWithText({
      taskId: "task-1",
      projectId: "proj-1",
      text: "Hook",
    });
    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ notify: false }),
    );
  });

  it("does nothing for an empty result", async () => {
    expect(
      await fillPlanCreativeWithText({
        taskId: "task-1",
        projectId: "proj-1",
        text: "   ",
      }),
    ).toBe(false);
    expect(creativeUpdateMany).not.toHaveBeenCalled();
  });

  it("does nothing when there is no slot to fill", async () => {
    creativeUpdateMany.mockResolvedValue({ count: 0 });
    expect(
      await fillPlanCreativeWithText({
        taskId: "task-1",
        projectId: "proj-1",
        text: "text",
      }),
    ).toBe(false);
    expect(versionCreate).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it("hands the slot back when it cannot be filled", async () => {
    versionCreate.mockRejectedValue(new Error("db down"));
    await expect(
      fillPlanCreativeWithText({
        taskId: "task-1",
        projectId: "proj-1",
        text: "text",
      }),
    ).rejects.toThrow("db down");
    // First call took the slot, the last one gave it back.
    const calls = creativeUpdateMany.mock.calls;
    expect(calls.at(-1)?.[0]).toEqual({
      where: { id: "slot-1", status: "IN_REVIEW", currentVersionId: null },
      data: { status: "DRAFT", createdByTaskId: null },
    });
    expect(approvalCreate).not.toHaveBeenCalled();
  });
});
