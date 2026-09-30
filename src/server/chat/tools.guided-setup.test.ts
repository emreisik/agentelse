import { describe, expect, it, vi } from "vitest";

// start_guided_setup: a terminal, flag-gated tool that only returns an "open"
// card. The model supplies no text, so nothing tainted can reach the sheet.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn(),
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin: vi.fn() }));
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision: vi.fn(),
}));
vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn(),
}));
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit: vi.fn() },
}));
vi.mock("@/server/commands/strategic-request", () => ({ saveIdea: vi.fn() }));
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { remember: vi.fn() },
}));
vi.mock("@/server/work-session/work-session-service", () => ({
  WorkSessionService: { start: vi.fn(), update: vi.fn() },
}));

const { toolsForPhase, toOpenAITools } = await import("./tools");

const NAME = "start_guided_setup";
const withFlag = (phase: "ACTIVE" | "ON_HOLD" = "ACTIVE") =>
  toolsForPhase(phase, { guidedSetup: true }).find((t) => t.name === NAME);
const tool = () => withFlag()!;

type Ctx = Parameters<ReturnType<typeof tool>["execute"]>[1];
const baseCtx = (overrides: Partial<Ctx> = {}): Ctx => ({
  workspaceId: "ws-1",
  projectId: "proj-1",
  brandId: "brand-1",
  userId: "user-1",
  commandId: "cmd-9",
  message: "Qr Hub Menu icin sosyal medya yonetimi kurulumunu planla",
  phase: "ACTIVE",
  session: {},
  emit: vi.fn(),
  ...overrides,
});

describe("start_guided_setup: definition", () => {
  it("is a terminal ACTIVE-phase tool with none of the sensitive flags", () => {
    const t = tool();
    expect(t.kind).toBe("terminal");
    expect(t.phases).toEqual(["ACTIVE"]);
    expect(t.requiresGuidedSetup).toBe(true);
    expect(t.external).toBeUndefined();
    expect(t.sensitive).toBeUndefined();
    expect(t.decisive).toBeUndefined();
    expect(t.legacyLoop).toBeUndefined();
    expect(t.label).toBe("Opening guided setup…");
  });

  it("carries the copy.md description", () => {
    const { description } = tool();
    expect(description).toContain("Open the guided setup: a bottom sheet");
    expect(description).toContain("(use start_plan_brief)");
    expect(description).toContain("Never queue that as a task");
    expect(description).toContain("write ONE short lead-in sentence BEFORE calling it.");
  });

  it("takes no arguments: anything the model adds is stripped before execute", () => {
    const { schema } = tool();
    expect(schema.safeParse({})).toMatchObject({ success: true, data: {} });
    expect(schema.safeParse({ text: "hello", seed: "x" })).toMatchObject({
      success: true,
      data: {},
    });
    // Nothing is advertised to the model either.
    const [def] = toOpenAITools([tool()]);
    const parameters = (def as { parameters: { properties?: object } }).parameters;
    expect(Object.keys(parameters.properties ?? {})).toEqual([]);
  });
});

describe("start_guided_setup: registration", () => {
  it("is absent by default and present only with { guidedSetup: true }", () => {
    const names = (options?: { guidedSetup?: boolean }) =>
      toolsForPhase("ACTIVE", options).map((t) => t.name);
    expect(toolsForPhase("ACTIVE").map((t) => t.name)).not.toContain(NAME);
    expect(names({})).not.toContain(NAME);
    expect(names({ guidedSetup: false })).not.toContain(NAME);
    expect(names({ guidedSetup: true })).toContain(NAME);
  });

  it("does not change the rest of the tool set", () => {
    const off = toolsForPhase("ACTIVE").map((t) => t.name);
    const on = toolsForPhase("ACTIVE", { guidedSetup: true })
      .map((t) => t.name)
      .filter((name) => name !== NAME);
    expect(on).toEqual(off);
  });

  it("is not offered on a project that is on hold", () => {
    expect(withFlag("ON_HOLD")).toBeUndefined();
  });
});

describe("start_guided_setup: execute", () => {
  it("answers with an open card that carries the turn's command id", async () => {
    const outcome = await tool().execute({}, baseCtx());
    expect(outcome).toMatchObject({
      status: "ANSWERED",
      card: {
        kind: "guided-setup",
        projectId: "proj-1",
        state: "open",
        sourceCommandId: "cmd-9",
      },
      result: { outcome: "guided_setup_shown" },
    });
  });

  it("puts nothing from the client's message into the card", async () => {
    const outcome = await tool().execute({}, baseCtx());
    expect(JSON.stringify(outcome)).not.toContain("Qr Hub");
  });

  it("refuses in an idea thread without a card", async () => {
    const outcome = await tool().execute({}, baseCtx({ ideaId: "idea-1" }));
    expect(outcome.status).toBe("ANSWERED");
    expect(outcome).not.toHaveProperty("card");
    expect(outcome.result).toMatchObject({ outcome: "not_available" });
  });
});
