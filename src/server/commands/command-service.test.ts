import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantee this file exists to prove: the "revize et" chat intent
// used to be a dead end — ApprovalRepository.decide(..., "REVISION_REQUESTED")
// was recorded and nothing else ever happened (REVISION_REQUESTED's only
// legal transition is -> CANCELLED). CommandService.submit's APPROVAL_DECISION
// REVISE branch must now actually act: regenerate a Creative directly, or
// cancel+recreate a non-creative Task with the feedback folded in.

const commandCreate = vi.fn().mockResolvedValue({ id: "cmd-1" });
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: { create: commandCreate },
}));

vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));

const approvalDecide = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { decide: approvalDecide },
}));

vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn().mockResolvedValue(null),
  },
}));

const taskTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: taskTransition },
}));

const planForCapability = vi.fn().mockResolvedValue({ task: { id: "t-2" } });
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability, dispatchApprovedTask: vi.fn() },
}));

const performCreativeRevision = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/server/actions/creative-actions", () => ({
  performCreativeRevision,
}));

const approvalFindMany = vi.fn();
const taskFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    approval: { findMany: approvalFindMany },
    task: { findUnique: taskFindUnique },
  },
}));

const { CommandService } = await import("./command-service");

function baseInput(note: string) {
  return {
    workspaceId: "ws-1",
    source: "WEB" as const,
    rawText: `revize et: ${note}`,
    actorType: "USER" as const,
    userId: "user-1",
    knownProjectId: "proj-1",
    intent: {
      kind: "APPROVAL_DECISION" as const,
      decision: "REVISE" as const,
      note,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  commandCreate.mockResolvedValue({ id: "cmd-1" });
  approvalDecide.mockResolvedValue(undefined);
});

describe("CommandService.submit — APPROVAL_DECISION REVISE", () => {
  it("regenerates the Creative directly when the approval is creative-backed", async () => {
    approvalFindMany.mockResolvedValue([
      {
        id: "appr-1",
        projectId: "proj-1",
        taskId: "task-1",
        entityType: "Creative",
        entityId: "creative-1",
      },
    ]);

    const result = await CommandService.submit(
      baseInput("more vibrant colors"),
    );

    expect(approvalDecide).toHaveBeenCalledWith(
      "appr-1",
      "proj-1",
      "REVISION_REQUESTED",
      "user-1",
      "more vibrant colors",
    );
    expect(performCreativeRevision).toHaveBeenCalledWith({
      creativeId: "creative-1",
      instruction: "more vibrant colors",
      mode: "edit",
      userId: "user-1",
    });
    expect(taskTransition).not.toHaveBeenCalled();
    expect(planForCapability).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "APPROVAL_HANDLED",
      commandId: "cmd-1",
      approvalId: "appr-1",
    });
  });

  it("cancels and recreates the Task with the feedback folded in when the approval is task-backed, non-creative", async () => {
    approvalFindMany.mockResolvedValue([
      {
        id: "appr-2",
        projectId: "proj-1",
        taskId: "task-2",
        entityType: "Task",
        entityId: "task-2",
      },
    ]);
    taskFindUnique.mockResolvedValue({
      status: "WAITING_APPROVAL",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      capability: "CREATE_CAMPAIGN_BRIEF",
      departmentKey: "COPY_CONTENT",
      workPlanId: null,
      goalIds: ["goal-1"],
      description: "Write a campaign brief",
    });

    await CommandService.submit(baseInput("make it shorter and punchier"));

    expect(taskTransition).toHaveBeenCalledWith(
      "task-2",
      "proj-1",
      "CANCELLED",
      { failureReason: "Superseded by revision request" },
    );
    expect(planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "CREATE_CAMPAIGN_BRIEF",
        departmentKey: "COPY_CONTENT",
        goalIds: ["goal-1"],
        createdByType: "USER",
        createdByUserId: "user-1",
        request: expect.stringContaining("make it shorter and punchier"),
      }),
    );
    expect(performCreativeRevision).not.toHaveBeenCalled();
  });

  it("does not recreate a task that already reached a terminal status", async () => {
    approvalFindMany.mockResolvedValue([
      {
        id: "appr-3",
        projectId: "proj-1",
        taskId: "task-3",
        entityType: "Task",
        entityId: "task-3",
      },
    ]);
    taskFindUnique.mockResolvedValue({
      status: "COMPLETED",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      capability: "CREATE_CAMPAIGN_BRIEF",
      departmentKey: "COPY_CONTENT",
      workPlanId: null,
      goalIds: [],
      description: "Write a campaign brief",
    });

    await CommandService.submit(baseInput("try again"));

    expect(taskTransition).not.toHaveBeenCalled();
    expect(planForCapability).not.toHaveBeenCalled();
  });
});
