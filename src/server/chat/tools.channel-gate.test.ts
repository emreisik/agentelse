import { beforeEach, describe, expect, it, vi } from "vitest";

// A chat is free (docs/works.md): the tools never ask which channel a chat is
// for and never refuse a channel the chat did not start with; the chat's
// channels are only defaults. DB-less: every collaborator is mocked.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    projectSchedule: { findFirst: async () => null },
    // A plan that passes every check replaces the open drafts of the chat.
    command: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  },
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

describe("a chat without a channel is never asked for one", () => {
  it("a broad project starts at once", async () => {
    submit.mockResolvedValue({ status: "PLANNED", commandId: "cmd-1", taskId: "t1", dispatched: false, requiresApproval: false });
    const out = await tool("start_strategic_project").execute(
      { title: "Launch", brief: "A full campaign" } as never,
      ctx({ work: work([]) }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out)).not.toContain("channel-select");
  });

  it("copy for a channel-bound capability goes to slot-first with no platform of its own", async () => {
    slotFirstText.mockResolvedValue({ result: { outcome: "slot_planned" } });
    await tool("create_task").execute(
      { capability: "CREATE_COPY", taskBrief: "write copy" } as never,
      ctx({ work: work([]) }),
    );
    expect(slotFirstText).toHaveBeenCalledTimes(1);
    expect(slotFirstText.mock.calls[0]?.[0]).toMatchObject({ capability: "CREATE_COPY" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("research still runs", async () => {
    submit.mockResolvedValue({ status: "PLANNED", commandId: "cmd-1", taskId: "t1", dispatched: false, requiresApproval: false });
    await tool("create_task").execute(
      { capability: "MARKET_RESEARCH", taskBrief: "market" } as never,
      ctx({ work: work([]) }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a picture is made to Instagram's standard whatever the chat's channels are", async () => {
    slotFirstImage.mockResolvedValue({ result: { outcome: "image_ready" } });
    for (const channels of [[], ["linkedin"]]) {
      slotFirstImage.mockClear();
      await tool("generate_image").execute(
        { imagePrompt: "a clinic", caption: "c", copy: "c", contentFormat: "FEED_PORTRAIT" } as never,
        ctx({ work: work(channels) }),
      );
      expect(slotFirstImage).toHaveBeenCalledTimes(1);
      expect(slotFirstImage.mock.calls[0]?.[0]).toMatchObject({ platform: "INSTAGRAM" });
    }
  });

  it("the planning wizard is not offered in a chat (it plans straight away)", () => {
    expect(toolsForPhase("ACTIVE", { works: true }).map((t) => t.name)).not.toContain("start_plan_brief");
  });
});

describe("a plan is not held to the chat's starting channels", () => {
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const item = (channel: string, formatKey: string) => ({
    date: inDays(3),
    channel,
    formatKey,
    topic: "Topic",
    captionIdea: "Idea",
  });

  it("items on other channels than the chat's default are accepted", async () => {
    const out = await tool("propose_content_plan").execute(
      {
        title: "Plan",
        items: [item("instagram", "instagram.post"), item("linkedin", "linkedin.post"), item("tiktok", "tiktok.video")],
      } as never,
      ctx({ work: work(["instagram"]) }),
    );
    expect(out).toMatchObject({ card: { kind: "content-plan-draft" } });
  });

  it("an empty chat plans too", async () => {
    const out = await tool("propose_content_plan").execute(
      { title: "Plan", items: [item("instagram", "instagram.post")] } as never,
      ctx({ work: work([]) }),
    );
    expect(out).toMatchObject({ card: { kind: "content-plan-draft" } });
  });
});
