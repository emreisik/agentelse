import { beforeEach, describe, expect, it, vi } from "vitest";

// The OpenAI SDK is faked: this suite pins down OUR side of the contract —
// how Responses API stream events become ChatModelEvents, which request
// options we send (stateless, one tool call at a time, reasoning only for
// reasoning models) and how SDK failures map onto AgentelseError codes.

const envOverrides: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-5.6-luna",
    CHAT_MODEL: "",
    ...envOverrides,
  }),
}));

const create = vi.fn();

vi.mock("openai", () => {
  class APIError extends Error {
    status?: number;
    code?: string | null;
    constructor(status?: number, message = "api error", code?: string) {
      super(message);
      this.status = status;
      this.code = code ?? null;
    }
  }
  class APIUserAbortError extends APIError {}
  class APIConnectionTimeoutError extends APIError {}
  class OpenAI {
    static APIError = APIError;
    static APIUserAbortError = APIUserAbortError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    responses = { create };
  }
  return { default: OpenAI };
});

const { default: OpenAI } = await import("openai");
const { chatModelName, openaiChatModel, toAgentelseError } =
  await import("./openai-chat-client");

import type { ChatModelEvent, ChatModelRequest } from "./types";


// The fake SDK classes take simple (status, message, code) arguments; the
// real constructors have a different signature, hence the loose typing.
type FakeErrorCtor = new (status?: number, message?: string, code?: string) => Error;
const fake = (name: "APIError" | "APIUserAbortError" | "APIConnectionTimeoutError") =>
  OpenAI[name] as unknown as FakeErrorCtor;

async function* events(...items: unknown[]) {
  for (const item of items) yield item;
}

const request: ChatModelRequest = {
  model: "gpt-5.6-luna",
  instructions: "be nice",
  input: [{ role: "user", content: "hi" }],
  tools: [],
  effort: "low",
  maxOutputTokens: 1000,
};

async function drain(req: ChatModelRequest = request) {
  const out: ChatModelEvent[] = [];
  for await (const event of openaiChatModel.stream(req)) out.push(event);
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe("openaiChatModel.stream", () => {
  it("maps text deltas and the completed response (with a function call)", async () => {
    create.mockResolvedValue(
      events(
        { type: "response.output_text.delta", delta: "Merh" },
        { type: "response.output_text.delta", delta: "aba" },
        {
          type: "response.completed",
          response: {
            output: [
              { type: "reasoning", id: "r1" },
              {
                type: "function_call",
                call_id: "call-1",
                name: "create_task",
                arguments: '{"a":1}',
              },
            ],
            usage: { input_tokens: 120, output_tokens: 30 },
          },
        },
      ),
    );

    const out = await drain();

    expect(out.slice(0, 2)).toEqual([
      { type: "text.delta", text: "Merh" },
      { type: "text.delta", text: "aba" },
    ]);
    expect(out[2]).toMatchObject({
      type: "completed",
      functionCalls: [
        { callId: "call-1", name: "create_task", arguments: '{"a":1}' },
      ],
      inputTokens: 120,
      outputTokens: 30,
    });
    // Reasoning + function_call items are handed back verbatim for the
    // next stateless round.
    expect((out[2] as { output: unknown[] }).output).toHaveLength(2);
  });

  it("sends a stateless, single-tool-call, reasoning request", async () => {
    create.mockResolvedValue(
      events({
        type: "response.completed",
        response: { output: [{ type: "message" }], usage: undefined },
      }),
    );
    await drain();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-luna",
        instructions: "be nice",
        store: false,
        stream: true,
        parallel_tool_calls: false,
        reasoning: { effort: "low" },
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 1000,
      }),
      expect.anything(),
    );
  });

  it("omits reasoning options for non-reasoning models", async () => {
    create.mockResolvedValue(
      events({
        type: "response.completed",
        response: { output: [{ type: "message" }] },
      }),
    );
    await drain({ ...request, model: "gpt-4.1" });

    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("reasoning");
    expect(sent).not.toHaveProperty("include");
  });

  it("fails loudly on an incomplete response that produced nothing", async () => {
    create.mockResolvedValue(
      events({
        type: "response.incomplete",
        response: {
          output: [],
          incomplete_details: { reason: "max_output_tokens" },
        },
      }),
    );
    await expect(drain()).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESULT",
    });
  });

  it("turns a response.failed event into a retryable provider error", async () => {
    create.mockResolvedValue(
      events({
        type: "response.failed",
        response: { error: { message: "server_error" } },
      }),
    );
    await expect(drain()).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
    });
  });
});

describe("toAgentelseError", () => {
  const code = (error: unknown) => (error as { code: string }).code;

  it("maps SDK failures onto the codes limitNoticeFromError understands", () => {
    expect(code(toAgentelseError(new (fake("APIUserAbortError"))()))).toBe(
      "CANCELLED",
    );
    expect(code(toAgentelseError(new (fake("APIConnectionTimeoutError"))()))).toBe(
      "TIMEOUT",
    );
    expect(code(toAgentelseError(new (fake("APIError"))(429, "slow down")))).toBe(
      "PROVIDER_RATE_LIMITED",
    );
    expect(code(toAgentelseError(new (fake("APIError"))(503, "down")))).toBe(
      "PROVIDER_RATE_LIMITED",
    );
    expect(code(toAgentelseError(new (fake("APIError"))(401, "bad key")))).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(
      code(toAgentelseError(new (fake("APIError"))(400, "bad request"))),
    ).toBe("INVALID_PROVIDER_RESULT");
  });

  it("treats an exhausted quota as a deployment problem, not a rate limit", () => {
    const error = new (fake("APIError"))(429, "quota", "insufficient_quota");
    expect(code(toAgentelseError(error))).toBe("PROVIDER_UNAVAILABLE");
  });

  it("passes unknown errors through untouched", () => {
    const boom = new Error("boom");
    expect(toAgentelseError(boom)).toBe(boom);
  });
});

describe("chatModelName", () => {
  it("uses CHAT_MODEL when it is a valid id, else OPENAI_MODEL", () => {
    expect(chatModelName()).toBe("gpt-5.6-luna");
    envOverrides.CHAT_MODEL = " gpt-5.4-mini ";
    expect(chatModelName()).toBe("gpt-5.4-mini");
    delete envOverrides.CHAT_MODEL;
  });

  it("ignores a broken .env value instead of sending it to OpenAI", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    envOverrides.CHAT_MODEL = ", CHAT_REASONING_EFFORT=low, CHAT_WEB_SEARCH=false";
    expect(chatModelName()).toBe("gpt-5.6-luna");
    delete envOverrides.CHAT_MODEL;
  });
});
