import { beforeEach, describe, expect, it, vi } from "vitest";

// The OpenAI SDK is faked: this suite pins down OUR side of the contract for
// structured reasoning with live web search: what we send (stateless, the
// hosted web_search tool, the caller's schema), what we hand back (parsed JSON,
// token counts, how many searches ran), and the ways it can go wrong.

const envState = vi.hoisted(() => ({ key: "test-key" as string | undefined }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ OPENAI_API_KEY: envState.key }),
}));

const create = vi.fn();
vi.mock("openai", () => {
  class OpenAI {
    responses = { create };
  }
  return { default: OpenAI };
});

// The real mapper needs the SDK's error classes; here it just passes through,
// so the test can see that OUR code routes failures through it.
const toAgentelseError = vi.fn((error: unknown) => error);
vi.mock("@/server/chat/openai-chat-client", () => ({ toAgentelseError }));

const { runOpenAIStructuredWithSearch } = await import(
  "./openai-search-client"
);

const schema = { type: "object", properties: { value: { type: "string" } } };

const input = {
  model: "gpt-5.6-luna",
  system: "system prompt",
  user: "user prompt",
  jsonSchema: schema,
  maxOutputTokens: 4_000,
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    output_text: JSON.stringify({ value: "ok" }),
    output: [
      { type: "web_search_call" },
      { type: "message" },
      { type: "web_search_call" },
    ],
    usage: { input_tokens: 1_200, output_tokens: 340 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  envState.key = "test-key";
  toAgentelseError.mockImplementation((error: unknown) => error);
  create.mockResolvedValue(response());
});

describe("runOpenAIStructuredWithSearch", () => {
  it("asks for the caller's schema with the hosted web search tool, statelessly", async () => {
    await runOpenAIStructuredWithSearch(input);

    expect(create).toHaveBeenCalledWith({
      model: "gpt-5.6-luna",
      instructions: "system prompt",
      input: "user prompt",
      tools: [{ type: "web_search" }],
      max_output_tokens: 4_000,
      store: false,
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "reasoning_output",
          schema,
          strict: false,
        },
      },
    });
  });

  it("returns the parsed answer, the token counts and how many searches ran", async () => {
    await expect(runOpenAIStructuredWithSearch(input)).resolves.toEqual({
      raw: { value: "ok" },
      inputTokens: 1_200,
      outputTokens: 340,
      webSearchCalls: 2,
    });
  });

  it("reports zero searches when the model answered without searching", async () => {
    create.mockResolvedValue(response({ output: [{ type: "message" }] }));

    await expect(runOpenAIStructuredWithSearch(input)).resolves.toMatchObject({
      webSearchCalls: 0,
    });
  });

  it.each(["gpt-5.6-luna", "gpt-5.4-mini", "o4-mini"])(
    "sends a reasoning effort to the reasoning model %s",
    async (model) => {
      await runOpenAIStructuredWithSearch({ ...input, model });
      expect(create.mock.calls[0]![0].reasoning).toEqual({ effort: "low" });
    },
  );

  it("sends no reasoning setting to a model that does not take one", async () => {
    await runOpenAIStructuredWithSearch({ ...input, model: "gpt-4.1" });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("reasoning");
  });

  it("retries once with a bigger budget when the answer was cut off", async () => {
    create
      .mockResolvedValueOnce(
        response({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output_text: '{"value": "trunc',
        }),
      )
      .mockResolvedValueOnce(response());

    const result = await runOpenAIStructuredWithSearch(input);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![0].max_output_tokens).toBe(4_000);
    expect(create.mock.calls[1]![0].max_output_tokens).toBe(8_000);
    expect(result.raw).toEqual({ value: "ok" });
  });

  it("stops doubling at the ceiling instead of retrying forever", async () => {
    create.mockResolvedValue(
      response({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "",
      }),
    );

    await expect(
      runOpenAIStructuredWithSearch({ ...input, maxOutputTokens: 40_000 }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESULT" });

    // 40_000 -> 65_536 (the ceiling), then it gives up.
    expect(create.mock.calls.map((call) => call[0].max_output_tokens)).toEqual([
      40_000, 65_536,
    ]);
  });

  it.each([
    ["no text at all", { output_text: "" }],
    ["only whitespace", { output_text: "   \n " }],
  ])("throws when the model returns %s", async (_label, overrides) => {
    create.mockResolvedValue(response(overrides));

    await expect(runOpenAIStructuredWithSearch(input)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESULT",
    });
  });

  it("throws when the text is not JSON", async () => {
    create.mockResolvedValue(response({ output_text: "Sorry, I could not." }));

    await expect(runOpenAIStructuredWithSearch(input)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESULT",
      message: expect.stringContaining("not valid JSON"),
    });
  });

  it("refuses attachments instead of quietly answering without them", async () => {
    await expect(
      runOpenAIStructuredWithSearch({
        ...input,
        attachments: [{ mimeType: "image/png", data: "AAAA" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESULT" });
    expect(create).not.toHaveBeenCalled();
  });

  it("sends SDK failures through the shared error mapper", async () => {
    const sdkError = new Error("429 rate limited");
    const mapped = new Error("mapped rate limit");
    create.mockRejectedValue(sdkError);
    toAgentelseError.mockReturnValue(mapped);

    await expect(runOpenAIStructuredWithSearch(input)).rejects.toBe(mapped);
    expect(toAgentelseError).toHaveBeenCalledWith(sdkError);
  });

  it("fails clearly when no API key is configured", async () => {
    envState.key = undefined;

    await expect(runOpenAIStructuredWithSearch(input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
