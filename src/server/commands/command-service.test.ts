import { beforeEach, describe, expect, it, vi } from "vitest";

// The core guarantee this file exists to prove: the "revize et" chat intent
// used to be a dead end — ApprovalRepository.decide(..., "REVISION_REQUESTED")
// was recorded and nothing else ever happened (REVISION_REQUESTED's only
// legal transition is -> CANCELLED). CommandService.submit's APPROVAL_DECISION
// REVISE branch must now actually act: regenerate a Creative directly, or
// cancel+recreate a non-creative Task with the feedback folded in.

const commandCreate = vi.fn().mockResolvedValue({ id: "cmd-1" });
const attachParsedIntent = vi.fn().mockResolvedValue(undefined);
const attachIdeaId = vi.fn().mockResolvedValue(undefined);
const attachKeepingCard = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: {
    create: commandCreate,
    attachParsedIntent,
    attachParsedIntentKeepingCard: attachKeepingCard,
    attachIdeaId,
  },
}));

const createStrategicIdea = vi.fn();
vi.mock("@/server/commands/strategic-request", () => ({
  createStrategicIdea,
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
const dispatchApprovedTask = vi.fn();
// What a task waiting for approval still lacks (null: nothing, it can run).
const missingInputFor = vi.fn().mockResolvedValue(null);
vi.mock("@/server/commands/task-planner", () => ({
  TaskPlanner: { planForCapability, dispatchApprovedTask, missingInputFor },
}));

const performCreativeRevision = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/server/actions/creative-actions", () => ({
  performCreativeRevision,
}));

const approvalFindMany = vi.fn();
const taskFindUnique = vi.fn();
const brandFindFirst = vi.fn().mockResolvedValue({ id: "brand-1" });
const commandFindUnique = vi.fn();
const commandFindMany = vi.fn();
const taskFindMany = vi.fn();
const creativeFindMany = vi.fn();
let worksOn = false;
vi.mock("@/server/works/flag", () => ({ isWorksEnabled: () => worksOn }));
const projectScheduleFindFirst = vi.fn().mockResolvedValue(null);
// Gate in CommandService.submit (command-service.ts): every user-triggered
// call goes through ensureProjectActive, which activates a project that never
// ran setup and reports a paused/closed one as unusable. Default to usable so
// existing tests keep exercising their actual capability logic instead of
// short-circuiting on PROJECT_INACTIVE.
const ensureProjectActive = vi.fn();
vi.mock("@/server/projects/activation", () => ({ ensureProjectActive }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    approval: { findMany: approvalFindMany },
    task: { findUnique: taskFindUnique, findMany: taskFindMany },
    command: { findUnique: commandFindUnique, findMany: commandFindMany },
    creative: { findMany: creativeFindMany },
    brand: { findFirst: brandFindFirst },
    projectSchedule: { findFirst: projectScheduleFindFirst },
  },
}));

const rememberCreativeReaction = vi.fn();
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { rememberCreativeReaction },
}));

const planWeeklyInstagramContent = vi.fn();
vi.mock("@/server/agency/content/instagram-week-planner", () => ({
  planWeeklyInstagramContent,
  weeklyPlanConfigFromSchedule: (config: Record<string, unknown>) => ({
    dailyImageCap:
      typeof config.dailyImageCap === "number" ? config.dailyImageCap : 3,
    lensMix:
      config.lensMix && typeof config.lensMix === "object"
        ? config.lensMix
        : undefined,
  }),
  summarizeWeeklyPlanResult: (result: { imagesGenerated: number }) =>
    `summary: ${result.imagesGenerated} created`,
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
  worksOn = false;
  commandCreate.mockResolvedValue({ id: "cmd-1" });
  approvalDecide.mockResolvedValue(undefined);
  attachParsedIntent.mockResolvedValue(undefined);
  attachIdeaId.mockResolvedValue(undefined);
  brandFindFirst.mockResolvedValue({ id: "brand-1" });
  projectScheduleFindFirst.mockResolvedValue(null);
  ensureProjectActive.mockResolvedValue({ status: "ACTIVE", usable: true });
  rememberCreativeReaction.mockResolvedValue(null);
  missingInputFor.mockResolvedValue(null);
  planWeeklyInstagramContent.mockResolvedValue({
    ideasConsidered: 2,
    imagesGenerated: 2,
    imagesFailed: 0,
    scheduled: 2,
    cappedForToday: false,
    pendingReview: 0,
    items: [],
  });
});

describe("CommandService.submit — project gate", () => {
  const capabilityInput = {
    workspaceId: "ws-1",
    source: "WEB" as const,
    rawText: "write some copy",
    actorType: "USER" as const,
    userId: "user-1",
    knownProjectId: "proj-1",
    intent: {
      kind: "CAPABILITY" as const,
      capability: "CREATE_COPY" as const,
      request: "write some copy",
    },
  };

  it("refuses work on a paused or closed project and creates nothing", async () => {
    ensureProjectActive.mockResolvedValue({ status: "PAUSED", usable: false });

    const result = await CommandService.submit(capabilityInput);

    expect(result).toEqual({ status: "PROJECT_INACTIVE", commandId: "cmd-1" });
    expect(planForCapability).not.toHaveBeenCalled();
    expect(attachParsedIntent).not.toHaveBeenCalled();
  });

  it("does not ask a project that never ran setup to finish it first", async () => {
    // ensureProjectActive is what moves a CREATED/DISCOVERY project to ACTIVE;
    // here it has done so, and the work goes ahead.
    ensureProjectActive.mockResolvedValue({ status: "ACTIVE", usable: true });

    const result = await CommandService.submit(capabilityInput);

    expect(ensureProjectActive).toHaveBeenCalledWith("proj-1");
    expect(result.status).not.toBe("PROJECT_INACTIVE");
    expect(planForCapability).toHaveBeenCalled();
  });
});

describe("CommandService.submit — learning from creative decisions", () => {
  const creativeApproval = {
    id: "appr-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    taskId: null,
    entityType: "Creative",
    entityId: "creative-1",
  };
  const decide = (
    decision: "APPROVE" | "REJECT" | "REVISE",
    note?: string,
  ) => ({
    ...baseInput(""),
    rawText: decision,
    intent: { kind: "APPROVAL_DECISION" as const, decision, note },
  });
  const scope = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

  beforeEach(() => {
    approvalFindMany.mockResolvedValue([creativeApproval]);
  });

  it("remembers an approved creative as a reaction of the client's", async () => {
    await CommandService.submit(decide("APPROVE"));

    expect(rememberCreativeReaction).toHaveBeenCalledWith({
      scope,
      creativeId: "creative-1",
      outcome: "APPROVED",
      note: undefined,
    });
  });

  it("remembers a rejected creative", async () => {
    await CommandService.submit(decide("REJECT"));

    expect(rememberCreativeReaction).toHaveBeenCalledWith({
      scope,
      creativeId: "creative-1",
      outcome: "REJECTED",
      note: undefined,
    });
  });

  it("remembers what the client asked to change, with their words", async () => {
    await CommandService.submit(decide("REVISE", "less busy background"));

    expect(rememberCreativeReaction).toHaveBeenCalledWith({
      scope,
      creativeId: "creative-1",
      outcome: "REVISION_REQUESTED",
      note: "less busy background",
    });
  });

  it("records the decision first, so learning can never stand in its way", async () => {
    const order: string[] = [];
    approvalDecide.mockImplementation(async () => {
      order.push("decide");
    });
    rememberCreativeReaction.mockImplementation(async () => {
      order.push("learn");
      return null;
    });

    await CommandService.submit(decide("APPROVE"));

    expect(order).toEqual(["decide", "learn"]);
  });

  it.each(["APPROVE", "REJECT", "REVISE"] as const)(
    "learns nothing from a %s on something that is not a creative",
    async (kind) => {
      approvalFindMany.mockResolvedValue([
        { ...creativeApproval, entityType: "Task", entityId: "task-9", taskId: "task-9" },
      ]);
      taskFindUnique.mockResolvedValue({ status: "COMPLETED" });

      await CommandService.submit(decide(kind, "note"));

      expect(rememberCreativeReaction).not.toHaveBeenCalled();
    },
  );
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

// Deep Path bridge (docs/brand-workspace-migration.md §7 Phase 8): a
// STRATEGIC_REQUEST intent (chat-turn.ts's `strategic: true`) must create
// an Idea via strategic-request.ts and retroactively link the Command to
// it, instead of going through TaskPlanner.planForCapability like a normal
// CAPABILITY intent does.
function strategicInput() {
  return {
    workspaceId: "ws-1",
    source: "WEB" as const,
    rawText: "let's enter the German market",
    actorType: "USER" as const,
    userId: "user-1",
    knownProjectId: "proj-1",
    intent: {
      kind: "STRATEGIC_REQUEST" as const,
      title: "Enter the German market",
      description: "Research, positioning and a launch plan for Germany.",
      departments: ["MARKET_RESEARCH"] as never,
    },
  };
}

describe("CommandService.submit — STRATEGIC_REQUEST", () => {
  it("creates the idea, links the command to it, and returns STRATEGIC_IDEA_CREATED", async () => {
    createStrategicIdea.mockResolvedValue({
      status: "CREATED",
      ideaId: "idea-1",
    });

    const result = await CommandService.submit(strategicInput());

    expect(createStrategicIdea).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
      {
        title: "Enter the German market",
        description: "Research, positioning and a launch plan for Germany.",
        departments: ["MARKET_RESEARCH"],
      },
    );
    expect(attachParsedIntent).toHaveBeenCalledWith(
      "cmd-1",
      expect.objectContaining({ kind: "STRATEGIC_REQUEST" }),
      "proj-1",
      "brand-1",
    );
    expect(attachIdeaId).toHaveBeenCalledWith("cmd-1", "idea-1");
    expect(result).toEqual({
      status: "STRATEGIC_IDEA_CREATED",
      commandId: "cmd-1",
      ideaId: "idea-1",
    });
  });

  it("Works: a streaming turn keeps a card it already stored (no plain overwrite)", async () => {
    worksOn = true;
    createStrategicIdea.mockResolvedValue({ status: "CREATED", ideaId: "idea-1" });
    await CommandService.submit({ ...strategicInput(), existingCommandId: "cmd-turn" });
    expect(attachKeepingCard).toHaveBeenCalledWith(
      "cmd-turn",
      expect.objectContaining({ kind: "STRATEGIC_REQUEST" }),
      "proj-1",
      "brand-1",
    );
    expect(attachParsedIntent).not.toHaveBeenCalled();
  });

  it("flag off: the plain overwrite is used, as before", async () => {
    createStrategicIdea.mockResolvedValue({ status: "CREATED", ideaId: "idea-1" });
    await CommandService.submit({ ...strategicInput(), existingCommandId: "cmd-turn" });
    expect(attachParsedIntent).toHaveBeenCalledTimes(1);
    expect(attachKeepingCard).not.toHaveBeenCalled();
  });

  it("returns IDEA_CAP_REACHED without linking the command when the project is at its idea cap", async () => {
    createStrategicIdea.mockResolvedValue({ status: "CAPPED" });

    const result = await CommandService.submit(strategicInput());

    expect(result).toEqual({
      status: "IDEA_CAP_REACHED",
      commandId: "cmd-1",
    });
    expect(attachIdeaId).not.toHaveBeenCalled();
  });
});

// Single-chat consolidation, batch-planner bridge
// (docs/brand-workspace-migration.md §7 Faz 4): "Plan this week" typed in
// chat used to just produce a generic text answer — CREATE_CONTENT_PLAN
// now runs the SAME autonomous batch planner the cron path uses.
function contentPlanInput(overrides: { ideaId?: string } = {}) {
  return {
    workspaceId: "ws-1",
    source: "WEB" as const,
    rawText: "plan this week",
    actorType: "USER" as const,
    userId: "user-1",
    knownProjectId: "proj-1",
    ideaId: overrides.ideaId,
    intent: {
      kind: "CAPABILITY" as const,
      capability: "CREATE_CONTENT_PLAN" as const,
      request: "plan this week",
    },
  };
}

describe("CommandService.submit — CREATE_CONTENT_PLAN (chat-triggered weekly batch)", () => {
  it("runs the real weekly planner and returns WEEKLY_PLAN_CREATED with its summary, for the general chat (no ideaId)", async () => {
    const result = await CommandService.submit(contentPlanInput());

    expect(planWeeklyInstagramContent).toHaveBeenCalledWith(
      { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
      3,
      { lensMix: undefined, skipSummaryMessage: true },
    );
    expect(result).toEqual({
      status: "WEEKLY_PLAN_CREATED",
      commandId: "cmd-1",
      summary: "summary: 2 created",
      result: {
        ideasConsidered: 2,
        imagesGenerated: 2,
        imagesFailed: 0,
        scheduled: 2,
        cappedForToday: false,
        pendingReview: 0,
        items: [],
      },
    });
    expect(planForCapability).not.toHaveBeenCalled();
  });

  it("reads dailyImageCap/lensMix from an existing CREATE_CONTENT_PLAN schedule when one is configured", async () => {
    projectScheduleFindFirst.mockResolvedValue({
      configuration: { dailyImageCap: 5, lensMix: { PRODUCT: 3 } },
    });

    await CommandService.submit(contentPlanInput());

    expect(planWeeklyInstagramContent).toHaveBeenCalledWith(
      expect.anything(),
      5,
      { lensMix: { PRODUCT: 3 }, skipSummaryMessage: true },
    );
  });

  it("does not hijack an idea's own content-plan request — falls through to the normal capability path", async () => {
    commandCreate.mockResolvedValueOnce({ id: "cmd-1", ideaId: "idea-9" });

    await CommandService.submit(contentPlanInput({ ideaId: "idea-9" }));

    expect(planWeeklyInstagramContent).not.toHaveBeenCalled();
    expect(planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "CREATE_CONTENT_PLAN" }),
    );
  });
});

// A capability that needs an input free text does not carry (a new social
// account needs the platform to open it on) is asked for BEFORE any Task or
// Approval exists. It used to be created, parked behind an approval, and only
// found unrunnable by the router after the client had clicked Approve.
describe("CommandService.submit — inputs a capability cannot run without", () => {
  const accountSetup = (
    overrides: {
      targetPlatform?: "INSTAGRAM" | "TIKTOK" | "FACEBOOK";
      payloadExtra?: Record<string, unknown>;
    } = {},
  ) => ({
    workspaceId: "ws-1",
    source: "WEB" as const,
    rawText: "set up an account",
    actorType: "USER" as const,
    userId: "user-1",
    knownProjectId: "proj-1",
    payloadExtra: overrides.payloadExtra,
    intent: {
      kind: "CAPABILITY" as const,
      capability: "SOCIAL_ACCOUNT_SETUP" as const,
      targetPlatform: overrides.targetPlatform,
      request: "set up an account",
    },
  });

  it("asks for the platform and creates nothing when there is none", async () => {
    const result = await CommandService.submit(accountSetup());

    expect(result).toMatchObject({
      status: "NEEDS_INPUT",
      commandId: "cmd-1",
      field: "platform",
      problem: "missing",
      allowed: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
    });
    expect(result).not.toHaveProperty("approvalId");
    expect(planForCapability).not.toHaveBeenCalled();
  });

  it("asks again when the platform is one an account cannot be set up on", async () => {
    const result = await CommandService.submit(
      accountSetup({ targetPlatform: "FACEBOOK" }),
    );

    expect(result).toMatchObject({
      status: "NEEDS_INPUT",
      problem: "unsupported",
      got: "FACEBOOK",
    });
    expect(planForCapability).not.toHaveBeenCalled();
  });

  it("plans it when the platform is given", async () => {
    const result = await CommandService.submit(
      accountSetup({ targetPlatform: "INSTAGRAM" }),
    );

    expect(result.status).toBe("PLANNED");
    expect(planForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "SOCIAL_ACCOUNT_SETUP",
        targetPlatform: "INSTAGRAM",
      }),
    );
  });

  it("takes the platform from the explicit payload the way the task will", async () => {
    // payloadExtra wins over the intent in the task payload, so it must here.
    const fromPayload = await CommandService.submit(
      accountSetup({ payloadExtra: { platform: "TIKTOK" } }),
    );
    expect(fromPayload.status).toBe("PLANNED");

    const overridden = await CommandService.submit(
      accountSetup({
        targetPlatform: "INSTAGRAM",
        payloadExtra: { platform: "FACEBOOK" },
      }),
    );
    expect(overridden).toMatchObject({
      status: "NEEDS_INPUT",
      problem: "unsupported",
      got: "FACEBOOK",
    });
  });

  it("leaves every other capability alone", async () => {
    const result = await CommandService.submit({
      ...accountSetup(),
      intent: {
        kind: "CAPABILITY" as const,
        capability: "CREATE_COPY" as const,
        request: "write some copy",
      },
    });

    expect(result.status).toBe("PLANNED");
  });

  it("checks after the project gate, so an on-hold project is still just on hold", async () => {
    ensureProjectActive.mockResolvedValue({ status: "PAUSED", usable: false });

    const result = await CommandService.submit(accountSetup());

    expect(result.status).toBe("PROJECT_INACTIVE");
  });

  describe("approving in chat a task that cannot run", () => {
    const taskApproval = {
      id: "appr-9",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      taskId: "task-9",
      entityType: "Task",
      entityId: "task-9",
    };
    const approve = () => ({
      ...baseInput(""),
      rawText: "onayla",
      intent: { kind: "APPROVAL_DECISION" as const, decision: "APPROVE" as const },
    });

    beforeEach(() => {
      approvalFindMany.mockResolvedValue([taskApproval]);
    });

    it("does not consume the approval, and says what is missing", async () => {
      missingInputFor.mockResolvedValue({
        field: "platform",
        problem: "missing",
        allowed: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
      });

      const result = await CommandService.submit(approve());

      expect(result).toMatchObject({
        status: "NEEDS_INPUT",
        approvalId: "appr-9",
        problem: "missing",
      });
      expect(approvalDecide).not.toHaveBeenCalled();
      expect(dispatchApprovedTask).not.toHaveBeenCalled();
    });

    it("approves and dispatches as before when nothing is missing", async () => {
      const result = await CommandService.submit(approve());

      expect(result.status).toBe("APPROVAL_HANDLED");
      expect(missingInputFor).toHaveBeenCalledWith("task-9", "proj-1");
      expect(approvalDecide).toHaveBeenCalled();
      expect(dispatchApprovedTask).toHaveBeenCalledWith("task-9", "proj-1");
    });

    it("still lets the client reject it", async () => {
      missingInputFor.mockResolvedValue({
        field: "platform",
        problem: "missing",
        allowed: ["INSTAGRAM", "TIKTOK", "LINKEDIN"],
      });

      const result = await CommandService.submit({
        ...approve(),
        intent: { kind: "APPROVAL_DECISION" as const, decision: "REJECT" as const },
      });

      expect(result.status).toBe("APPROVAL_HANDLED");
      expect(approvalDecide).toHaveBeenCalled();
    });
  });

  // SC-F8 ve GA-F7: kritik değişiklik onayı sohbet kısayoluyla kör verilmez.
  describe("a critical change approval", () => {
    const criticalApproval = {
      id: "appr-c1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      taskId: "task-c1",
      entityType: "Task",
      entityId: "task-c1",
      type: "CRITICAL_CHANGE_APPROVAL",
      level: "LEVEL_3_CLIENT",
    };
    const decide = (decision: "APPROVE" | "REJECT") => ({
      ...baseInput(""),
      rawText: decision === "APPROVE" ? "onayla" : "reddet",
      intent: { kind: "APPROVAL_DECISION" as const, decision },
    });

    beforeEach(() => {
      approvalFindMany.mockResolvedValue([criticalApproval]);
    });

    it("is sent to the approval card instead of being approved by a plain yes", async () => {
      const result = await CommandService.submit(decide("APPROVE"));

      expect(result).toMatchObject({
        status: "APPROVAL_ON_CARD",
        approvalId: "appr-c1",
      });
      expect(approvalDecide).not.toHaveBeenCalled();
      expect(dispatchApprovedTask).not.toHaveBeenCalled();
    });

    it("can still be rejected in chat", async () => {
      const result = await CommandService.submit(decide("REJECT"));

      expect(result.status).toBe("APPROVAL_HANDLED");
      expect(approvalDecide).toHaveBeenCalled();
    });

    it("leaves an ordinary approval unchanged", async () => {
      approvalFindMany.mockResolvedValue([
        { ...criticalApproval, type: "PUBLISH_APPROVAL" },
      ]);

      const result = await CommandService.submit(decide("APPROVE"));

      expect(result.status).toBe("APPROVAL_HANDLED");
      expect(approvalDecide).toHaveBeenCalled();
    });
  });
});

describe("CommandService.submit — an approval decision inside a Work", () => {
  const approve = {
    ...baseInput(""),
    rawText: "yes approve it",
    existingCommandId: "cmd-turn",
    intent: { kind: "APPROVAL_DECISION" as const, decision: "APPROVE" as const },
  };
  const row = (over: Record<string, unknown>) => ({
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    entityType: "Task",
    entityId: "x",
    taskId: null,
    ...over,
  });
  // Newest first, as the query returns them: a Task approval of ANOTHER Work,
  // then a Creative approval of THIS Work.
  const otherWorkTask = row({ id: "appr-other", taskId: "task-other" });
  const thisWorkCreative = row({
    id: "appr-mine",
    entityType: "Creative",
    entityId: "cr-1",
  });

  beforeEach(() => {
    worksOn = true;
    commandFindUnique.mockResolvedValue({ workId: "w1" });
    approvalFindMany.mockResolvedValue([otherWorkTask, thisWorkCreative]);
    taskFindMany.mockResolvedValue([]);
    creativeFindMany.mockResolvedValue([{ id: "cr-1", planId: "plan-1" }]);
    commandFindMany.mockResolvedValue([{ id: "plan-1" }]);
  });

  it("decides this Work's approval, not the newest one of the project", async () => {
    const result = await CommandService.submit(approve);
    expect(result.status).toBe("APPROVAL_HANDLED");
    expect(approvalDecide).toHaveBeenCalledTimes(1);
    expect(approvalDecide.mock.calls[0]![0]).toBe("appr-mine");
    expect(dispatchApprovedTask).not.toHaveBeenCalled();
    expect(taskFindMany.mock.calls[0]![0]).toMatchObject({
      where: { command: { workId: "w1" } },
    });
  });

  it("finds nothing to decide when only other Works have approvals waiting", async () => {
    approvalFindMany.mockResolvedValue([otherWorkTask]);
    const result = await CommandService.submit(approve);
    expect(result.status).toBe("UNKNOWN_INTENT");
    expect(approvalDecide).not.toHaveBeenCalled();
    expect(dispatchApprovedTask).not.toHaveBeenCalled();
  });

  it("a legacy piece (plan Command without this Work) is not decided from a Work", async () => {
    approvalFindMany.mockResolvedValue([thisWorkCreative]);
    commandFindMany.mockResolvedValue([]);
    expect((await CommandService.submit(approve)).status).toBe(
      "UNKNOWN_INTENT",
    );
    expect(approvalDecide).not.toHaveBeenCalled();
  });

  it("outside a Work (no workId) keeps the project-wide newest approval", async () => {
    commandFindUnique.mockResolvedValue({ workId: null });
    approvalFindMany.mockResolvedValue([otherWorkTask, thisWorkCreative]);
    await CommandService.submit(approve);
    expect(approvalDecide.mock.calls[0]![0]).toBe("appr-other");
    expect(taskFindMany).not.toHaveBeenCalled();
  });

  it("flag off: no Command read, project-wide behaviour unchanged", async () => {
    worksOn = false;
    approvalFindMany.mockResolvedValue([otherWorkTask, thisWorkCreative]);
    await CommandService.submit(approve);
    expect(commandFindUnique).not.toHaveBeenCalled();
    expect(approvalDecide.mock.calls[0]![0]).toBe("appr-other");
  });
});
