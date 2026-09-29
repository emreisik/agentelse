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
vi.mock("@/server/brand-twin/brand-twin", () => ({
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

const submit = vi.fn();
vi.mock("@/server/commands/command-service", () => ({
  CommandService: { submit },
}));

vi.mock("@/server/actions/agency-setup-actions", () => ({
  startAgencySetupForProject: vi.fn().mockResolvedValue({ ok: true }),
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
        output: [],
        functionCalls: (round.calls ?? []).map((call, i) => ({
          callId: `call-${index}-${i}`,
          name: call.name,
          arguments: JSON.stringify(call.args),
        })),
        inputTokens: 100,
        outputTokens: 20,
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

function context(setupPhase: "NOT_STARTED" | "IN_PROGRESS" | "ACTIVE") {
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
    setupPhase,
    setupWaiting: undefined,
  };
}

const text = (events: ChatStreamEvent[]) =>
  events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(envOverrides)) delete envOverrides[key];
  buildContext.mockResolvedValue(context("ACTIVE"));
  commandCreate.mockResolvedValue({ id: "cmd-1" });
  checkAndIncrement.mockResolvedValue(undefined);
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

  it("only offers tools allowed in the current setup phase", async () => {
    buildContext.mockResolvedValue(context("NOT_STARTED"));
    const { model, requests } = scriptedModel([
      {
        calls: [
          {
            name: "create_task",
            args: { capability: "CREATE_COPY", taskBrief: "x" },
          },
        ],
      },
      { text: ["Önce markayı tanımam gerekiyor."] },
    ]);
    await collect(runChatAgent(baseInput, { model }));

    const offered = requests[0]!.tools.map((t) => (t as { name: string }).name);
    expect(offered).toContain("start_brand_setup");
    expect(offered).not.toContain("create_task");
    expect(submit).not.toHaveBeenCalled();
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
