import { beforeEach, describe, expect, it, vi } from "vitest";

// What the chat agent is told about the project each turn. The parts that
// matter here: a finished task's result reaches the model (it used to see only
// "Task completed"), only for the newest few and without the raw parsedIntent,
// and the agent's phase follows the project's status, not the old setup state.

const project = { findUniqueOrThrow: vi.fn() };
const approval = { findMany: vi.fn() };
const command = { findMany: vi.fn() };
const agencyDailyStat = { findFirst: vi.fn() };
const projectSetupState = { findUnique: vi.fn() };
vi.mock("@/lib/prisma", () => ({
  prisma: { project, approval, command, agencyDailyStat, projectSetupState },
}));

vi.mock("@/server/brand-twin/brand-twin", () => ({
  getBrandTwin: vi.fn().mockResolvedValue({ brandId: "brand-1", name: "Acme" }),
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi.fn().mockResolvedValue([]),
}));
vi.mock("./deliverables", () => ({
  buildAgencyCapabilities: vi.fn().mockReturnValue({}),
}));

const { buildContext } = await import("./context");

const taskRow = (id: string, resultText: string | null, title = id) => ({
  id,
  source: "SYSTEM",
  rawText: "",
  replyText: `✅ Task completed: ${title}`,
  attachments: null,
  parsedIntent: resultText
    ? { card: { kind: "task-result", taskId: id, title, resultText } }
    : null,
});

const webRow = (id: string, text: string, reply: string) => ({
  id,
  source: "WEB",
  rawText: text,
  replyText: reply,
  attachments: null,
  parsedIntent: { card: { kind: "task-result", resultText: "not a task row" } },
});

beforeEach(() => {
  vi.clearAllMocks();
  project.findUniqueOrThrow.mockResolvedValue({
    name: "Acme",
    domain: "acme.com",
    status: "ACTIVE",
    language: "tr",
    country: "TR",
  });
  approval.findMany.mockResolvedValue([]);
  command.findMany.mockResolvedValue([]);
  agencyDailyStat.findFirst.mockResolvedValue(null);
  projectSetupState.findUnique.mockResolvedValue(null);
});

describe("buildContext task results", () => {
  it("hands the newest three task results to the agent, in chronological order", async () => {
    // The query returns newest first, like the real one.
    command.findMany.mockResolvedValue([
      taskRow("t5", "result five"),
      taskRow("t4", "result four"),
      taskRow("t3", "result three"),
      taskRow("t2", "result two"),
      taskRow("t1", "result one"),
    ]);

    const context = await buildContext("proj-1");

    expect(context.recent.map((row) => row.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
    ]);
    // Only the latest three carry their text; older ones stay behind
    // get_task_result.
    expect(context.recent.map((row) => row.resultText)).toEqual([
      undefined,
      undefined,
      "result three",
      "result four",
      "result five",
    ]);
  });

  it("skips events with no result without spending the budget on them", async () => {
    command.findMany.mockResolvedValue([
      taskRow("t3", null),
      taskRow("t2", "result two"),
      taskRow("t1", "result one"),
    ]);

    const context = await buildContext("proj-1");

    expect(context.recent.map((row) => row.resultText)).toEqual([
      "result one",
      "result two",
      undefined,
    ]);
  });

  it("never reads a result off a client message", async () => {
    command.findMany.mockResolvedValue([webRow("w1", "hi", "hello")]);

    const context = await buildContext("proj-1");

    expect(context.recent[0]?.resultText).toBeUndefined();
  });

  it("does not pass the raw parsedIntent on to the agent", async () => {
    command.findMany.mockResolvedValue([taskRow("t1", "result one")]);

    const context = await buildContext("proj-1");

    expect(context.recent[0]).not.toHaveProperty("parsedIntent");
  });

  it("leaves the legacy flattened history as it was: event notes only, no result text", async () => {
    command.findMany.mockResolvedValue([
      webRow("w1", "thanks", "you are welcome"),
      taskRow("t1", "result one", "Research"),
    ]);

    const context = await buildContext("proj-1");

    expect(context.history).toBe(
      [
        "System: ✅ Task completed: Research",
        "Client: thanks",
        "You: you are welcome",
      ].join("\n"),
    );
  });
});

describe("buildContext phase", () => {
  it("is ACTIVE for an active project regardless of the setup state", async () => {
    projectSetupState.findUnique.mockResolvedValue(null);

    const context = await buildContext("proj-1");

    expect(context.projectPhase).toBe("ACTIVE");
    // The legacy service still reads its own setup phase from the same call.
    expect(context.setupPhase).toBe("NOT_STARTED");
  });

  it.each(["PAUSED", "CLOSED", "CREATED"])(
    "is ON_HOLD when the project is %s",
    async (status) => {
      project.findUniqueOrThrow.mockResolvedValue({
        name: "Acme",
        domain: null,
        status,
        language: "tr",
        country: "TR",
      });

      const context = await buildContext("proj-1");

      expect(context.projectPhase).toBe("ON_HOLD");
    },
  );

  it("reports a running deep enrichment without letting it hold the project", async () => {
    projectSetupState.findUnique.mockResolvedValue({
      activatedAt: null,
      stageRecords: [],
    });

    const context = await buildContext("proj-1");

    expect(context.projectPhase).toBe("ACTIVE");
    expect(context.setupWaiting).toBe("running");
  });
});
