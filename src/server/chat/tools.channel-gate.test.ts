import { beforeEach, describe, expect, it, vi } from "vitest";

// The Work channel gate in the tools: nothing channel-bound is planned or
// produced before the Work has a channel, and the Work's channels decide the
// platform. DB-less: every collaborator is mocked.

vi.mock("@/lib/prisma", () => ({
  prisma: { projectSchedule: { findFirst: async () => null } },
}));
vi.mock("@/server/agency/journey/continuation", () => ({
  loadPlanContinuation: vi.fn().mockResolvedValue(null),
}));
const getChannelConnections = vi.hoisted(() => vi.fn());
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections,
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn(),
}));
const getBrandTwin = vi.hoisted(() => vi.fn());
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin }));
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision: vi.fn(),
}));
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn(),
}));
const submit = vi.hoisted(() => vi.fn());
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea: vi.fn() }));
// A Work now routes copy and pictures through slot-first (S2-28).
const slotFirstText = vi.hoisted(() => vi.fn());
const slotFirstImage = vi.hoisted(() => vi.fn());
vi.mock("./slot-first", () => ({ slotFirstText, slotFirstImage }));
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { remember: vi.fn() },
}));
vi.mock("@/server/work-session/work-session-service", () => ({
  WorkSessionService: { start: vi.fn(), update: vi.fn() },
}));

const { toolsForPhase } = await import("./tools");

// The Works list first (it carries the Works-only tools), then the default one.
const tool = (name: string) =>
  (toolsForPhase("ACTIVE", { works: true }).find((t) => t.name === name) ??
    toolsForPhase("ACTIVE").find((t) => t.name === name))!;

type Ctx = Parameters<ReturnType<typeof tool>["execute"]>[1];
const work = (channels: string[] = []) =>
  ({
    id: "work-1",
    title: "New Work",
    summary: null,
    status: "ACTIVE",
    channels,
    acknowledgedUnconnected: [],
    lastActivityAt: "2026-10-01T10:00:00.000Z",
  }) as never;
const ctx = (overrides: Partial<Ctx> = {}): Ctx => ({
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-1",
  message: "Plan the week",
  phase: "ACTIVE",
  emit: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  getBrandTwin.mockResolvedValue(null);
  getChannelConnections.mockResolvedValue({
    instagram: { connected: true, accountLabel: "@clinic" },
  });
});

const GATED: [string, unknown][] = [
  ["start_plan_brief", {}],
  [
    "propose_content_plan",
    { title: "Plan", items: [] },
  ],
  ["propose_content_package", { items: [] }],
  ["propose_plan_options", { title: "t", reason: "r", options: [] }],
  ["propose_ideas", { title: "t", ideas: [], includeBacklog: true }],
  [
    "generate_image",
    { imagePrompt: "a clinic", caption: "c", copy: "c", contentFormat: "FEED_PORTRAIT" },
  ],
  ["create_task", { capability: "CREATE_COPY", taskBrief: "write copy" }],
];

describe("a Work without a channel", () => {
  it.each(GATED)("%s returns the channel question and does nothing else", async (name, args) => {
    const out = await tool(name).execute(args as never, ctx({ work: work([]) }));
    expect(out).toMatchObject({
      status: "ANSWERED",
      card: { kind: "channel-select", workId: "work-1", projectId: "proj-1" },
      result: { outcome: "channel_question_shown" },
    });
    expect(submit).not.toHaveBeenCalled();
    const card = (out as { card: { options: { key: string; connected: boolean }[] } }).card;
    expect(card.options.find((o) => o.key === "instagram")?.connected).toBe(true);
    expect(card.options.find((o) => o.key === "tiktok")?.connected).toBe(false);
  });

  it("research is not channel-bound and still runs", async () => {
    submit.mockResolvedValue({ status: "PLANNED", commandId: "cmd-1", taskId: "t1", dispatched: false, requiresApproval: false });
    await tool("create_task").execute(
      { capability: "MARKET_RESEARCH", taskBrief: "market" } as never,
      ctx({ work: work([]) }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("no Work (Works off) keeps the old behaviour", () => {
  it("start_plan_brief opens the wizard", async () => {
    const out = await tool("start_plan_brief").execute({} as never, ctx());
    expect(out).toMatchObject({ card: { kind: "plan-brief" } });
  });
});

describe("a Work with channels", () => {
  it("opens the gate and defaults the platform to the Work's (slot-first, no submit)", async () => {
    slotFirstText.mockResolvedValue({ result: { outcome: "slot_planned" } });
    await tool("create_task").execute(
      { capability: "CREATE_COPY", taskBrief: "caption" } as never,
      ctx({ work: work(["linkedin"]) }),
    );
    expect(slotFirstText).toHaveBeenCalledTimes(1);
    expect(slotFirstText.mock.calls[0]?.[0]).toEqual({
      capability: "CREATE_COPY",
      taskBrief: "caption",
      platform: "LINKEDIN",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("without a Work the same call still goes through CommandService.submit", async () => {
    submit.mockResolvedValue({ status: "PLANNED", commandId: "cmd-1", taskId: "t1", dispatched: false, requiresApproval: true });
    await tool("create_task").execute(
      { capability: "CREATE_COPY", taskBrief: "caption" } as never,
      ctx(),
    );
    expect(slotFirstText).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("the Works tool list hides the package and opportunity tools and has no publish capability", () => {
    const names = toolsForPhase("ACTIVE", { works: true }).map((t) => t.name);
    expect(names).not.toContain("propose_content_package");
    expect(names).not.toContain("generate_ideas_from_opportunities");
    expect(names).toContain("propose_plan_options");
    expect(names).toContain("propose_ideas");
    const schema = tool("create_task").schema;
    for (const publish of [
      "INSTAGRAM_PUBLISH",
      "TIKTOK_PUBLISH",
      "LINKEDIN_PUBLISH",
      "X_PUBLISH",
    ]) {
      expect(
        schema.safeParse({ capability: publish, taskBrief: "x" }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({ capability: "CREATE_COPY", taskBrief: "x" }).success,
    ).toBe(true);
  });

  it("refuses a platform the Work does not target, without submitting", async () => {
    const out = await tool("create_task").execute(
      { capability: "CREATE_COPY", taskBrief: "caption", platform: "TIKTOK" } as never,
      ctx({ work: work(["linkedin"]) }),
    );
    expect(out).toMatchObject({ result: { error: expect.stringContaining("LinkedIn") } });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("the plan stays inside the Work's channels", () => {
  const item = (channel: string, formatKey: string) => ({
    date: "2999-01-02",
    channel,
    formatKey,
    topic: "Topic",
    captionIdea: "Idea",
  });

  it("refuses a plan item on another channel with a repair hint", async () => {
    const out = await tool("propose_content_plan").execute(
      {
        title: "Plan",
        items: [item("instagram", "instagram.post"), item("tiktok", "tiktok.video")],
      } as never,
      ctx({ work: work(["instagram"]) }),
    );
    expect(out).toMatchObject({
      result: { error: expect.stringContaining("tiktok") },
    });
  });

  it("the wizard only offers the Work's channels", async () => {
    const out = await tool("start_plan_brief").execute(
      {} as never,
      ctx({ work: work(["linkedin"]) }),
    );
    expect(out).toMatchObject({
      card: { kind: "plan-brief", workChannels: ["linkedin"] },
    });
  });
});
