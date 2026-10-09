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

import { recordUsage } from "@/server/billing/usage-recorder";
import { priceReasoningCall } from "@/server/reasoning/reasoning-pricing";

const { runOpenAIStructuredWithSearch, runOpenAITextWithSearch } =
  await import("./openai-search-client");

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

describe("runOpenAITextWithSearch", () => {
  const textInput = {
    model: "gpt-5.6-luna",
    system: "system prompt",
    user: "user prompt",
    maxOutputTokens: 4_000,
  };

  it("asks for free text with the hosted web search tool, statelessly and without a schema", async () => {
    create.mockResolvedValue(response({ output_text: "  a sourced report  " }));

    await runOpenAITextWithSearch(textInput);

    expect(create).toHaveBeenCalledWith({
      model: "gpt-5.6-luna",
      instructions: "system prompt",
      input: "user prompt",
      tools: [{ type: "web_search" }],
      max_output_tokens: 4_000,
      store: false,
      reasoning: { effort: "low" },
    });
  });

  it("returns the trimmed report, token counts and how many searches ran", async () => {
    create.mockResolvedValue(response({ output_text: "  a sourced report  " }));

    await expect(runOpenAITextWithSearch(textInput)).resolves.toEqual({
      text: "a sourced report",
      inputTokens: 1_200,
      outputTokens: 340,
      webSearchCalls: 2,
    });
  });

  it("retries once with a bigger budget when the report was cut off", async () => {
    create
      .mockResolvedValueOnce(
        response({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output_text: "",
        }),
      )
      .mockResolvedValueOnce(response({ output_text: "full report" }));

    const result = await runOpenAITextWithSearch(textInput);

    expect(create.mock.calls.map((call) => call[0].max_output_tokens)).toEqual([
      4_000, 8_000,
    ]);
    expect(result.text).toBe("full report");
  });

  it("throws when the model returns no text", async () => {
    create.mockResolvedValue(response({ output_text: "   " }));

    await expect(runOpenAITextWithSearch(textInput)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESULT",
    });
  });

  it("sends SDK failures through the shared error mapper", async () => {
    const sdkError = new Error("429 rate limited");
    const mapped = new Error("mapped rate limit");
    create.mockRejectedValue(sdkError);
    toAgentelseError.mockReturnValue(mapped);

    await expect(runOpenAITextWithSearch(textInput)).rejects.toBe(mapped);
    expect(toAgentelseError).toHaveBeenCalledWith(sdkError);
  });
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

// A search call is paid text work: recordUsage hands it to the operation's meter
// (billing/usage-meter.ts) and the meter's cost is what an AI_MICROS operation
// settles (and what the per-task ceiling is measured against). So every Responses
// call, the cut-off one included, must leave a row with its real cost and the
// number of searches the model ran (each is billed on top of tokens). (recordUsage
// is the setup file's stub here; the real one is proven against the ledger in
// billing/meter-wiring.integration.test.ts.)
describe("usage rows handed to the operation meter", () => {
  const rows = () => vi.mocked(recordUsage).mock.calls.map(([row]) => row);

  const calls: [string, () => Promise<unknown>][] = [
    ["runOpenAITextWithSearch", () => runOpenAITextWithSearch(input)],
    [
      "runOpenAIStructuredWithSearch",
      () => runOpenAIStructuredWithSearch(input),
    ],
  ];

  it.each(calls)(
    "%s records one SEARCH row with the real cost and the number of searches",
    async (_name, run) => {
      await run();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        kind: "SEARCH",
        provider: "openai",
        model: "gpt-5.6-luna",
        success: true,
        costEstimated: false,
        inputTokens: 1_200,
        outputTokens: 340,
        webSearchCalls: 2,
      });
      const priced = priceReasoningCall({
        model: "gpt-5.6-luna",
        inputTokens: 1_200,
        outputTokens: 340,
        webSearchCalls: 2,
      }).costUsd;
      expect(rows()[0]!.costUsd).toBeGreaterThan(0);
      expect(rows()[0]!.costUsd).toBeCloseTo(priced, 8);
      // The searches are part of the price, not just the tokens.
      expect(rows()[0]!.costUsd).toBeGreaterThan(
        priceReasoningCall({
          model: "gpt-5.6-luna",
          inputTokens: 1_200,
          outputTokens: 340,
          webSearchCalls: 0,
        }).costUsd,
      );
    },
  );

  it.each(calls)(
    "%s records the cut-off answer too: both calls are billed",
    async (_name, run) => {
      create
        .mockResolvedValueOnce(
          response({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output_text: "",
            output: [{ type: "web_search_call" }],
          }),
        )
        .mockResolvedValueOnce(response());

      await run();

      expect(create).toHaveBeenCalledTimes(2);
      expect(rows().map((row) => row.webSearchCalls)).toEqual([1, 2]);
      expect(rows().every((row) => row.kind === "SEARCH" && row.success)).toBe(
        true,
      );
      expect(rows()[1]!.costUsd).toBeGreaterThan(rows()[0]!.costUsd);
    },
  );

  it.each(calls)(
    "%s records a failed call as a zero-cost row, but not a request the API refused",
    async (_name, run) => {
      create.mockRejectedValueOnce(
        Object.assign(new Error("overloaded"), { status: 503 }),
      );
      await expect(run()).rejects.toThrow("overloaded");
      create.mockRejectedValueOnce(new Error("socket hang up"));
      await expect(run()).rejects.toThrow("socket hang up");
      create.mockRejectedValueOnce(
        Object.assign(new Error("bad request"), { status: 400 }),
      );
      await expect(run()).rejects.toThrow("bad request");

      // The 400 was never billed: no row. The other two may have been.
      expect(rows()).toHaveLength(2);
      expect(rows()[0]).toMatchObject({
        kind: "SEARCH",
        success: false,
        costUsd: 0,
        costEstimated: true,
        errorCode: "503",
      });
      expect(rows()[1]).toMatchObject({
        success: false,
        costUsd: 0,
        errorCode: "NETWORK",
      });
    },
  );
});
