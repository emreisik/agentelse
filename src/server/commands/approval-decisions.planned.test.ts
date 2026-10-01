import { beforeEach, describe, expect, it, vi } from "vitest";

// A piece with a planned time (a content-plan slot) goes out at that time, not
// the moment it is approved. What this suite proves: approving a FUTURE-dated
// Instagram piece never publishes it (whether or not a Publishing schedule
// exists), it stays queued for its time and the chat says so honestly (and
// says when nothing will release it); a piece with no planned time, or one
// whose time has come, behaves exactly as before.

// The publish hold of Works slice 2 is reachable only with the flag on; these
// pins are the legacy behaviour, so the flag is off here (the Work cases live
// in approval-decisions.works.test.ts). Without the mock, reading the flag
// would parse the environment, which a test has none of.
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: () => false }));

const creativeFindUnique = vi.fn();
const scheduleCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: { findUnique: creativeFindUnique },
    task: { findUnique: vi.fn().mockResolvedValue(null) },
    projectSchedule: { count: scheduleCount },
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
// What a task waiting for approval still lacks (null: nothing, it can run).
const missingInputFor = vi.fn();
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { dispatchApprovedTask, missingInputFor },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
const postSystemMessage = vi.fn();
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn().mockResolvedValue(null),
    resolveCreativeApprovalDecision: vi.fn().mockResolvedValue(undefined),
    resolveApprovalDecisionCard: vi.fn().mockResolvedValue(undefined),
    postSystemMessage,
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
const publishCreativeCore = vi.fn();
vi.mock("@/server/commands/publish-creative", () => ({
  publishCreativeCore,
}));
const getPublishTargets = vi.fn();
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets,
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
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn().mockResolvedValue("Europe/Istanbul"),
}));

const { autoPublishCreative, applyApprovalDecision } =
  await import("./approval-decisions");

const input = {
  creativeId: "creative-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
};
const DAY = 24 * 60 * 60_000;

function creative(over: Record<string, unknown> = {}) {
  creativeFindUnique.mockResolvedValue({
    platform: "INSTAGRAM",
    scheduledFor: null,
    createdByTaskId: null,
    title: "Thursday post",
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getPublishTargets.mockResolvedValue([{ platform: "instagram" }]);
  scheduleCount.mockResolvedValue(0);
  publishCreativeCore.mockResolvedValue({
    ok: true,
    message: "ok",
    cardUpdated: true,
  });
  decide.mockResolvedValue(undefined);
  creativeTransition.mockResolvedValue(undefined);
  rememberCreativeReaction.mockResolvedValue(null);
  postSystemMessage.mockResolvedValue(undefined);
});

describe("autoPublishCreative: a planned time", () => {
  it("does not publish a piece whose planned time is still ahead, schedule or not", async () => {
    const plannedFor = new Date(Date.now() + 3 * DAY);
    creative({ scheduledFor: plannedFor });

    scheduleCount.mockResolvedValue(0);
    expect(await autoPublishCreative(input)).toEqual({
      status: "QUEUED",
      message: expect.stringContaining("planned time"),
      plannedFor,
      released: false,
    });

    scheduleCount.mockResolvedValue(1);
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "QUEUED",
      plannedFor,
      released: true,
    });
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  it("publishes right away a piece with no planned time, as before", async () => {
    creative({ scheduledFor: null });
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "PUBLISHED",
    });
    expect(publishCreativeCore).toHaveBeenCalledTimes(1);
  });

  it("publishes a piece whose planned time has come", async () => {
    creative({ scheduledFor: new Date(Date.now() - 60_000) });
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "PUBLISHED",
    });
  });

  it("with a schedule, a due piece still waits for the next slot", async () => {
    creative({ scheduledFor: new Date(Date.now() - 60_000) });
    scheduleCount.mockResolvedValue(1);
    expect(await autoPublishCreative(input)).toEqual({
      status: "QUEUED",
      message: "Waiting for the next scheduled Instagram slot",
    });
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  it("leaves other channels and unconnected accounts to the ask-flow", async () => {
    creative({ platform: "TIKTOK", scheduledFor: new Date(Date.now() + DAY) });
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "SKIPPED",
    });

    creative({ scheduledFor: new Date(Date.now() + DAY) });
    getPublishTargets.mockResolvedValue([]);
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "SKIPPED",
    });
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });
});

describe("applyApprovalDecision: approving a planned piece", () => {
  const approval = {
    id: "appr-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    entityType: "Creative",
    entityId: "creative-1",
    taskId: null,
  } as never;
  const run = () =>
    applyApprovalDecision({
      approval,
      to: "APPROVED",
      reviewedByUserId: "user-1",
      actorType: "USER",
    });

  it("says when it is planned for and that scheduled posting is off", async () => {
    creative({ scheduledFor: new Date("2099-10-08T07:00:00Z") });
    await run();
    expect(publishCreativeCore).not.toHaveBeenCalled();
    const texts = postSystemMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("approved — planned for");
    // In the project's timezone (Istanbul is UTC+3): 07:00Z is 10:00 there.
    expect(texts[0]).toMatch(/Thu,? 8 Oct,? 10:00/);
    expect(texts[0]).toContain(
      "Turn on scheduled posting so it goes out then.",
    );
  });

  it("does not ask to turn anything on when a schedule will release it", async () => {
    scheduleCount.mockResolvedValue(1);
    creative({ scheduledFor: new Date("2099-10-08T07:00:00Z") });
    await run();
    const [text] = postSystemMessage.mock.calls.map((c) => c[0].text as string);
    expect(text).toContain("planned for");
    expect(text).not.toContain("Turn on scheduled posting");
  });
});
