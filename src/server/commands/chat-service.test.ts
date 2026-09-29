import { beforeEach, describe, expect, it, vi } from "vitest";

// Core guarantees this file exists to prove (chat-service.ts had no test
// coverage before docs/brand-workspace-migration.md §7 Phase 5 — this is
// the single most frequently called, most user-visible reasoning call in
// the app): (a) chat context is built from BrandTwin, not ad-hoc queries,
// (b) a stated preference is recorded as a UserDecision without blocking
// the reply, (c) a "genuine fork" gets attached as a question card that
// survives reload, (d) the existing reasoning-failure and limit-notice
// fallback paths still behave exactly as before.

const project = { findUniqueOrThrow: vi.fn() };
const approval = { findMany: vi.fn() };
const command = { findMany: vi.fn() };
const agencyDailyStat = { findFirst: vi.fn() };
const projectSetupState = { findUnique: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { project, approval, command, agencyDailyStat, projectSetupState },
}));

const getBrandTwin = vi.fn();
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin }));

const recordUserDecision = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision,
}));

const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run },
}));

vi.mock("@/server/reasoning/prompts/chat-turn", () => ({ chatTurnDef: {} }));

const submit = vi.fn();
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));

const commandCreate = vi.fn();
const attachParsedIntent = vi.fn().mockResolvedValue(undefined);
const recordReply = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: {
    create: commandCreate,
    attachParsedIntent,
    recordReply,
  },
}));

vi.mock("@/server/commands/limit-notice", () => ({
  limitNoticeFromError: vi.fn().mockReturnValue(null),
  limitNoticeReplyText: vi.fn().mockReturnValue("limited"),
}));

// A "use server" Next.js action — pulls in next-auth -> next/server
// transitively, which breaks under Vitest's plain Node ESM resolution
// (unrelated to the real app, which resolves it fine through Next's own
// bundler). Mocked purely so this suite can load; none of these tests
// exercise the NOT_STARTED conversational-setup-intake branch that calls it.
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn(),
}));

const { ChatService } = await import("./chat-service");

const brandTwin = {
  brandId: "brand-1",
  projectId: "proj-1",
  name: "Acme",
  version: 1,
  confidence: "high" as const,
  identity: "Acme",
  positioning: "Premium",
};

beforeEach(() => {
  vi.clearAllMocks();
  project.findUniqueOrThrow.mockResolvedValue({
    name: "Acme",
    domain: "acme.com",
    status: "ACTIVE",
    language: "en",
    country: "US",
  });
  getBrandTwin.mockResolvedValue(brandTwin);
  approval.findMany.mockResolvedValue([]);
  command.findMany.mockResolvedValue([]);
  agencyDailyStat.findFirst.mockResolvedValue(null);
  // ACTIVE by default (setupPhase gate, chat-service.ts) — matches these
  // tests' assumption of an already-set-up project; the NOT_STARTED
  // conversational-setup-intake branch isn't exercised by this suite.
  projectSetupState.findUnique.mockResolvedValue({
    activatedAt: new Date("2026-01-01T00:00:00Z"),
    stageRecords: [],
  });
  submit.mockResolvedValue({
    status: "UNKNOWN_INTENT",
    commandId: "cmd-1",
  });
});

describe("ChatService.turn — context", () => {
  it("builds chat context from BrandTwin instead of ad-hoc brand queries", async () => {
    run.mockResolvedValue({
      output: { reply: "Hi there.", intentKind: "ANSWER" },
    });

    await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "hello",
    });

    expect(getBrandTwin).toHaveBeenCalledWith("proj-1");
    expect(run).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        brandId: "brand-1",
        context: expect.objectContaining({ brand: brandTwin }),
      }),
    );
  });

  it("history query for the general (single) chat includes every SYSTEM pipeline event project-wide, scoped by topic:null — not idea-less-only", async () => {
    run.mockResolvedValue({
      output: { reply: "Hi there.", intentKind: "ANSWER" },
    });

    await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "hello",
    });

    expect(command.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "proj-1",
          topic: null,
          source: { in: ["WEB", "SYSTEM"] },
        },
      }),
    );
  });

  it("throws when the project has no default brand (BrandTwin is null)", async () => {
    getBrandTwin.mockResolvedValue(null);

    await expect(
      ChatService.turn({
        workspaceId: "ws-1",
        projectId: "proj-1",
        userId: "user-1",
        message: "hello",
      }),
    ).rejects.toThrow(/no default brand/);
  });
});

describe("ChatService.turn — preference capture", () => {
  it("records a stated preference as a UserDecision without blocking the reply", async () => {
    run.mockResolvedValue({
      output: {
        reply: "Got it — going more premium from here.",
        intentKind: "ANSWER",
        preference: {
          type: "CREATIVE_PREFERENCE",
          scope: "BRAND",
          value: "premium_editorial",
        },
      },
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "More premium.",
    });

    expect(recordUserDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        projectId: "proj-1",
        brandId: "brand-1",
        type: "CREATIVE_PREFERENCE",
        scope: "BRAND",
        value: "premium_editorial",
        rawMessage: "More premium.",
        sourceCommandId: "cmd-1",
        createdByUserId: "user-1",
      }),
    );
    expect(result.reply).toContain("premium");
  });

  it("does not call recordUserDecision when no preference is present", async () => {
    run.mockResolvedValue({
      output: { reply: "Sure thing.", intentKind: "ANSWER" },
    });

    await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "Create a post about the new collection.",
    });

    expect(recordUserDecision).not.toHaveBeenCalled();
  });

  it("does not let a recordUserDecision failure break the chat reply", async () => {
    recordUserDecision.mockRejectedValueOnce(new Error("db blip"));
    run.mockResolvedValue({
      output: {
        reply: "Noted.",
        intentKind: "ANSWER",
        preference: { type: "BRAND_RULE", scope: "BRAND", value: "no neon" },
      },
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "Never use neon colors.",
    });

    expect(result.reply).toBe("Noted.");
    expect(result.status).toBeDefined();
  });
});

describe("ChatService.turn — question card", () => {
  it("attaches a question card and returns it when the model presents a genuine fork", async () => {
    const questions = [
      {
        question: "What should we prioritize first?",
        options: [{ label: "Wholesale" }, { label: "Retail" }],
      },
    ];
    run.mockResolvedValue({
      output: {
        reply: "A couple of directions make sense here — which fits best?",
        intentKind: "UNCLEAR",
        questions,
      },
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "Help me plan next month.",
      ideaId: "idea-1",
    });

    expect(attachParsedIntent).toHaveBeenCalledWith(
      "cmd-1",
      {
        card: {
          kind: "question",
          questions,
          projectId: "proj-1",
          ideaId: "idea-1",
        },
      },
      "proj-1",
      "brand-1",
    );
    expect(result.card).toEqual({
      kind: "question",
      questions,
      projectId: "proj-1",
      ideaId: "idea-1",
    });
  });

  it("does not attach a card when no questions are present", async () => {
    run.mockResolvedValue({
      output: { reply: "Here's the plan.", intentKind: "ANSWER" },
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "What's the plan?",
    });

    expect(attachParsedIntent).not.toHaveBeenCalled();
    expect(result.card).toBeUndefined();
  });
});

describe("ChatService.turn — Deep Path (strategic request)", () => {
  it("routes a strategic TASK to STRATEGIC_REQUEST and appends the continuity note to the reply", async () => {
    run.mockResolvedValue({
      output: {
        reply:
          "I'll put together research, positioning and a launch plan for Germany.",
        intentKind: "TASK",
        strategic: true,
        title: "Enter the German market",
        taskBrief: "Research, positioning and a launch plan for Germany.",
        departments: ["MARKET_RESEARCH"],
      },
    });
    submit.mockResolvedValue({
      status: "STRATEGIC_IDEA_CREATED",
      commandId: "cmd-strategic",
      ideaId: "idea-1",
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "let's enter the German market",
    });

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          kind: "STRATEGIC_REQUEST",
          title: "Enter the German market",
          description: "Research, positioning and a launch plan for Germany.",
          departments: ["MARKET_RESEARCH"],
        },
      }),
    );
    expect(result.status).toBe("PLANNED");
    expect(result.reply).toContain("right here");
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-strategic",
      expect.stringContaining("right here"),
      "PLANNED",
    );
    expect(result.card).toBeUndefined();
  });

  it("falls back to the single-task CAPABILITY path when strategic=true but title is missing", async () => {
    run.mockResolvedValue({
      output: {
        reply: "On it.",
        intentKind: "TASK",
        strategic: true,
        capability: "CREATE_COPY",
        taskBrief: "Write a caption.",
      },
    });
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-fast",
      taskId: "task-1",
      dispatched: true,
      requiresApproval: false,
    });

    await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "write me a caption",
    });

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          kind: "CAPABILITY",
          capability: "CREATE_COPY",
          targetPlatform: undefined,
          request: "Write a caption.",
        },
      }),
    );
  });

  it("surfaces IDEA_CAP_REACHED as an ERROR reply with a limit-notice card", async () => {
    run.mockResolvedValue({
      output: {
        reply: "I'll start a dedicated thread for this.",
        intentKind: "TASK",
        strategic: true,
        title: "Another big initiative",
        taskBrief: "…",
      },
    });
    submit.mockResolvedValue({
      status: "IDEA_CAP_REACHED",
      commandId: "cmd-capped",
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "one more big initiative",
    });

    expect(result.status).toBe("ERROR");
    expect(result.reply).toBe("limited");
    expect(result.card).toEqual({
      kind: "limit-notice",
      reason: "active-ideas",
    });
    expect(attachParsedIntent).toHaveBeenCalledWith(
      "cmd-capped",
      { card: { kind: "limit-notice", reason: "active-ideas" } },
      "proj-1",
      "brand-1",
    );
  });

  it("replaces the reply with the real summary and attaches a content-plan-summary card for WEEKLY_PLAN_CREATED", async () => {
    run.mockResolvedValue({
      output: { reply: "Sure, I'll plan your week.", intentKind: "TASK" },
    });
    const weeklyResult = {
      ideasConsidered: 3,
      imagesGenerated: 3,
      imagesFailed: 0,
      scheduled: 3,
      cappedForToday: false,
      pendingReview: 0,
      items: [{ creativeId: "c-1", title: "Idea a" }],
    };
    submit.mockResolvedValue({
      status: "WEEKLY_PLAN_CREATED",
      commandId: "cmd-plan",
      summary: "📅 Weekly content plan: 3/3 created, 3 scheduled.",
      result: weeklyResult,
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "plan this week",
    });

    expect(result.status).toBe("PLANNED");
    expect(result.reply).toBe(
      "📅 Weekly content plan: 3/3 created, 3 scheduled.",
    );
    expect(result.card).toEqual({
      kind: "content-plan-summary",
      ...weeklyResult,
    });
    expect(attachParsedIntent).toHaveBeenCalledWith(
      "cmd-plan",
      { card: { kind: "content-plan-summary", ...weeklyResult } },
      "proj-1",
      "brand-1",
    );
  });
});

describe("ChatService.turn — existing fallback behavior (regression)", () => {
  it("falls back to the rule-based parser and still records the message when reasoning throws", async () => {
    run.mockRejectedValue(new Error("provider exploded"));
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-fallback",
      taskId: "task-1",
      dispatched: true,
      requiresApproval: false,
    });

    const result = await ChatService.turn({
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "user-1",
      message: "make a post",
    });

    expect(result.status).toBe("PLANNED");
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-fallback",
      expect.stringContaining("queued"),
      "PLANNED",
    );
  });
});
