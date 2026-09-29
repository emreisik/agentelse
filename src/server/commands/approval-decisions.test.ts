import { beforeEach, describe, expect, it, vi } from "vitest";

// applyApprovalDecision is shared by the web approve/reject buttons and the
// Telegram poller. This suite covers the one thing added to it: a decision on a
// finished creative is remembered as a reaction of the client's, while a
// decision on anything else is not, and the memory write never gets between the
// client and the decision itself.

const creativeFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findUnique: creativeFindUnique },
    task: { findUnique: vi.fn().mockResolvedValue(null) },
    projectSchedule: { count: vi.fn().mockResolvedValue(0) },
  },
}));

const decide = vi.fn();
vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { decide },
}));
const creativeTransition = vi.fn();
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { transition: creativeTransition },
}));
const taskTransition = vi.fn();
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: taskTransition },
}));
const dispatchApprovedTask = vi.fn();
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { dispatchApprovedTask },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn().mockResolvedValue(null),
    resolveCreativeApprovalDecision: vi.fn().mockResolvedValue(undefined),
    resolveApprovalDecisionCard: vi.fn().mockResolvedValue(undefined),
    postSystemMessage: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {},
}));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {},
}));
vi.mock("@/server/notifications/telegram-approval-notifier", () => ({
  sendPublishPromptToTelegram: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/commands/publish-creative", () => ({
  publishCreativeCore: vi.fn(),
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/execution/providers/meta/meta-api-provider", () => ({
  hasActiveMetaAdsAccount: vi.fn(),
}));
vi.mock("@/server/agency/fingerprint", () => ({ taskFingerprint: vi.fn() }));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: vi.fn() },
}));
vi.mock("@/server/reasoning/prompts/meta-campaign-brief", () => ({
  metaCampaignBriefDef: {},
}));

const rememberCreativeReaction = vi.fn();
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { rememberCreativeReaction },
}));

const { applyApprovalDecision } = await import("./approval-decisions");

const approval = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "appr-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    entityType: "Creative",
    entityId: "creative-1",
    taskId: null,
    ...overrides,
  }) as never;

const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

beforeEach(() => {
  vi.clearAllMocks();
  decide.mockResolvedValue(undefined);
  creativeTransition.mockResolvedValue(undefined);
  rememberCreativeReaction.mockResolvedValue(null);
  // Not an Instagram creative: auto-publish is skipped without side effects.
  creativeFindUnique.mockResolvedValue({
    platform: "TIKTOK",
    createdByTaskId: null,
    title: "Autumn sale",
  });
});

describe("applyApprovalDecision: learning from a creative", () => {
  it("remembers an approved creative", async () => {
    await applyApprovalDecision({
      approval: approval(),
      to: "APPROVED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });

    expect(rememberCreativeReaction).toHaveBeenCalledWith({
      scope,
      creativeId: "creative-1",
      outcome: "APPROVED",
    });
  });

  it("remembers a rejected creative", async () => {
    await applyApprovalDecision({
      approval: approval(),
      to: "REJECTED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });

    expect(rememberCreativeReaction).toHaveBeenCalledWith({
      scope,
      creativeId: "creative-1",
      outcome: "REJECTED",
    });
  });

  it("learns after the creative has moved to its new state, not before", async () => {
    const order: string[] = [];
    creativeTransition.mockImplementation(async () => {
      order.push("transition");
    });
    rememberCreativeReaction.mockImplementation(async () => {
      order.push("learn");
      return null;
    });

    await applyApprovalDecision({
      approval: approval(),
      to: "APPROVED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });

    expect(order).toEqual(["transition", "learn"]);
  });

  it("learns nothing from a task approval, and still dispatches the task", async () => {
    await applyApprovalDecision({
      approval: approval({
        entityType: "Task",
        entityId: "task-1",
        taskId: "task-1",
      }),
      to: "APPROVED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });

    expect(rememberCreativeReaction).not.toHaveBeenCalled();
    expect(dispatchApprovedTask).toHaveBeenCalledWith("task-1", "proj-1");
  });

  it("learns nothing from a rejected task either, and cancels it", async () => {
    await applyApprovalDecision({
      approval: approval({
        entityType: "Task",
        entityId: "task-1",
        taskId: "task-1",
      }),
      to: "REJECTED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });

    expect(rememberCreativeReaction).not.toHaveBeenCalled();
    expect(taskTransition).toHaveBeenCalledWith(
      "task-1",
      "proj-1",
      "CANCELLED",
      {
        failureReason: "Rejected by approver",
      },
    );
  });

  it("records the decision itself whatever memory does", async () => {
    await applyApprovalDecision({
      approval: approval(),
      to: "APPROVED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });

    expect(decide).toHaveBeenCalledWith(
      "appr-1",
      "proj-1",
      "APPROVED",
      "user-1",
    );
    expect(creativeTransition).toHaveBeenCalledWith(
      "creative-1",
      "proj-1",
      "APPROVED",
    );
  });
});
