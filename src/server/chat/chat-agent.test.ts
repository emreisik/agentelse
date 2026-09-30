import { beforeEach, describe, expect, it, vi } from "vitest";

// What this suite proves about the streaming chat engine: (a) the Command row
// exists before the first token, (b) a tool call runs the existing service
// with the turn's own Command, and only ONE work action runs per turn,
// (c) tools are gated by setup phase, (d) ask_user ends the turn with a
// persisted question card, (e) failures degrade like the legacy engine did:
// limit-notice cards for recognized blocks, rule-based fallback only when
// nothing visible/queued happened yet, (f) Stop keeps the partial reply.

const envOverrides: Record<string, unknown> = {};
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-5.6-luna",
    CHAT_MODEL: "",
    CHAT_REASONING_EFFORT: "low",
    CHAT_WEB_SEARCH: false,
    ...envOverrides,
  }),
}));

const taskFindMany = vi.fn();
const jobFindFirst = vi.fn();
const jobFindUniqueOrThrow = vi.fn();
const taskFindUnique = vi.fn();
const commandFindMany = vi.fn().mockResolvedValue([]);
const commandUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: taskFindMany, findUnique: taskFindUnique },
    executionJob: {
      findFirst: jobFindFirst,
      findUniqueOrThrow: jobFindUniqueOrThrow,
    },
    projectSchedule: { findFirst: vi.fn().mockResolvedValue(null) },
    command: { findMany: commandFindMany, update: commandUpdate },
    approval: { findMany: vi.fn().mockResolvedValue([]) },
    idea: { findMany: vi.fn().mockResolvedValue([]) },
    finding: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
const startExecution = vi.fn();
vi.mock("@/server/execution/execution-service", () => ({
  ExecutionService: { startExecution },
}));
// Who owns the job's dispatch event: this turn ("claimed") or the worker.
const claimDispatchForInline = vi.fn().mockResolvedValue("claimed");
vi.mock("@/server/repositories/outbox.repository", () => ({
  OutboxRepository: { claimDispatchForInline },
}));
const resolveBrandStyleContext = vi.fn();
vi.mock("@/server/media/brand-style-context", () => ({
  resolveBrandStyleContext,
}));
vi.mock("@/server/integrations/meta-connection-status", () => ({
  getPublishTargets: vi
    .fn()
    .mockResolvedValue([{ platform: "instagram", accountLabel: "@acme" }]),
}));
vi.mock("@/server/brand-twin/brand-twin", async (importOriginal) => ({
  // brandCoreOf is a pure helper the agent uses; keep the real one.
  ...(await importOriginal<typeof import("@/server/brand-twin/brand-twin")>()),
  getBrandTwin: vi
    .fn()
    .mockResolvedValue({ name: "Acme", currentFocus: { title: "Kommo CRM" } }),
}));
vi.mock("@/server/integrations/channel-connections", () => ({
  getChannelConnections: vi.fn().mockResolvedValue({
    instagram: { connected: true, accountLabel: "@acme" },
    ads: { connected: false },
  }),
}));

const buildContext = vi.fn();
vi.mock("@/server/chat/context", () => ({ buildContext }));

const ensureProjectActive = vi.fn();
vi.mock("@/server/projects/activation", () => ({ ensureProjectActive }));

// The first-conversation brand scan. Off by default (a brand the agency
// already knows); the tests for it arm claim() explicitly.
const claimQuickDiscovery = vi.fn();
const runQuickDiscovery = vi.fn();
vi.mock("@/server/brand/quick-discovery", () => ({
  QuickDiscoveryService: {
    claim: claimQuickDiscovery,
    runWithin: runQuickDiscovery,
  },
}));

const submit = vi.fn();
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));

vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn().mockResolvedValue({ ok: true }),
}));
const rememberMemory = vi.fn();
vi.mock("@/server/memory/memory-service", () => ({
  MemoryService: { remember: rememberMemory },
}));
const startSession = vi.fn();
const updateSession = vi.fn();
const addSessionSpend = vi.fn();
vi.mock("@/server/work-session/work-session-service", () => ({
  WorkSessionService: {
    start: startSession,
    update: updateSession,
    addSpend: addSessionSpend,
    getLive: vi.fn(),
  },
}));
const recordUserDecision = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/brand-twin/brand-twin-writes", () => ({
  recordUserDecision,
}));

vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { isMockMode: () => false },
}));

const commandCreate = vi.fn();
const recordReply = vi.fn().mockResolvedValue(undefined);
const attachParsedIntent = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/command.repository", () => ({
  CommandRepository: {
    create: commandCreate,
    recordReply,
    attachParsedIntent,
  },
}));

const checkAndIncrement = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { checkAndIncrement },
}));
const reasoningRecord = vi.fn().mockResolvedValue({ id: "rc-1" });
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: { record: reasoningRecord },
}));
const auditRecord = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: auditRecord },
}));

const { runChatAgent } = await import("./chat-agent");
const { AgentelseError } = await import("@/server/security/errors");
const { serializePlanBrief } = await import("@/lib/plan-brief");

import { createSession, type WorkSession } from "@/server/work-session/session";
import type {
  ChatModel,
  ChatModelEvent,
  ChatModelRequest,
  ChatStreamEvent,
} from "./types";

type Round = {
  text?: string[];
  calls?: { name: string; args: unknown }[];
  fail?: Error;
  hang?: boolean;
  // Raw output items of the model turn, e.g. a hosted web_search_call.
  output?: unknown[];
  // Token usage this round reports (default 100 in / 20 out).
  inputTokens?: number;
  outputTokens?: number;
};

function scriptedModel(rounds: Round[]) {
  const requests: ChatModelRequest[] = [];
  let index = 0;
  const model: ChatModel = {
    async *stream(request): AsyncGenerator<ChatModelEvent> {
      requests.push(request);
      const round = rounds[index++] ?? {};
      for (const text of round.text ?? []) {
        yield { type: "text.delta", text };
      }
      if (round.fail) throw round.fail;
      if (round.hang) {
        await new Promise((_, reject) => {
          const cancel = () =>
            reject(new AgentelseError("CANCELLED", "aborted"));
          // The client may already have pressed Stop by the time we get here.
          if (request.signal?.aborted) cancel();
          request.signal?.addEventListener("abort", cancel);
        });
      }
      yield {
        type: "completed",
        output: (round.output ?? []) as never,
        functionCalls: (round.calls ?? []).map((call, i) => ({
          callId: `call-${index}-${i}`,
          name: call.name,
          arguments: JSON.stringify(call.args),
        })),
        inputTokens: round.inputTokens ?? 100,
        outputTokens: round.outputTokens ?? 20,
      };
    },
  };
  return { model, requests };
}

async function collect(
  gen: AsyncGenerator<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

// A calendar date `offset` days from now (UTC day key) for plan slots.
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const baseInput = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  userId: "user-1",
  message: "Bir instagram postu hazırla",
};

function context(projectPhase: "ACTIVE" | "ON_HOLD") {
  return {
    brandId: "brand-1",
    project: {
      name: "Acme",
      language: "tr",
      country: "TR",
      domain: "https://www.acme.com.tr/",
    },
    brand: { name: "Acme" },
    state: null,
    pending: [],
    history: "",
    recent: [],
    projectPhase,
    setupWaiting: undefined,
  };
}

const text = (events: ChatStreamEvent[]) =>
  events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(envOverrides)) delete envOverrides[key];
  buildContext.mockResolvedValue(context("ACTIVE"));
  ensureProjectActive.mockResolvedValue({ status: "ACTIVE", usable: true });
  claimQuickDiscovery.mockResolvedValue(null);
  rememberMemory.mockResolvedValue({ status: "CREATED", id: "m1", superseded: 0 });
  recordUserDecision.mockResolvedValue({ id: "dec-1" });
  runQuickDiscovery.mockResolvedValue({ status: "DONE", version: 1, pages: 2 });
  commandCreate.mockResolvedValue({ id: "cmd-1" });
  checkAndIncrement.mockResolvedValue(undefined);
  addSessionSpend.mockResolvedValue(undefined);
});

describe("runChatAgent", () => {
  it("creates the Command first and streams a plain answer", async () => {
    const { model } = scriptedModel([
      { text: ["Merhaba, ", "nasıl yardım edebilirim?"] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(events[0]).toEqual({ type: "start", commandId: "cmd-1" });
    expect(text(events)).toBe("Merhaba, nasıl yardım edebilirim?");
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "ANSWERED",
      reply: "Merhaba, nasıl yardım edebilirim?",
    });
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-1",
      "Merhaba, nasıl yardım edebilirim?",
      "ANSWERED",
    );
    expect(submit).not.toHaveBeenCalled();
    // A turn that never went through CommandService.submit still audits.
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "command.received" }),
    );
    expect(reasoningRecord).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "chat.turn", status: "OK" }),
    );
  });

  it("runs create_task through CommandService on the turn's own Command", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "t-1",
      dispatched: true,
      requiresApproval: true,
    });
    const { model } = scriptedModel([
      {
        text: ["Hemen hazırlıyorum."],
        calls: [
          {
            name: "create_task",
            args: {
              capability: "CREATE_CAPTION",
              taskBrief: "Premium bir Instagram postu",
              platform: "INSTAGRAM",
            },
          },
        ],
      },
      { text: ["Post taslağı hazır olunca haber vereceğim."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        existingCommandId: "cmd-1",
        knownProjectId: "proj-1",
        intent: {
          kind: "CAPABILITY",
          capability: "CREATE_CAPTION",
          targetPlatform: "INSTAGRAM",
          contentFormat: undefined,
          request: "Premium bir Instagram postu",
        },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["tool.start", "tool.end", "done"]),
    );
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", status: "PLANNED" });
    const reply = done?.type === "done" ? done.reply : "";
    expect(reply).toContain("Hemen hazırlıyorum.");
    expect(reply).toContain("Post taslağı hazır olunca haber vereceğim.");
    expect(reply).toContain("come to you for approval");
    // What the client saw streamed is exactly what was persisted.
    expect(text(events).replace(/\s+/g, " ")).toBe(reply.replace(/\s+/g, " "));
    // The audit row belongs to submit for work turns, not to the agent.
    expect(auditRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "command.received" }),
    );
  });

  it("lets only one work action run per turn", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "t-1",
      dispatched: true,
      requiresApproval: false,
    });
    const { model, requests } = scriptedModel([
      {
        calls: [
          {
            name: "create_task",
            args: { capability: "CREATE_COPY", taskBrief: "a" },
          },
        ],
      },
      {
        calls: [
          {
            name: "create_task",
            args: { capability: "CREATE_CAPTION", taskBrief: "b" },
          },
        ],
      },
      { text: ["Tamam."] },
    ]);
    await collect(runChatAgent(baseInput, { model }));

    expect(submit).toHaveBeenCalledTimes(1);
    // The refused second call was reported back to the model as an error.
    const lastInput = requests.at(-1)!.input;
    const outputs = lastInput.filter(
      (item) => "type" in item && item.type === "function_call_output",
    );
    expect(JSON.stringify(outputs.at(-1))).toContain("Only one action");
  });

  it("only offers read-only tools on a project that is on hold", async () => {
    buildContext.mockResolvedValue(context("ON_HOLD"));
    const { model, requests } = scriptedModel([
      {
        calls: [
          {
            name: "create_task",
            args: { capability: "CREATE_COPY", taskBrief: "x" },
          },
        ],
      },
      { text: ["Proje şu an duraklatılmış."] },
    ]);
    await collect(runChatAgent(baseInput, { model }));

    const offered = requests[0]!.tools.map((t) => (t as { name: string }).name);
    expect(offered).toContain("get_brand_profile");
    expect(offered).not.toContain("create_task");
    expect(offered).not.toContain("generate_image");
    expect(submit).not.toHaveBeenCalled();
  });

  it("activates the project before loading the context, so a project that never ran setup can work on its first message", async () => {
    const order: string[] = [];
    ensureProjectActive.mockImplementation(async () => {
      order.push("ensureProjectActive");
      return { status: "ACTIVE", usable: true };
    });
    buildContext.mockImplementation(async () => {
      order.push("buildContext");
      return context("ACTIVE");
    });
    const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

    await collect(runChatAgent(baseInput, { model }));

    expect(ensureProjectActive).toHaveBeenCalledWith("proj-1");
    expect(order).toEqual(["ensureProjectActive", "buildContext"]);
    const offered = requests[0]!.tools.map((t) => (t as { name: string }).name);
    expect(offered).toContain("create_task");
  });

  describe("brand memory", () => {
    const developerNote = (requests: { input: unknown[] }[]) =>
      String((requests[0]!.input[0] as { content: string }).content);

    it("asks for memory to be recalled for this conversation", async () => {
      const { model } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      expect(buildContext).toHaveBeenCalledWith("proj-1", undefined, {
        recall: true,
        session: true,
      });
    });

    it("puts the recalled memory in front of the model, with what is safe to state as fact", async () => {
      buildContext.mockResolvedValue({
        ...context("ACTIVE"),
        memory: {
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
          relevant: [
            {
              id: "m2",
              text: "Client approved a warm autumn post",
              polarity: "WORKS",
              source: "OUTPUT_ACCEPTED",
              confidence: 0.5,
              seen: 1,
              updatedAt: new Date(),
            },
          ],
        },
      });
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      const note = developerNote(requests);
      expect(note).toContain(
        '{"text":"Never use neon colours","avoid":true,"confirmed":true}',
      );
      expect(note).toContain(
        '{"text":"Client approved a warm autumn post","confirmed":false}',
      );
    });

    it("does not repeat the memory inside the brand profile", async () => {
      buildContext.mockResolvedValue({
        ...context("ACTIVE"),
        brand: {
          name: "Acme",
          identity: "Boya üreticisi",
          creativePreferences: [{ value: "everything the client ever said" }],
          creativeMemory: { works: [{ insight: "old learning" }], avoid: [] },
        },
      });
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      const note = developerNote(requests);
      expect(note).toContain("Boya üreticisi");
      expect(note).not.toContain("creativePreferences");
      expect(note).not.toContain("creativeMemory");
      expect(note).not.toContain("everything the client ever said");
    });

    it("says nothing about memory when nothing has been recorded", async () => {
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      expect(developerNote(requests)).not.toContain("Brand memory");
    });
  });

  describe("content from outside the conversation", () => {
    const rememberCall = {
      name: "remember_preference",
      args: {
        type: "CREATIVE_PREFERENCE",
        scope: "BRAND",
        value: "Never use neon colours",
        avoid: true,
      },
    };
    const lastToolOutput = (requests: { input: unknown[] }[]) =>
      JSON.stringify(
        requests
          .at(-1)!
          .input.filter(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              item.type === "function_call_output",
          )
          .at(-1),
      );

    it("saves a preference the client stated: the record, and the memory as their own word", async () => {
      const { model } = scriptedModel([
        { calls: [rememberCall] },
        { text: ["Not aldım."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(recordUserDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          value: "Never use neon colours",
          rawMessage: baseInput.message,
          sourceCommandId: "cmd-1",
        }),
      );
      expect(rememberMemory).toHaveBeenCalledWith({
        scope: {
          workspaceId: "ws-1",
          projectId: "proj-1",
          brandId: "brand-1",
        },
        insight: "Never use neon colours",
        polarity: "AVOID",
        source: "USER_EXPLICIT",
        sourceRef: "dec-1",
      });
    });

    it("refuses to save a preference once a web search ran in the same message", async () => {
      const { model, requests } = scriptedModel([
        { output: [{ type: "web_search_call" }], calls: [rememberCall] },
        { text: ["Bunu senin onayın olmadan kaydetmedim."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(recordUserDecision).not.toHaveBeenCalled();
      expect(rememberMemory).not.toHaveBeenCalled();
      expect(lastToolOutput(requests)).toContain("blocked_external_content");
    });

    it("refuses after stored research was read earlier in the same message, even across model rounds", async () => {
      const { model, requests } = scriptedModel([
        { calls: [{ name: "get_findings", args: {} }] },
        { calls: [rememberCall] },
        { text: ["Kaydetmedim."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(recordUserDecision).not.toHaveBeenCalled();
      expect(rememberMemory).not.toHaveBeenCalled();
      expect(lastToolOutput(requests)).toContain("blocked_external_content");
    });

    it("refuses when the read and the save come in the same model round", async () => {
      const { model } = scriptedModel([
        { calls: [{ name: "get_findings", args: {} }, rememberCall] },
        { text: ["Kaydetmedim."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(rememberMemory).not.toHaveBeenCalled();
    });

    it("does not carry the suspicion over to the client's next message", async () => {
      const first = scriptedModel([
        { output: [{ type: "web_search_call" }], calls: [rememberCall] },
        { text: ["Kaydetmedim."] },
      ]);
      await collect(runChatAgent(baseInput, { model: first.model }));
      expect(rememberMemory).not.toHaveBeenCalled();

      commandCreate.mockResolvedValue({ id: "cmd-2" });
      const second = scriptedModel([
        { calls: [rememberCall] },
        { text: ["Kaydettim."] },
      ]);
      await collect(
        runChatAgent(
          { ...baseInput, message: "Evet, neon renkleri asla kullanma." },
          { model: second.model },
        ),
      );

      expect(rememberMemory).toHaveBeenCalledTimes(1);
    });

    it("also refuses to decide an approval on the strength of outside content", async () => {
      const { model, requests } = scriptedModel([
        {
          output: [{ type: "web_search_call" }],
          calls: [{ name: "decide_approval", args: { decision: "APPROVE" } }],
        },
        { text: ["Onaylamadım."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(submit).not.toHaveBeenCalled();
      expect(lastToolOutput(requests)).toContain("blocked_external_content");
    });

    it("does not spend the turn's one work action on a refused call", async () => {
      submit.mockResolvedValue({
        status: "PLANNED",
        commandId: "cmd-1",
        taskId: "t-1",
        dispatched: false,
        requiresApproval: false,
      });
      const { model } = scriptedModel([
        {
          output: [{ type: "web_search_call" }],
          calls: [{ name: "decide_approval", args: { decision: "APPROVE" } }],
        },
        {
          calls: [
            {
              name: "create_task",
              args: { capability: "COMPETITOR_RESEARCH", taskBrief: "x" },
            },
          ],
        },
        { text: ["Araştırmayı başlattım."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      // The approval never ran, and the task that followed did.
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({ kind: "CAPABILITY" }),
        }),
      );
    });

    it("lets at most three preferences be saved from one message", async () => {
      const call = (value: string) => ({
        name: "remember_preference",
        args: { type: "CREATIVE_PREFERENCE", scope: "BRAND", value },
      });
      const { model, requests } = scriptedModel([
        {
          calls: [call("a rule"), call("b rule"), call("c rule"), call("d rule")],
        },
        { text: ["Üçünü kaydettim."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(rememberMemory).toHaveBeenCalledTimes(3);
      expect(lastToolOutput(requests)).toContain("too_many_in_one_message");
    });
  });

  describe("first brand scan", () => {
    const target = {
      workspaceId: "ws-1",
      projectId: "proj-1",
      brandId: "brand-1",
      brandName: "Acme",
      domain: "acme.com.tr",
      language: "tr",
      country: "TR",
    };
    const developerNote = (requests: { input: unknown[] }[]) =>
      String((requests[0]!.input[0] as { content: string }).content);

    it("does not scan a brand the agency already knows", async () => {
      const { model } = scriptedModel([{ text: ["Merhaba"] }]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(runQuickDiscovery).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === "tool.start")).toBe(false);
    });

    it("reads the brand before answering, showing progress, and tells the model it is a first draft", async () => {
      claimQuickDiscovery.mockResolvedValue(target);
      const order: string[] = [];
      runQuickDiscovery.mockImplementation(async () => {
        order.push("scan");
        return { status: "DONE", version: 1, pages: 2 };
      });
      buildContext.mockImplementation(async () => {
        order.push("buildContext");
        return context("ACTIVE");
      });
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      const events = await collect(runChatAgent(baseInput, { model }));

      // Scanned first, THEN the context was loaded, so the brand profile the
      // model sees already contains what the scan learned.
      expect(order).toEqual(["scan", "buildContext"]);
      expect(runQuickDiscovery).toHaveBeenCalledWith(target, 75_000);
      const types = events.map((e) => e.type);
      expect(types.indexOf("tool.start")).toBeLessThan(types.indexOf("text.delta"));
      expect(events).toContainEqual({
        type: "tool.start",
        name: "quick_discovery",
        label: "Getting to know your brand…",
      });
      expect(events).toContainEqual({
        type: "tool.end",
        name: "quick_discovery",
        ok: true,
      });
      expect(developerNote(requests)).toContain("first draft");
    });

    it.each([
      ["failed", { status: "FAILED", message: "site down" }],
      ["still running", { status: "PENDING" }],
    ])("goes on without the scan when it %s, and says the brand is barely known", async (_label, outcome) => {
      claimQuickDiscovery.mockResolvedValue(target);
      runQuickDiscovery.mockResolvedValue(outcome);
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(text(events)).toBe("Merhaba");
      expect(events).toContainEqual({
        type: "tool.end",
        name: "quick_discovery",
        ok: false,
      });
      expect(developerNote(requests)).toContain("did not finish");
      expect(developerNote(requests)).not.toContain("first draft");
    });

    it("does not let a broken claim take the turn down", async () => {
      claimQuickDiscovery.mockRejectedValue(new Error("db hiccup"));
      const { model } = scriptedModel([{ text: ["Merhaba"] }]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(text(events)).toBe("Merhaba");
      expect(events.some((e) => e.type === "error")).toBe(false);
    });

    it("says nothing about a scan on ordinary turns", async () => {
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      expect(developerNote(requests)).not.toContain("Brand scan");
    });
  });

  it("still answers when activation itself fails", async () => {
    ensureProjectActive.mockRejectedValue(new Error("db hiccup"));
    const { model } = scriptedModel([{ text: ["Merhaba"] }]);

    const events = await collect(runChatAgent(baseInput, { model }));

    expect(text(events)).toBe("Merhaba");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("ends the turn with a persisted question card on ask_user", async () => {
    const { model, requests } = scriptedModel([
      {
        text: ["Hangi yöne gidelim?"],
        calls: [
          {
            name: "ask_user",
            args: {
              questions: [
                {
                  question: "Hedef kitle?",
                  options: [{ label: "Gençler" }, { label: "Aileler" }],
                },
              ],
            },
          },
        ],
      },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(requests).toHaveLength(1);
    expect(events.find((e) => e.type === "card")).toMatchObject({
      card: { kind: "question", projectId: "proj-1" },
    });
    expect(attachParsedIntent).toHaveBeenCalledWith(
      "cmd-1",
      { card: expect.objectContaining({ kind: "question" }) },
      "proj-1",
      "brand-1",
    );
  });

  it("turns a recognized block into a limit-notice card", async () => {
    checkAndIncrement.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "maxReasoningCallsPerDay", cap: 200, used: 200 },
      }),
    );
    const { model } = scriptedModel([{ text: ["never"] }]);
    const events = await collect(runChatAgent(baseInput, { model }));

    const last = events.at(-1);
    expect(last).toMatchObject({
      type: "error",
      card: { kind: "limit-notice", reason: "daily-reasoning" },
    });
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-1",
      expect.any(String),
      "ERROR",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("falls back to the rule-based parser when the model fails before any output", async () => {
    submit.mockResolvedValue({ status: "PLANNED", commandId: "cmd-1" });
    const { model } = scriptedModel([{ fail: new Error("boom") }]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ existingCommandId: "cmd-1" }),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "PLANNED" });
  });

  it("does not fall back after a tool already ran", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "t-1",
      dispatched: true,
      requiresApproval: false,
    });
    const { model } = scriptedModel([
      {
        calls: [
          {
            name: "create_task",
            args: { capability: "CREATE_COPY", taskBrief: "x" },
          },
        ],
      },
      { fail: new Error("stream died") },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "FAILED" });
  });

  it("lets read tools run freely without using up the one work action", async () => {
    taskFindMany.mockResolvedValue([
      {
        title: "Post",
        capability: "CREATE_COPY",
        status: "DONE",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
    ]);
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "t-1",
      dispatched: true,
      requiresApproval: false,
    });
    const { model, requests } = scriptedModel([
      { calls: [{ name: "get_recent_tasks", args: {} }] },
      { calls: [{ name: "get_recent_tasks", args: {} }] },
      {
        calls: [
          {
            name: "create_task",
            args: { capability: "CREATE_COPY", taskBrief: "x" },
          },
        ],
      },
      { text: ["Kuyrukta."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(taskFindMany).toHaveBeenCalledTimes(2);
    expect(taskFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1" } }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "PLANNED" });
    // The lookup result reached the model.
    const outputs = requests[1]!.input.filter(
      (item) => "type" in item && item.type === "function_call_output",
    );
    expect(JSON.stringify(outputs)).toContain("CREATE_COPY");
  });

  it("emits suggestions before done", async () => {
    const { model } = scriptedModel([
      {
        text: ["Hazır."],
        calls: [
          {
            name: "suggest_replies",
            args: { suggestions: ["Haftayı planla", "Yeni fikir ver"] },
          },
        ],
      },
      { text: [] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));
    const types = events.map((e) => e.type);

    expect(events.find((e) => e.type === "suggestions")).toEqual({
      type: "suggestions",
      items: ["Haftayı planla", "Yeni fikir ver"],
    });
    expect(types.indexOf("suggestions")).toBeLessThan(types.indexOf("done"));
  });

  it("offers the hosted web_search tool only when enabled", async () => {
    const off = scriptedModel([{ text: ["a"] }]);
    await collect(runChatAgent(baseInput, { model: off.model }));
    expect(off.requests[0]!.tools.some((t) => t.type === "web_search")).toBe(
      false,
    );

    envOverrides.CHAT_WEB_SEARCH = true;
    const on = scriptedModel([{ text: ["b"] }]);
    await collect(runChatAgent(baseInput, { model: on.model }));
    expect(on.requests[0]!.tools.some((t) => t.type === "web_search")).toBe(
      true,
    );
  });

  it("drafts a plan card that keeps the model's words and replaces older drafts", async () => {
    const day = new Date(Date.now() + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const plan = {
      title: "Bu hafta",
      items: [
        {
          date: day,
          platform: "INSTAGRAM",
          format: "Reel",
          topic: "Lansman",
          captionIdea: "Sahne arkası",
        },
      ],
    };
    const { model } = scriptedModel([
      {
        text: ["Planı çıkardım."],
        calls: [{ name: "propose_content_plan", args: plan }],
      },
      { text: ["Kaydedebilir ya da değişiklik isteyebilirsin."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(events.find((e) => e.type === "card")).toMatchObject({
      card: {
        kind: "content-plan-draft",
        state: "draft",
        items: [{ time: "10:00" }],
      },
    });
    // Older open drafts are looked up (and replaced) for this project only.
    expect(commandFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "proj-1" }),
      }),
    );
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", status: "ANSWERED" });
    expect(attachParsedIntent).toHaveBeenCalledWith(
      "cmd-1",
      { card: expect.objectContaining({ kind: "content-plan-draft" }) },
      "proj-1",
      "brand-1",
    );
    // Planning is not a work action: a task can still follow in the same turn.
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends bad plan dates back to the model instead of showing a card", async () => {
    const { model, requests } = scriptedModel([
      {
        calls: [
          {
            name: "propose_content_plan",
            args: {
              title: "Eski",
              items: [
                {
                  date: "2020-01-01",
                  platform: "INSTAGRAM",
                  topic: "x",
                  captionIdea: "y",
                },
              ],
            },
          },
        ],
      },
      { text: ["Tarihleri düzeltiyorum."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(events.some((e) => e.type === "card")).toBe(false);
    expect(JSON.stringify(requests[1]!.input)).toContain("in the past");
  });

  it("opens the planning wizard with live connections and the brand focus", async () => {
    const { model } = scriptedModel([
      {
        text: ["Planı birkaç tıkla netleştirelim."],
        calls: [{ name: "start_plan_brief", args: {} }],
      },
    ]);
    const events = await collect(
      runChatAgent({ ...baseInput, message: "haftalık plan yap" }, { model }),
    );

    expect(events.find((e) => e.type === "card")).toMatchObject({
      card: {
        kind: "plan-brief",
        projectId: "proj-1",
        theme: "Kommo CRM",
        connections: { instagram: { connected: true, accountLabel: "@acme" } },
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ANSWERED" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("holds the plan to the wizard's brief and shows connections on the card", async () => {
    const briefMessage = serializePlanBrief({
      goal: "leads",
      channels: [{ channel: "instagram", formats: ["instagram.carousel"] }],
      perWeek: 3,
      weeks: 1,
      start: day(1),
      theme: undefined,
    });
    const item = (channel: string, formatKey: string) => ({
      date: day(2),
      channel,
      formatKey,
      topic: "Konu",
      captionIdea: "Fikir",
    });

    // First attempt strays outside the brief (a blog article): sent back.
    const stray = scriptedModel([
      {
        calls: [
          {
            name: "propose_content_plan",
            args: { title: "Plan", items: [item("seo", "seo.article")] },
          },
        ],
      },
      { text: ["Brief'e uyuyorum."] },
    ]);
    const strayEvents = await collect(
      runChatAgent(
        { ...baseInput, message: briefMessage },
        { model: stray.model },
      ),
    );
    expect(strayEvents.some((e) => e.type === "card")).toBe(false);
    expect(JSON.stringify(stray.requests[1]!.input)).toContain(
      "not in the client's brief",
    );

    // A plan that follows it becomes the card, tagged with goal + connections.
    const ok = scriptedModel([
      {
        calls: [
          {
            name: "propose_content_plan",
            args: {
              title: "Plan",
              items: [item("instagram", "instagram.carousel")],
            },
          },
        ],
      },
      { text: ["Hazır."] },
    ]);
    const okEvents = await collect(
      runChatAgent(
        { ...baseInput, message: briefMessage },
        { model: ok.model },
      ),
    );
    expect(okEvents.find((e) => e.type === "card")).toMatchObject({
      card: {
        kind: "content-plan-draft",
        goal: "leads",
        connections: { instagram: { connected: true } },
        items: [
          {
            channel: "instagram",
            formatKey: "instagram.carousel",
            platform: "INSTAGRAM",
          },
        ],
      },
    });
  });

  it("answers a topic-only request with a package card instead of a question", async () => {
    const pkg = {
      topic: "Kommo CRM sağlık turizmi",
      items: [
        {
          id: "post",
          deliverable: "instagram_post",
          title: "Hasta yolculuğu tek ekranda",
          angle: "Dağınık WhatsApp yazışmalarını CRM'e topla",
          contentFormat: "FEED_PORTRAIT",
        },
        {
          id: "seo",
          deliverable: "seo_article",
          title: "Sağlık turizmi için CRM seçimi",
          angle: "Yurt dışı hasta talebini takip et",
        },
      ],
    };
    const { model } = scriptedModel([
      {
        text: ["Üç parçalık bir paket hazırladım."],
        calls: [{ name: "propose_content_package", args: pkg }],
      },
      { text: ["İstemediğini işaretten çıkarabilirsin."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(events.find((e) => e.type === "card")).toMatchObject({
      card: {
        kind: "content-package",
        state: "draft",
        items: [{ id: "post" }, { id: "seo" }],
      },
    });
    // Proposing is not a work action: nothing was queued.
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends an image item without a format back to the model", async () => {
    const { model, requests } = scriptedModel([
      {
        calls: [
          {
            name: "propose_content_package",
            args: {
              topic: "x",
              items: [
                {
                  id: "post",
                  deliverable: "instagram_post",
                  title: "t",
                  angle: "a",
                },
              ],
            },
          },
        ],
      },
      { text: ["Formatı ekliyorum."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(events.some((e) => e.type === "card")).toBe(false);
    expect(JSON.stringify(requests[1]!.input)).toContain("needs contentFormat");
  });

  it("renders an image inline: previews stream while the job runs, then the turn wraps up", async () => {
    const { emitCreativeProgress } =
      await import("@/server/media/creative-progress");
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "task-9",
      dispatched: true,
      requiresApproval: false,
    });
    jobFindFirst.mockResolvedValue({ id: "job-9" });
    taskFindUnique.mockResolvedValue({ riskLevel: "LOW" });
    startExecution.mockImplementation(async () => {
      // The provider (same process) publishes previews while it renders.
      emitCreativeProgress("job-9", {
        type: "partial",
        index: 0,
        dataUrl: "data:image/png;base64,AAA",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      emitCreativeProgress("job-9", {
        type: "partial",
        index: 1,
        dataUrl: "data:image/png;base64,BBB",
      });
      return { status: "COMPLETED", errorMessage: null };
    });

    const { model } = scriptedModel([
      {
        text: ["Hazırlıyorum."],
        calls: [
          {
            name: "generate_image",
            args: {
              imagePrompt: "A clean clinic reception, soft daylight",
              headline: "Büyüme tek kanalla başlamaz.",
              highlight: "başlamaz.",
              caption: "Hasta yolculuğu",
              copy: "Ölçülebilir büyüme",
              platform: "INSTAGRAM",
              contentFormat: "FEED_PORTRAIT",
            },
          },
        ],
      },
      { text: ["Kartta, beğenmezsen değiştiririm."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    // The job is driven here, right away, not left for a worker tick.
    expect(startExecution).toHaveBeenCalledWith("job-9", "LOW");
    // Chat model's own copy is handed to the provider; draft = medium quality.
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        existingCommandId: "cmd-1",
        payloadExtra: {
          preset: {
            caption: "Hasta yolculuğu",
            copy: "Ölçülebilir büyüme",
            imagePrompt: "A clean clinic reception, soft daylight",
            overlay: {
              headline: "Büyüme tek kanalla başlamaz.",
              highlight: "başlamaz.",
            },
          },
          quality: "medium",
        },
      }),
    );

    const types = events.map((e) => e.type);
    const partials = events.filter((e) => e.type === "image.partial");
    expect(partials).toHaveLength(2);
    expect(types.indexOf("image.partial")).toBeGreaterThan(
      types.indexOf("tool.start"),
    );
    expect(types.lastIndexOf("image.partial")).toBeLessThan(
      types.indexOf("tool.end"),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "PLANNED" });
  });

  it("leaves the job to the worker when it already holds the dispatch event", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "task-9",
      dispatched: true,
      requiresApproval: false,
    });
    jobFindFirst.mockResolvedValue({ id: "job-9" });
    taskFindUnique.mockResolvedValue({ riskLevel: "LOW" });
    claimDispatchForInline.mockResolvedValueOnce("worker");
    jobFindUniqueOrThrow.mockResolvedValue({
      status: "COMPLETED",
      errorMessage: null,
    });
    const { model } = scriptedModel([
      {
        calls: [
          {
            name: "generate_image",
            args: {
              imagePrompt: "x",
              caption: "c",
              copy: "d",
              contentFormat: "FEED_PORTRAIT",
            },
          },
        ],
      },
      { text: ["Tamam."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    // The worker runs the provider; starting it here too would generate twice.
    expect(startExecution).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done", status: "PLANNED" });
  });

  it("never renders an Instagram creative before the client picked a format", async () => {
    const { model } = scriptedModel([
      {
        calls: [
          {
            name: "generate_image",
            args: { imagePrompt: "x", caption: "c", copy: "d" },
          },
        ],
      },
      { text: ["Önce formatı seçelim."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    // Nothing was submitted; the app shows the format question itself.
    expect(submit).not.toHaveBeenCalled();
    const card = events.find((e) => e.type === "card");
    expect(card).toMatchObject({ card: { kind: "question" } });
  });

  it("keeps the image textless unless the client wanted a headline", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "task-9",
      dispatched: true,
      requiresApproval: false,
    });
    jobFindFirst.mockResolvedValue({ id: "job-9" });
    taskFindUnique.mockResolvedValue({ riskLevel: "LOW" });
    startExecution.mockResolvedValue({
      status: "COMPLETED",
      errorMessage: null,
    });
    const { model } = scriptedModel([
      {
        calls: [
          {
            name: "generate_image",
            args: {
              imagePrompt: "x",
              caption: "c",
              copy: "d",
              contentFormat: "FEED_PORTRAIT",
            },
          },
        ],
      },
      { text: ["Tamam."] },
    ]);
    await collect(runChatAgent(baseInput, { model }));

    const extra = submit.mock.calls[0]![0].payloadExtra;
    expect(extra.preset.overlay).toBeUndefined();
  });

  it("lets the model read the brand's visual identity before designing", async () => {
    resolveBrandStyleContext.mockResolvedValue({
      logoAssetId: "logo-1",
      visualIdentity: {
        primaryColors: [{ name: "Navy", hex: "#0B1F3A" }],
        secondaryColors: [],
        accentColors: [{ hex: "#2DD4BF" }],
        photographyStyle: "PHOTOGRAPHIC",
        styleRefinement: null,
        moodTags: ["trustworthy", "calm"],
        compositionNotes: null,
        backgroundTone: "DARK",
        alwaysInclude: ["natural light"],
        alwaysAvoid: ["stock smiles"],
        referenceImageAssetId: null,
        template: {
          enabled: true,
          logoPosition: "BOTTOM_RIGHT",
          accentBarEnabled: true,
          accentBarPosition: "BOTTOM",
        },
      },
    });
    const { model, requests } = scriptedModel([
      { calls: [{ name: "get_visual_identity", args: {} }] },
      { text: ["Marka kimliğine göre soruyorum."] },
    ]);
    await collect(runChatAgent(baseInput, { model }));

    expect(resolveBrandStyleContext).toHaveBeenCalledWith("brand-1");
    const seen = JSON.stringify(requests[1]!.input);
    expect(seen).toContain("#0B1F3A");
    expect(seen).toContain("trustworthy");
    expect(seen).toContain("BOTTOM_RIGHT");
  });

  it("asks for high quality only when the client wants a final image", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "task-9",
      dispatched: true,
      requiresApproval: false,
    });
    jobFindFirst.mockResolvedValue({ id: "job-9" });
    taskFindUnique.mockResolvedValue({ riskLevel: "LOW" });
    startExecution.mockResolvedValue({
      status: "COMPLETED",
      errorMessage: null,
    });
    const { model } = scriptedModel([
      {
        calls: [
          {
            name: "generate_image",
            args: {
              imagePrompt: "x",
              headline: "h",
              caption: "c",
              copy: "d",
              quality: "final",
              contentFormat: "FEED_PORTRAIT",
            },
          },
        ],
      },
      { text: ["Tamam."] },
    ]);
    await collect(runChatAgent(baseInput, { model }));
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadExtra: expect.objectContaining({ quality: "high" }),
      }),
    );
  });

  it("does not blame the API key when an execution provider is circuit-broken", async () => {
    submit.mockRejectedValue(
      new AgentelseError(
        "PROVIDER_UNAVAILABLE",
        "No healthy execution provider available for capability CREATE_SOCIAL_CREATIVE (circuit breaker: openai-creative)",
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { model, requests } = scriptedModel([
      {
        calls: [
          {
            name: "generate_image",
            args: {
              imagePrompt: "x",
              headline: "h",
              caption: "c",
              copy: "d",
              contentFormat: "FEED_PORTRAIT",
            },
          },
        ],
      },
      { text: ["Şu an çalıştıramadım."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    // No misleading "AI provider isn't configured" card...
    expect(events.some((e) => e.type === "card")).toBe(false);
    // ...the model is told what really happened, and the turn ends as an error.
    expect(JSON.stringify(requests[1]!.input)).toContain(
      "temporarily unavailable",
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ERROR" });
  });

  it("reports a failed render honestly", async () => {
    submit.mockResolvedValue({
      status: "PLANNED",
      commandId: "cmd-1",
      taskId: "task-9",
      dispatched: true,
      requiresApproval: false,
    });
    jobFindFirst.mockResolvedValue({ id: "job-9" });
    taskFindUnique.mockResolvedValue({ riskLevel: "LOW" });
    startExecution.mockResolvedValue({
      status: "FAILED",
      errorMessage: "content policy",
    });
    const { model, requests } = scriptedModel([
      {
        calls: [
          {
            name: "generate_image",
            args: {
              imagePrompt: "x",
              headline: "h",
              caption: "c",
              copy: "d",
              contentFormat: "FEED_PORTRAIT",
            },
          },
        ],
      },
      { text: ["Görsel üretilemedi."] },
    ]);
    const events = await collect(runChatAgent(baseInput, { model }));

    expect(JSON.stringify(requests[1]!.input)).toContain("image_failed");
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ERROR" });
  });

  it("keeps the partial reply when the client aborts", async () => {
    const controller = new AbortController();
    const { model } = scriptedModel([{ text: ["Yarım kalan "], hang: true }]);
    const gen = runChatAgent(
      { ...baseInput, signal: controller.signal },
      { model },
    );
    const events: ChatStreamEvent[] = [];
    for await (const event of gen) {
      events.push(event);
      if (event.type === "text.delta") controller.abort();
    }

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(recordReply).toHaveBeenCalledWith(
      "cmd-1",
      "Yarım kalan",
      "ANSWERED",
    );
  });
});

// A work session lets one message carry several steps: a larger, still bounded
// allowance (actions, rounds, cost, size, time), the same approvals and gates as
// outside a session, and the message's spend charged to the session.
describe("runChatAgent: work sessions", () => {
  const T0 = new Date("2026-09-30T10:00:00.000Z");
  const liveSession = (overrides: Partial<WorkSession> = {}): WorkSession => {
    const created = createSession(
      { goal: "Autumn campaign", steps: ["Research", "Write", "Render"] },
      T0,
      "rev-1",
    );
    if (!created.ok) throw new Error(created.error);
    return { ...created.session, ...overrides };
  };
  // The project already has a live session when the client's message arrives.
  const withLiveSession = (overrides: Partial<WorkSession> = {}) =>
    buildContext.mockResolvedValue({
      ...context("ACTIVE"),
      workSession: { id: "cmd-s1", session: liveSession(overrides) },
    });

  const startCall = {
    name: "start_work_session",
    args: { goal: "Autumn campaign", steps: ["Research", "Write", "Render"] },
  };
  // Research that needs the live web is queued, never run inside the message,
  // so these tests stay clear of the inline text path (and of mocks earlier
  // tests leave behind for it).
  const task = (n: number) => ({
    name: "create_task",
    args: { capability: "COMPETITOR_RESEARCH", taskBrief: `piece ${n}` },
  });
  const planned = (n = 1) => ({
    status: "PLANNED",
    commandId: "cmd-1",
    taskId: `t-${n}`,
    dispatched: true,
    requiresApproval: false,
  });
  const lookups = (count: number): Round[] =>
    Array.from({ length: count }, () => ({
      calls: [{ name: "get_pending_approvals", args: {} }],
    }));

  // What the model was told about the calls it made, in order.
  const toolOutputs = (requests: ChatModelRequest[]) =>
    requests
      .at(-1)!
      .input.filter((item) => "type" in item && item.type === "function_call_output")
      .map((item) => JSON.parse((item as unknown as { output: string }).output));
  const reply = (events: ChatStreamEvent[]) => {
    const done = events.at(-1);
    return done?.type === "done" ? done.reply : "";
  };
  const developerNote = (requests: ChatModelRequest[]) =>
    String((requests[0]!.input[0] as { content: string }).content);

  beforeEach(() => {
    startSession.mockResolvedValue({
      status: "STARTED",
      id: "cmd-s1",
      session: liveSession(),
    });
    updateSession.mockResolvedValue({
      status: "UPDATED",
      session: liveSession(),
      ended: null,
      ignored: [],
    });
  });

  describe("what a message may do", () => {
    it("carries several actions once it has opened a session", async () => {
      submit.mockResolvedValue(planned());
      const { model, requests } = scriptedModel([
        { text: ["Plan hazır."], calls: [startCall] },
        { calls: [task(1)] },
        { calls: [task(2)] },
        { calls: [task(3)] },
        { text: ["Hepsi hazır."] },
      ]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(startSession).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(toolOutputs(requests))).not.toContain(
        "Only one action",
      );
      expect(events.at(-1)).toMatchObject({ type: "done", status: "PLANNED" });
    });

    it("gives a message that continues an open session its allowance from the start", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model } = scriptedModel([
        { calls: [task(1), task(2)] },
        { text: ["Devam ettim."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(startSession).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(2);
    });

    it("still stops at its action limit", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model, requests } = scriptedModel([
        {
          calls: Array.from({ length: 8 }, (_, i) => task(i + 1)),
        },
        { text: ["Bir kısmı hazır."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      // Six actions run; the seventh and eighth are turned back.
      expect(submit).toHaveBeenCalledTimes(6);
      expect(JSON.stringify(toolOutputs(requests))).toContain(
        "limit of 6 actions",
      );
    });

    it("does not run the exact same action twice", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model, requests } = scriptedModel([
        { calls: [task(1), task(1)] },
        { text: ["Tamam."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(submit).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(toolOutputs(requests))).toContain(
        "already ran in this message",
      );
    });

    it("is unchanged for an ordinary message: still one action", async () => {
      submit.mockResolvedValue(planned());
      const { model, requests } = scriptedModel([
        { calls: [task(1), task(2)] },
        { text: ["Tamam."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(submit).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(toolOutputs(requests))).toContain(
        "Only one action per message",
      );
    });

    it("keeps looking things up as often as it needs", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model } = scriptedModel([
        { calls: [task(1)] },
        { calls: [{ name: "get_pending_approvals", args: {} }] },
        { calls: [{ name: "get_pending_approvals", args: {} }] },
        { calls: [task(2)] },
        { text: ["Tamam."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(submit).toHaveBeenCalledTimes(2);
    });
  });

  describe("decisions on the client's behalf", () => {
    it("are not made after other work in the same message", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model, requests } = scriptedModel([
        {
          calls: [task(1), { name: "decide_approval", args: { decision: "APPROVE" } }],
        },
        { text: ["Onaylamadım."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      // Only the task reached CommandService; the approval never did.
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]![0].intent.kind).toBe("CAPABILITY");
      expect(JSON.stringify(toolOutputs(requests))).toContain("first action");
    });

    it("can come first, with the work after it", async () => {
      withLiveSession();
      submit
        .mockResolvedValueOnce({
          status: "APPROVAL_HANDLED",
          commandId: "cmd-1",
          approvalId: "a-1",
        })
        .mockResolvedValueOnce(planned());
      const { model } = scriptedModel([
        {
          calls: [{ name: "decide_approval", args: { decision: "APPROVE" } }, task(1)],
        },
        { text: ["Onayladım, devam ettim."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(submit).toHaveBeenCalledTimes(2);
      expect(submit.mock.calls[0]![0].intent.kind).toBe("APPROVAL_DECISION");
    });

    it("cannot start a long paid job after other work either", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model, requests } = scriptedModel([
        { calls: [task(1), { name: "start_deep_enrichment", args: {} }] },
        { text: ["Başlatmadım."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(JSON.stringify(toolOutputs(requests))).toContain("first action");
    });
  });

  describe("model rounds", () => {
    it("an ordinary message stops after six, without a word about it", async () => {
      const { model, requests } = scriptedModel(lookups(9));

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(requests).toHaveLength(6);
      expect(reply(events)).not.toContain("I stopped here");
    });

    it("a session message goes on much longer", async () => {
      withLiveSession();
      const { model, requests } = scriptedModel([
        ...lookups(11),
        { text: ["Hepsi bitti."] },
      ]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(requests).toHaveLength(12);
      expect(reply(events)).toBe("Hepsi bitti.");
    });

    it("but not forever: it stops at its round limit and says how to go on", async () => {
      withLiveSession();
      const { model, requests } = scriptedModel(lookups(40));

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(requests).toHaveLength(24);
      expect(reply(events)).toContain("step limit");
      expect(reply(events)).toContain("continue");
      expect(events.at(-1)).toMatchObject({ type: "done" });
    });

    it("counts every extra round on the project's daily limit", async () => {
      withLiveSession();
      const { model } = scriptedModel([...lookups(3), { text: ["Bitti."] }]);

      await collect(runChatAgent(baseInput, { model }));

      // The gate for the message, then one per extra round (three).
      const rounds = checkAndIncrement.mock.calls.filter(
        (call) => call[1] === "reasoningCalls" && call[2] === undefined,
      );
      expect(rounds).toHaveLength(4);
    });

    it("ends with the daily limit as a plain notice, not an error", async () => {
      withLiveSession();
      checkAndIncrement
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new AgentelseError("BUDGET_EXCEEDED", "cap", {
            meta: { limit: "maxReasoningCallsPerDay" },
          }),
        );
      const { model, requests } = scriptedModel(lookups(6));

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(requests).toHaveLength(2);
      expect(reply(events)).toContain("today's AI limit");
      expect(events.some((e) => e.type === "error")).toBe(false);
    });
  });

  describe("cost and size", () => {
    it("stops before the next action once the message has cost its ceiling", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model } = scriptedModel([
        {
          text: ["Başlıyorum."],
          calls: [task(1)],
          // $2 at this model's price, over the $1.50 ceiling of one message.
          inputTokens: 2_000_000,
          outputTokens: 0,
        },
        { text: ["never reached"] },
      ]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(submit).not.toHaveBeenCalled();
      expect(reply(events)).toContain("Başlıyorum.");
      expect(reply(events)).toContain("cost limit");
      expect(reply(events)).toContain("continue");
    });

    it("names the session's budget when that is what ran out", async () => {
      withLiveSession({ spentUsd: 4.95 });
      submit.mockResolvedValue(planned());
      const { model } = scriptedModel([
        { calls: [task(1)], inputTokens: 200_000, outputTokens: 0 },
      ]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(submit).not.toHaveBeenCalled();
      expect(reply(events)).toContain("session's budget is used up");
    });

    it("stops when the conversation has grown too large to resend", async () => {
      withLiveSession();
      submit.mockResolvedValue(planned());
      const { model } = scriptedModel([
        { calls: [task(1)], inputTokens: 150_000, outputTokens: 0 },
      ]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(submit).not.toHaveBeenCalled();
      expect(reply(events)).toContain("grown too long");
    });

    it("does not cut a final answer short: a message that is done is done", async () => {
      withLiveSession();
      const { model } = scriptedModel([
        { text: ["Hepsi hazır."], inputTokens: 2_000_000, outputTokens: 0 },
      ]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(reply(events)).toBe("Hepsi hazır.");
    });

    it("puts no ceiling on an ordinary message", async () => {
      submit.mockResolvedValue(planned());
      const { model } = scriptedModel([
        { calls: [task(1)], inputTokens: 5_000_000, outputTokens: 0 },
        { text: ["Kuyrukta."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  describe("the session's spend", () => {
    it("is charged to the session the message continued", async () => {
      withLiveSession();
      const { model } = scriptedModel([
        { text: ["Tamam."], inputTokens: 1_000_000, outputTokens: 100_000 },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      // $1 per million in, $6 per million out at this model's price.
      expect(addSessionSpend).toHaveBeenCalledWith(
        { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" },
        "cmd-s1",
        expect.closeTo(1.6, 5),
      );
    });

    it("is charged to a session the message opened", async () => {
      const { model } = scriptedModel([
        { calls: [startCall] },
        { text: ["Plan hazır."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(addSessionSpend).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "proj-1" }),
        "cmd-s1",
        expect.any(Number),
      );
    });

    it("is still charged when the client stops the message", async () => {
      withLiveSession();
      const controller = new AbortController();
      const { model } = scriptedModel([{ text: ["Yarım "], hang: true }]);
      for await (const event of runChatAgent(
        { ...baseInput, signal: controller.signal },
        { model },
      )) {
        if (event.type === "text.delta") controller.abort();
      }

      expect(addSessionSpend).toHaveBeenCalledWith(
        expect.anything(),
        "cmd-s1",
        expect.any(Number),
      );
    });

    it("is not charged anywhere when there is no session", async () => {
      const { model } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      expect(addSessionSpend).not.toHaveBeenCalled();
    });

    it("never gets in the way of the reply if charging fails", async () => {
      withLiveSession();
      addSessionSpend.mockRejectedValue(new Error("db down"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { model } = scriptedModel([{ text: ["Tamam."] }]);

      const events = await collect(runChatAgent(baseInput, { model }));

      expect(events.at(-1)).toMatchObject({ type: "done", reply: "Tamam." });
      spy.mockRestore();
    });
  });

  describe("outside content", () => {
    it("keeps a session from being planned after a web search", async () => {
      const { model, requests } = scriptedModel([
        { output: [{ type: "web_search_call" }], calls: [startCall] },
        { text: ["Planı senin sözlerinle yapalım."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      expect(startSession).not.toHaveBeenCalled();
      expect(JSON.stringify(toolOutputs(requests))).toContain(
        "blocked_external_content",
      );
    });

    it("lets a session already open keep track of progress", async () => {
      withLiveSession();
      const { model, requests } = scriptedModel([
        {
          output: [{ type: "web_search_call" }],
          calls: [
            {
              name: "update_work_session",
              args: { stepId: "s1", status: "DONE", note: "from the web" },
            },
          ],
        },
        { text: ["Not aldım."] },
      ]);

      await collect(runChatAgent(baseInput, { model }));

      // Reaches the store, told that this message may not write words.
      expect(updateSession).toHaveBeenCalledTimes(1);
      expect(updateSession.mock.calls[0]![2]).toMatchObject({ freeText: false });
      expect(JSON.stringify(toolOutputs(requests))).not.toContain(
        "blocked_external_content",
      );
    });
  });

  describe("what the model is told", () => {
    it("shows the open session's goal and steps, as data", async () => {
      withLiveSession();
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      const note = developerNote(requests);
      expect(note).toContain("Open work session");
      expect(note).toContain('"goal":"Autumn campaign"');
      expect(note).toContain('"title":"Research"');
      expect(note).not.toContain("rev-1");
    });

    it("says nothing about a session when there is none", async () => {
      const { model, requests } = scriptedModel([{ text: ["Merhaba"] }]);

      await collect(runChatAgent(baseInput, { model }));

      expect(developerNote(requests)).not.toContain("Open work session");
    });

    it("offers the two session tools while the project is active, and neither on hold", async () => {
      const active = scriptedModel([{ text: ["a"] }]);
      await collect(runChatAgent(baseInput, { model: active.model }));
      const offered = (active.requests[0]!.tools as { name?: string }[]).map(
        (t) => t.name,
      );
      expect(offered).toEqual(
        expect.arrayContaining(["start_work_session", "update_work_session"]),
      );

      buildContext.mockResolvedValue(context("ON_HOLD"));
      commandCreate.mockResolvedValue({ id: "cmd-2" });
      const hold = scriptedModel([{ text: ["b"] }]);
      await collect(runChatAgent(baseInput, { model: hold.model }));
      const heldOffered = (hold.requests[0]!.tools as { name?: string }[]).map(
        (t) => t.name,
      );
      expect(heldOffered).not.toContain("start_work_session");
      expect(heldOffered).not.toContain("update_work_session");
    });
  });

  it("counts a message that only kept the checkpoint as a received command", async () => {
    withLiveSession();
    const { model } = scriptedModel([
      {
        calls: [
          {
            name: "update_work_session",
            args: { stepId: "s1", status: "IN_PROGRESS" },
          },
        ],
      },
      { text: ["Başladım."] },
    ]);

    await collect(runChatAgent(baseInput, { model }));

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "command.received" }),
    );
  });
});
