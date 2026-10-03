import { beforeEach, describe, expect, it, vi } from "vitest";

// remember_preference is how something the client said becomes lasting memory.
// This suite pins down what it writes, the caps on it, and which tools count
// as reading outside content or changing lasting state (the flags the agent
// loop's protection against injected instructions is built on).

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn(),
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin: vi.fn() }));
const recordUserDecision = vi.hoisted(() => vi.fn());
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({ recordUserDecision }));
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn(),
}));
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: vi.fn() },
}));
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea: vi.fn() }));
const remember = vi.hoisted(() => vi.fn());
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { remember },
}));

const { toolsForPhase } = await import("./tools");

const allTools = () => [
  ...new Map(
    [...toolsForPhase("ACTIVE"), ...toolsForPhase("ON_HOLD")].map((tool) => [
      tool.name,
      tool,
    ]),
  ).values(),
];
const tool = (name: string) =>
  allTools().find((candidate) => candidate.name === name)!;

const baseCtx = () => ({
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-1",
  message: "Neon renkleri asla kullanma",
  phase: "ACTIVE" as const,
  emit: vi.fn(),
});
const args = (overrides: Record<string, unknown> = {}) => ({
  type: "CREATIVE_PREFERENCE",
  scope: "BRAND",
  value: "Never use neon colours",
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  recordUserDecision.mockResolvedValue({ id: "dec-1" });
  remember.mockResolvedValue({ status: "CREATED", id: "m1", superseded: 0 });
});

describe("which tools the injection protection covers", () => {
  it("treats exactly the tools that read stored outside content as external", () => {
    expect(
      allTools()
        .filter((candidate) => candidate.external)
        .map((candidate) => candidate.name)
        .sort(),
    ).toEqual(["get_findings", "get_insights", "get_signals", "get_task_result"]);
  });

  it("refuses exactly the tools that change lasting state in a tainted turn", () => {
    expect(
      allTools()
        .filter((candidate) => candidate.sensitive)
        .map((candidate) => candidate.name)
        .sort(),
    ).toEqual([
      "decide_approval",
      "remember_preference",
      // Saves the client's design examples and standing design rule into the
      // brand's Post Style Kit: lasting state.
      "save_style_reference",
      "start_deep_enrichment",
      // The goal and steps are read back on later messages, so a plan written
      // after outside content was read could carry text from a page.
      "start_work_session",
    ]);
  });

  it("makes exactly a decision and a long paid job 'first action only'", () => {
    expect(
      allTools()
        .filter((candidate) => candidate.decisive)
        .map((candidate) => candidate.name)
        .sort(),
    ).toEqual(["decide_approval", "start_deep_enrichment"]);
  });

  it("only ever marks work tools as decisive: a note or a lookup cannot decide anything", () => {
    for (const candidate of allTools().filter((c) => c.decisive)) {
      expect(candidate.kind, candidate.name).toBe("work");
    }
  });

  it("never makes a tool both a reader of outside content and a changer of state", () => {
    for (const candidate of allTools()) {
      expect(candidate.external && candidate.sensitive, candidate.name).toBeFalsy();
    }
  });
});

describe("remember_preference", () => {
  it("is a note the agent can also use on a project on hold", () => {
    expect(tool("remember_preference").kind).toBe("note");
    expect(toolsForPhase("ON_HOLD").map((t) => t.name)).toContain(
      "remember_preference",
    );
  });

  it("keeps the structured record with the client's raw message", async () => {
    await tool("remember_preference").execute(args(), baseCtx());

    expect(recordUserDecision).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      type: "CREATIVE_PREFERENCE",
      scope: "BRAND",
      value: "Never use neon colours",
      rawMessage: "Neon renkleri asla kullanma",
      sourceCommandId: "cmd-1",
      createdByUserId: "user-1",
    });
  });

  it("saves the memory as the client's own word, tied to the record it made", async () => {
    await tool("remember_preference").execute(args(), baseCtx());

    expect(remember).toHaveBeenCalledWith({
      scope: { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
      insight: "Never use neon colours",
      polarity: "WORKS",
      source: "USER_EXPLICIT",
      sourceRef: "dec-1",
    });
  });

  it("stores a never-rule as something to avoid", async () => {
    await tool("remember_preference").execute(args({ avoid: true }), baseCtx());

    expect(remember.mock.calls[0]![0].polarity).toBe("AVOID");
  });

  it("says when it already knew the preference", async () => {
    remember.mockResolvedValue({ status: "REINFORCED", id: "m1", superseded: 0 });

    const outcome = await tool("remember_preference").execute(args(), baseCtx());

    expect(outcome.result).toEqual({ outcome: "already_known" });
  });

  it("tells the agent when the client changed their mind, so it can say so", async () => {
    remember.mockResolvedValue({ status: "CREATED", id: "m2", superseded: 1 });

    const outcome = await tool("remember_preference").execute(args(), baseCtx());

    expect(outcome.result).toMatchObject({ outcome: "saved" });
    expect(JSON.stringify(outcome.result)).toContain("replaces an earlier opposite");
  });

  it("does not need the structured record to have an id", async () => {
    recordUserDecision.mockResolvedValue(undefined);

    await tool("remember_preference").execute(args(), baseCtx());

    expect(remember.mock.calls[0]![0].sourceRef).toBeUndefined();
  });

  it("counts what it saves against the message's limit of three", async () => {
    const ctx = baseCtx() as ReturnType<typeof baseCtx> & { memoryWrites?: number };

    for (let i = 0; i < 3; i += 1) {
      await tool("remember_preference").execute(args({ value: `rule ${i}` }), ctx);
    }
    expect(ctx.memoryWrites).toBe(3);

    const fourth = await tool("remember_preference").execute(
      args({ value: "one too many" }),
      ctx,
    );

    expect(fourth.result).toMatchObject({ outcome: "too_many_in_one_message" });
    expect(recordUserDecision).toHaveBeenCalledTimes(3);
    expect(remember).toHaveBeenCalledTimes(3);
    expect(ctx.memoryWrites).toBe(3);
  });

  it("accepts an optional avoid flag and nothing that names another brand", () => {
    const schema = tool("remember_preference").schema;

    expect(schema.safeParse(args()).success).toBe(true);
    expect(schema.safeParse(args({ avoid: true })).success).toBe(true);
    expect(schema.safeParse(args({ avoid: "yes" })).success).toBe(false);
    expect(schema.parse(args({ brandId: "brand-evil" }))).not.toHaveProperty(
      "brandId",
    );
  });
});
