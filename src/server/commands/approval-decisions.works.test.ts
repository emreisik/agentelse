import { beforeEach, describe, expect, it, vi } from "vitest";

// Works publish hold and queue skip (guards W10, W53, hold-fail-closed).
// Flag off: today's behaviour (a null-time approved piece publishes at once,
// the queue is the legacy FIFO). Flag on: a Work-owned piece without a usable
// time is held (never posted just because it was approved), the queue skips
// pieces that cannot publish, legacy pieces keep the old rule.

const creativeFindUnique = vi.fn();
const creativeFindMany = vi.fn();
const creativeUpdateMany = vi.fn();
const taskFindMany = vi.fn();
const scheduleCount = vi.fn();
const approvalFindMany = vi.fn();
const postUpdate = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    creative: {
      findUnique: creativeFindUnique,
      findMany: creativeFindMany,
      updateMany: creativeUpdateMany,
    },
    task: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: taskFindMany,
    },
    projectSchedule: { count: scheduleCount },
    approval: { findMany: approvalFindMany },
    post: { update: postUpdate },
  },
}));

vi.mock("@/server/repositories/approval.repository", () => ({
  ApprovalRepository: { decide: vi.fn() },
}));
vi.mock("@/server/repositories/creative.repository", () => ({
  CreativeRepository: { transition: vi.fn() },
}));
vi.mock("@/server/repositories/task.repository", () => ({
  TaskRepository: { transition: vi.fn() },
}));
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { dispatchApprovedTask: vi.fn(), missingInputFor: vi.fn() },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
const postSystemMessage = vi.fn();
vi.mock("@/server/repositories/idea-chat.repository", () => ({
  IdeaChatRepository: {
    resolveIdeaIdForTask: vi.fn().mockResolvedValue(null),
    resolveCreativeApprovalDecision: vi.fn(),
    resolveApprovalDecisionCard: vi.fn(),
    postSystemMessage,
  },
}));
vi.mock("@/server/repositories/idea.repository", () => ({
  IdeaRepository: {},
}));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {},
}));
const sendPublishPromptToTelegram = vi.fn();
vi.mock("@/server/notifications/telegram-approval-notifier", () => ({
  sendPublishPromptToTelegram,
}));
const publishCreativeCore = vi.fn();
vi.mock("@/server/commands/publish-creative", () => ({ publishCreativeCore }));
const shareCreativeToFacebookCore = vi.fn();
vi.mock("@/server/commands/facebook-share", () => ({
  shareCreativeToFacebookCore,
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
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { rememberCreativeReaction: vi.fn() },
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn().mockResolvedValue("Europe/Istanbul"),
}));

let worksOn = false;
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: () => worksOn }));
const workOwnershipOf = vi.fn();
const ownedPlanIds = vi.fn();
vi.mock("@/server/works/work-owned", () => ({ workOwnershipOf, ownedPlanIds }));

const {
  autoPublishCreative,
  publishNextQueuedInstagramCreative,
  publishRestOfPost,
  applyApprovalDecision,
} = await import("./approval-decisions");

const input = { creativeId: "c1", workspaceId: "ws", projectId: "p1" };
const queueInput = { workspaceId: "ws", projectId: "p1", brandId: "b1" };
const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

// What autoPublishWorkOwned reads for the creative.
function workCreative(over: Record<string, unknown> = {}) {
  creativeFindUnique.mockImplementation(
    async (args: { select?: Record<string, unknown> }) =>
      args.select && "status" in args.select
        ? {
            status: "APPROVED",
            platform: "INSTAGRAM",
            formatKey: "instagram.post",
            scheduledFor: ago(HOUR),
            versions: [{ assetId: "a1" }],
            ...over,
          }
        : { platform: "INSTAGRAM", scheduledFor: null, ...over },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  worksOn = false;
  getPublishTargets.mockResolvedValue([{ platform: "instagram" }]);
  scheduleCount.mockResolvedValue(0);
  publishCreativeCore.mockResolvedValue({ ok: false, message: "stop" });
  workOwnershipOf.mockResolvedValue({ owned: true, workId: "w1" });
  ownedPlanIds.mockResolvedValue(new Set<string>());
  taskFindMany.mockResolvedValue([]);
});

describe("autoPublishCreative: flag off (parity)", () => {
  it("still publishes a null-time approved piece immediately", async () => {
    workCreative({ scheduledFor: null });
    publishCreativeCore.mockResolvedValue({
      ok: true,
      message: "ok",
      cardUpdated: true,
    });
    const result = await autoPublishCreative(input);
    expect(result.status).toBe("PUBLISHED");
    expect(publishCreativeCore).toHaveBeenCalledWith(
      expect.objectContaining({ format: "FEED" }),
    );
    expect(workOwnershipOf).not.toHaveBeenCalled();
  });
});

describe("autoPublishCreative: flag on, Work-owned (W10)", () => {
  beforeEach(() => {
    worksOn = true;
  });

  it.each([
    ["null time, no schedule", null, 0],
    ["null time, schedule exists", null, 1],
    ["stale time, no schedule", ago(25 * HOUR), 0],
    ["stale time, schedule exists", ago(25 * HOUR), 1],
  ])("holds a piece with %s and never posts", async (_l, time, schedules) => {
    workCreative({ scheduledFor: time });
    scheduleCount.mockResolvedValue(schedules);
    const result = await autoPublishCreative(input);
    expect(result).toMatchObject({ status: "QUEUED", held: true });
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  it("queues a due piece (past, within 24 h) when a schedule exists", async () => {
    workCreative({ scheduledFor: ago(2 * HOUR) });
    scheduleCount.mockResolvedValue(1);
    const result = await autoPublishCreative(input);
    expect(result).toEqual({
      status: "QUEUED",
      message: "Waiting for the next scheduled Instagram slot",
    });
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  // The queue refuses a piece whose planned time is more than 24 h old, and
  // the next daily slot (clock times taken from the plan itself) falls just
  // past that limit for a piece approved after its time: the time must move
  // to approval, or the promise "waits for the next slot" is never kept.
  it("moves a due piece's time to approval so the 24 h clock starts there", async () => {
    const planned = ago(2 * HOUR);
    workCreative({ scheduledFor: planned });
    scheduleCount.mockResolvedValue(1);
    const before = Date.now();
    await autoPublishCreative(input);
    expect(creativeUpdateMany).toHaveBeenCalledTimes(1);
    const call = creativeUpdateMany.mock.calls[0]?.[0];
    // Compare-and-set on the time that was judged, never a blind overwrite.
    expect(call.where).toEqual({
      id: input.creativeId,
      scheduledFor: planned,
    });
    expect(call.data.scheduledFor.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("leaves the time alone when the piece is held, future or not due", async () => {
    workCreative({ scheduledFor: ago(2 * HOUR) });
    await autoPublishCreative(input); // no schedule: held
    workCreative({ scheduledFor: ahead(48 * HOUR) });
    scheduleCount.mockResolvedValue(1);
    await autoPublishCreative(input); // future: waits for its own time
    workCreative({ scheduledFor: ago(25 * HOUR) });
    await autoPublishCreative(input); // stale: held
    expect(creativeUpdateMany).not.toHaveBeenCalled();
  });

  it("holds a due piece when no schedule exists", async () => {
    workCreative({ scheduledFor: ago(2 * HOUR) });
    const result = await autoPublishCreative(input);
    expect(result).toMatchObject({ status: "QUEUED", held: true });
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  it("keeps a future time QUEUED with plannedFor and released", async () => {
    const when = ahead(48 * HOUR);
    workCreative({ scheduledFor: when });
    scheduleCount.mockResolvedValue(1);
    const result = await autoPublishCreative(input);
    expect(result).toMatchObject({
      status: "QUEUED",
      plannedFor: when,
      released: true,
    });
    expect(result.held).toBeUndefined();
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  it("skips a manual format (carousel, reel) with the hand-off reason", async () => {
    workCreative({
      formatKey: "instagram.carousel",
      scheduledFor: ahead(HOUR),
    });
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "SKIPPED",
      reason: "MANUAL_FORMAT",
    });
    workCreative({ formatKey: "instagram.reel", scheduledFor: ahead(HOUR) });
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "SKIPPED",
      reason: "MANUAL_FORMAT",
    });
  });

  it("skips another channel's Work piece with the WRONG_PLATFORM reason", async () => {
    workCreative({ platform: "LINKEDIN", scheduledFor: ahead(HOUR) });
    expect(await autoPublishCreative(input)).toMatchObject({
      status: "SKIPPED",
      reason: "WRONG_PLATFORM",
    });
  });

  it("skips a LinkedIn-only connection", async () => {
    getPublishTargets.mockResolvedValue([{ platform: "linkedin" }]);
    workCreative({ scheduledFor: ahead(HOUR) });
    expect((await autoPublishCreative(input)).status).toBe("SKIPPED");
  });

  it("skips a piece with no asset", async () => {
    workCreative({ versions: [], scheduledFor: ahead(HOUR) });
    expect((await autoPublishCreative(input)).status).toBe("SKIPPED");
  });

  it("a missing plan Command is still owned (fail closed): held", async () => {
    workOwnershipOf.mockResolvedValue({ owned: true, workId: null });
    workCreative({ scheduledFor: null });
    const result = await autoPublishCreative(input);
    expect(result).toMatchObject({ status: "QUEUED", held: true });
  });
});

describe("autoPublishCreative: flag on, legacy creative", () => {
  it("keeps the old rule: a null time with no schedule publishes at once", async () => {
    worksOn = true;
    workOwnershipOf.mockResolvedValue({ owned: false, workId: null });
    workCreative({ scheduledFor: null });
    publishCreativeCore.mockResolvedValue({
      ok: true,
      message: "ok",
      cardUpdated: true,
    });
    const result = await autoPublishCreative(input);
    expect(result.status).toBe("PUBLISHED");
    expect(publishCreativeCore).toHaveBeenCalledTimes(1);
  });
});

// A candidate row as the flag-on queue query selects it.
function candidate(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    planId: `plan-${id}`,
    formatKey: "instagram.post",
    scheduledFor: ago(HOUR),
    status: "APPROVED",
    platform: "INSTAGRAM",
    versions: [{ assetId: "a1" }],
    ...over,
  };
}

describe("publish queue: flag off (parity)", () => {
  it("runs the legacy query, takes the first free candidate as FEED", async () => {
    creativeFindMany.mockResolvedValue([{ id: "old" }, { id: "newer" }]);
    await publishNextQueuedInstagramCreative(queueInput);

    expect(ownedPlanIds).not.toHaveBeenCalled();
    expect(creativeFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        platform: "INSTAGRAM",
        status: "APPROVED",
        excludedAt: null,
        OR: [
          { scheduledFor: null },
          { scheduledFor: { lte: expect.any(Date), gte: expect.any(Date) } },
        ],
      },
      orderBy: [
        { scheduledFor: { sort: "asc", nulls: "last" } },
        { updatedAt: "asc" },
      ],
      select: { id: true },
    });
    expect(taskFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        capability: "INSTAGRAM_PUBLISH",
        status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] },
      },
      select: { payload: true },
    });
    expect(publishCreativeCore).toHaveBeenCalledWith(
      expect.objectContaining({ creativeId: "old", format: "FEED" }),
    );
  });
});

describe("publish queue: stale pieces after a worker outage (F0a)", () => {
  it("flag off: the legacy query only releases pieces due in the last 24 h", async () => {
    creativeFindMany.mockResolvedValue([]);
    await publishNextQueuedInstagramCreative(queueInput);
    const where = (creativeFindMany.mock.calls[0]?.[0] as {
      where: { OR: { scheduledFor: { lte?: Date; gte?: Date } | null }[] };
    }).where;
    const window = where.OR[1]?.scheduledFor as { lte: Date; gte: Date };
    expect(window.lte.getTime() - window.gte.getTime()).toBe(24 * 3600 * 1000);
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  it("flag on: a NON-owned legacy candidate more than 24 h past its time is not released", async () => {
    worksOn = true;
    creativeFindMany.mockResolvedValue([
      candidate("legacy-stale", { planId: null, scheduledFor: ago(30 * HOUR) }),
      candidate("legacy-fresh", { planId: null, scheduledFor: ago(HOUR) }),
    ]);
    ownedPlanIds.mockResolvedValue(new Set());
    await publishNextQueuedInstagramCreative(queueInput);
    expect(
      publishCreativeCore.mock.calls.map(
        (call) => (call[0] as { creativeId: string }).creativeId,
      ),
    ).toEqual(["legacy-fresh"]);
  });
});

describe("publish queue: flag on (W53)", () => {
  beforeEach(() => {
    worksOn = true;
  });

  const published = () =>
    publishCreativeCore.mock.calls.map(
      (call) => (call[0] as { creativeId: string }).creativeId,
    );

  it("skips Work-owned candidates that cannot publish and takes the first that can", async () => {
    creativeFindMany.mockResolvedValue([
      candidate("manual", { formatKey: "instagram.reel" }),
      candidate("noasset", { versions: [] }),
      candidate("notime", { scheduledFor: null }),
      candidate("stale", { scheduledFor: ago(30 * HOUR) }),
      candidate("good"),
    ]);
    ownedPlanIds.mockResolvedValue(
      new Set([
        "plan-manual",
        "plan-noasset",
        "plan-notime",
        "plan-stale",
        "plan-good",
      ]),
    );
    await publishNextQueuedInstagramCreative(queueInput);
    expect(published()).toEqual(["good"]);
    expect(ownedPlanIds).toHaveBeenCalledTimes(1);
  });

  it("skips a creative whose publish task failed in the last 24 h", async () => {
    creativeFindMany.mockResolvedValue([candidate("bad"), candidate("good")]);
    ownedPlanIds.mockResolvedValue(new Set(["plan-bad", "plan-good"]));
    taskFindMany.mockResolvedValue([
      { status: "FAILED", payload: { creativeId: "bad" } },
    ]);
    await publishNextQueuedInstagramCreative(queueInput);
    expect(published()).toEqual(["good"]);
  });

  it("still skips a creative whose publish is in flight", async () => {
    creativeFindMany.mockResolvedValue([candidate("busy"), candidate("good")]);
    ownedPlanIds.mockResolvedValue(new Set(["plan-busy", "plan-good"]));
    taskFindMany.mockResolvedValue([
      { status: "RUNNING", payload: { creativeId: "busy" } },
    ]);
    await publishNextQueuedInstagramCreative(queueInput);
    expect(published()).toEqual(["good"]);
  });

  it("releases a NON-owned legacy candidate with a null time oldest-first, as today", async () => {
    creativeFindMany.mockResolvedValue([
      candidate("legacy", {
        planId: null,
        scheduledFor: null,
        formatKey: null,
      }),
      candidate("good"),
    ]);
    ownedPlanIds.mockResolvedValue(new Set(["plan-good"]));
    await publishNextQueuedInstagramCreative(queueInput);
    expect(published()).toEqual(["legacy"]);
    expect(publishCreativeCore).toHaveBeenCalledWith(
      expect.objectContaining({ format: "FEED" }),
    );
  });

  it("a legacy candidate that failed in the last 24 h or has no image does not starve the Work-owned one behind it", async () => {
    creativeFindMany.mockResolvedValue([
      candidate("legacy-failed", { planId: null, scheduledFor: null }),
      candidate("legacy-noasset", {
        planId: null,
        scheduledFor: null,
        versions: [],
      }),
      candidate("good"),
    ]);
    taskFindMany.mockResolvedValue([
      { status: "FAILED", payload: { creativeId: "legacy-failed" } },
    ]);
    ownedPlanIds.mockResolvedValue(new Set(["plan-good"]));
    await publishNextQueuedInstagramCreative(queueInput);
    expect(published()).toEqual(["good"]);
  });

  it("a legacy plan (Command without workId) is released too", async () => {
    creativeFindMany.mockResolvedValue([
      candidate("legacyplan", { scheduledFor: null }),
    ]);
    ownedPlanIds.mockResolvedValue(new Set());
    await publishNextQueuedInstagramCreative(queueInput);
    expect(published()).toEqual(["legacyplan"]);
  });

  it("treats a candidate whose plan Command is missing as owned (skipped when it has no time)", async () => {
    creativeFindMany.mockResolvedValue([
      candidate("orphan", { planId: "gone", scheduledFor: null }),
    ]);
    // ownedPlanIds answers "owned" for a missing row (fail closed).
    ownedPlanIds.mockResolvedValue(new Set(["gone"]));
    await publishNextQueuedInstagramCreative(queueInput);
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });

  it("posts an instagram.story candidate as STORIES", async () => {
    creativeFindMany.mockResolvedValue([
      candidate("story", { formatKey: "instagram.story" }),
    ]);
    ownedPlanIds.mockResolvedValue(new Set(["plan-story"]));
    await publishNextQueuedInstagramCreative(queueInput);
    expect(publishCreativeCore).toHaveBeenCalledWith(
      expect.objectContaining({ creativeId: "story", format: "STORIES" }),
    );
  });

  it("does not publish an owned piece when only LinkedIn is connected", async () => {
    getPublishTargets.mockResolvedValue([{ platform: "linkedin" }]);
    creativeFindMany.mockResolvedValue([candidate("good")]);
    ownedPlanIds.mockResolvedValue(new Set(["plan-good"]));
    await publishNextQueuedInstagramCreative(queueInput);
    expect(publishCreativeCore).not.toHaveBeenCalled();
  });
});

describe("applyApprovalDecision: a Work piece that cannot auto-publish", () => {
  const approval = {
    id: "appr-1",
    workspaceId: "ws",
    projectId: "p1",
    brandId: "b1",
    entityType: "Creative",
    entityId: "c1",
    taskId: null,
  } as never;
  const run = () =>
    applyApprovalDecision({
      approval,
      to: "APPROVED",
      reviewedByUserId: "u1",
      actorType: "USER",
    });
  const texts = () =>
    postSystemMessage.mock.calls.map((c) => c[0].text as string);

  beforeEach(() => {
    worksOn = true;
    postSystemMessage.mockResolvedValue(undefined);
  });

  it.each(["instagram.carousel", "instagram.reel"])(
    "a %s is a hand-off: no publish prompt row and no Telegram prompt",
    async (formatKey) => {
      workCreative({ formatKey, scheduledFor: ahead(HOUR), title: "Hand" });
      await run();
      expect(sendPublishPromptToTelegram).not.toHaveBeenCalled();
      expect(
        postSystemMessage.mock.calls.some((c) => c[0].card !== undefined),
      ).toBe(false);
      expect(texts()).toEqual([
        "✅ Hand approved — you post this one yourself.",
      ]);
    },
  );

  it("another channel's piece gets no Instagram prompt either", async () => {
    workCreative({ platform: "LINKEDIN", title: "Post", scheduledFor: null });
    await run();
    expect(sendPublishPromptToTelegram).not.toHaveBeenCalled();
    expect(
      postSystemMessage.mock.calls.some((c) => c[0].card !== undefined),
    ).toBe(false);
  });

  it("a held piece says it is on hold, not queued for the next slot", async () => {
    workCreative({ scheduledFor: null, title: "Held" });
    await run();
    expect(texts()).toEqual([
      "✅ Held approved — on hold until you set a time or post it now.",
    ]);
  });

  it("a legacy piece with no connection still gets the share prompt", async () => {
    workOwnershipOf.mockResolvedValue({ owned: false, workId: null });
    getPublishTargets.mockResolvedValue([]);
    workCreative({ title: "Legacy", scheduledFor: null });
    await run();
    expect(sendPublishPromptToTelegram).toHaveBeenCalledTimes(1);
    expect(
      postSystemMessage.mock.calls.some(
        (c) => c[0].card?.kind === "publish-prompt",
      ),
    ).toBe(true);
  });
});

describe("one approve per post (docs/works.md Posts)", () => {
  const approval = (id: string, entityId: string) =>
    ({
      id,
      workspaceId: "ws",
      projectId: "p1",
      brandId: "b1",
      taskId: null,
      entityType: "Creative",
      entityId,
      type: "CREATIVE_APPROVAL",
      status: "PENDING",
    }) as unknown as Parameters<typeof applyApprovalDecision>[0]["approval"];

  beforeEach(async () => {
    workCreative({ scheduledFor: null });
    const base = creativeFindUnique.getMockImplementation()!;
    creativeFindUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) =>
        args.select && "postId" in args.select
          ? { postId: "post-1" }
          : base(args),
    );
    creativeFindMany.mockResolvedValue([{ id: "c2" }]);
    approvalFindMany.mockResolvedValue([approval("ap2", "c2")]);
    postUpdate.mockResolvedValue({});
  });

  it("approves the post's other waiting channels and records the post", async () => {
    const { ApprovalRepository } = await import(
      "@/server/repositories/approval.repository"
    );
    await applyApprovalDecision({
      approval: approval("ap1", "c1"),
      to: "APPROVED",
      reviewedByUserId: "u1",
      actorType: "USER",
    });

    expect(vi.mocked(ApprovalRepository.decide).mock.calls.map((c) => c[0])).toEqual([
      "ap1",
      "ap2",
    ]);
    // Never an excluded channel, never the one just approved.
    expect(creativeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          postId: "post-1",
          id: { not: "c1" },
          excludedAt: null,
        }),
      }),
    );
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "post-1" },
        data: expect.objectContaining({ approvedByUserId: "u1" }),
      }),
    );
  });

  it("keeps a rejection with its own delivery", async () => {
    const { ApprovalRepository } = await import(
      "@/server/repositories/approval.repository"
    );
    await applyApprovalDecision({
      approval: approval("ap1", "c1"),
      to: "REJECTED",
      reviewedByUserId: "u1",
      actorType: "USER",
    });
    expect(ApprovalRepository.decide).toHaveBeenCalledTimes(1);
    expect(approvalFindMany).not.toHaveBeenCalled();
    expect(postUpdate).not.toHaveBeenCalled();
  });
});

describe("a post goes out together", () => {
  it("posts the post's due Story and Facebook version, never a hand-posted format", async () => {
    creativeFindUnique.mockResolvedValue({ postId: "post-1" });
    creativeFindMany.mockResolvedValue([
      { id: "story", channel: "instagram", platform: "INSTAGRAM", formatKey: "instagram.story" },
      { id: "fb", channel: "facebook", platform: "FACEBOOK", formatKey: "facebook.post" },
      { id: "reel", channel: "instagram", platform: "INSTAGRAM", formatKey: "instagram.reel" },
    ]);
    publishCreativeCore.mockResolvedValue({ ok: true, message: "ok" });
    shareCreativeToFacebookCore.mockResolvedValue({ ok: true, message: "ok" });

    await publishRestOfPost({ creativeId: "post", workspaceId: "ws", projectId: "p1" });

    expect(creativeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          postId: "post-1",
          excludedAt: null,
          status: "APPROVED",
        }),
      }),
    );
    expect(publishCreativeCore).toHaveBeenCalledTimes(1);
    expect(publishCreativeCore).toHaveBeenCalledWith(
      expect.objectContaining({ creativeId: "story", format: "STORIES" }),
    );
    expect(shareCreativeToFacebookCore).toHaveBeenCalledWith(
      expect.objectContaining({ creativeId: "fb" }),
    );
  });

  it("does nothing for a piece that is not part of a post", async () => {
    creativeFindUnique.mockResolvedValue({ postId: null });
    await publishRestOfPost({ creativeId: "solo", workspaceId: "ws", projectId: "p1" });
    expect(creativeFindMany).not.toHaveBeenCalled();
  });
});
