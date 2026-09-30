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

const getBrandTwin = vi.fn();
vi.mock("@/server/brand-twin/brand-twin", () => ({ getBrandTwin }));
const recall = vi.fn();
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { recall },
}));
const getLiveSession = vi.fn();
vi.mock("@/server/work-session/work-session-service", () => ({
  WorkSessionService: { getLive: getLiveSession },
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
  getBrandTwin.mockResolvedValue({ brandId: "brand-1", name: "Acme" });
  recall.mockResolvedValue({ standing: [], relevant: [] });
  getLiveSession.mockResolvedValue(null);
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

describe("buildContext: Brand Memory", () => {
  const webRow = (id: string, text: string) => ({
    id,
    source: "WEB",
    rawText: text,
    replyText: null,
    attachments: null,
    parsedIntent: null,
  });

  it("leaves the brand profile exactly as it was for the legacy chat (no recall)", async () => {
    const context = await buildContext("proj-1");

    expect(getBrandTwin).toHaveBeenCalledWith("proj-1");
    expect(recall).not.toHaveBeenCalled();
    expect(context.memory).toBeNull();
  });

  it("gives the agent the profile without memory, and the memory that matters instead", async () => {
    const recalled = {
      standing: [
        {
          id: "m1",
          text: "Never use neon colours",
          polarity: "AVOID",
          source: "USER_EXPLICIT",
          confidence: 0.95,
          seen: 1,
          updatedAt: new Date(),
        },
      ],
      relevant: [],
    };
    recall.mockResolvedValue(recalled);

    const context = await buildContext("proj-1", undefined, { recall: true });

    expect(getBrandTwin).toHaveBeenCalledWith("proj-1", { memory: false });
    expect(recall).toHaveBeenCalledWith("brand-1", expect.any(String));
    expect(context.memory).toBe(recalled);
  });

  it("chooses memory by what the client has been asking about: their last three messages, oldest first", async () => {
    // The query returns newest first, like the real one.
    command.findMany.mockResolvedValue([
      webRow("c5", "fifth message"),
      { ...webRow("s1", ""), source: "SYSTEM", replyText: "Task completed" },
      webRow("c4", "fourth message"),
      webRow("c3", "third message"),
      webRow("c2", "second message"),
      webRow("c1", "first message"),
    ]);

    await buildContext("proj-1", undefined, { recall: true });

    expect(recall.mock.calls[0]![1]).toBe(
      "third message\nfourth message\nfifth message",
    );
  });

  it("looks back past a short 'yes' to the message that carried the topic", async () => {
    command.findMany.mockResolvedValue([
      webRow("c2", "evet"),
      webRow("c1", "sonbahar kampanyası için görsel hazırla"),
    ]);

    await buildContext("proj-1", undefined, { recall: true });

    expect(recall.mock.calls[0]![1]).toContain("sonbahar kampanyası");
  });

  it("bounds the query", async () => {
    command.findMany.mockResolvedValue([webRow("c1", "x".repeat(5_000))]);

    await buildContext("proj-1", undefined, { recall: true });

    expect(recall.mock.calls[0]![1].length).toBeLessThanOrEqual(1_200);
  });

  it("recalls with an empty query when there is nothing to go on", async () => {
    command.findMany.mockResolvedValue([]);

    await buildContext("proj-1", undefined, { recall: true });

    expect(recall).toHaveBeenCalledWith("brand-1", "");
  });
});

describe("buildContext: work session", () => {
  const live = { id: "cmd-s1", session: { goal: "Autumn campaign" } };

  it("hands the agent the project's live session", async () => {
    getLiveSession.mockResolvedValue(live);

    const context = await buildContext("proj-1", undefined, { session: true });

    expect(getLiveSession).toHaveBeenCalledWith("proj-1");
    expect(context.workSession).toBe(live);
  });

  it("is null when there is no live session", async () => {
    const context = await buildContext("proj-1", undefined, { session: true });

    expect(context.workSession).toBeNull();
  });

  it("leaves the legacy chat alone: no lookup, nothing added", async () => {
    getLiveSession.mockResolvedValue(live);

    const context = await buildContext("proj-1");

    expect(getLiveSession).not.toHaveBeenCalled();
    expect(context.workSession).toBeNull();
  });

  it("does not take the message down if the lookup fails", async () => {
    getLiveSession.mockRejectedValue(new Error("db hiccup"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const context = await buildContext("proj-1", undefined, { session: true });

    expect(context.workSession).toBeNull();
    spy.mockRestore();
  });

  it("is independent of memory recall", async () => {
    getLiveSession.mockResolvedValue(live);

    const context = await buildContext("proj-1", undefined, { recall: true });

    expect(getLiveSession).not.toHaveBeenCalled();
    expect(context.workSession).toBeNull();
  });
});
