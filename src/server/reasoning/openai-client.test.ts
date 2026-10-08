import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolates the tests from whatever OPENAI_API_KEY the real .env happens to
// have — the client only reads these fields off getEnv().
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-test",
    OPENAI_LITE_MODEL: "gpt-test-mini",
    OPENAI_PRO_MODEL: "gpt-test-pro",
  }),
}));

import { recordUsage } from "@/server/billing/usage-recorder";
import {
  runOpenAIStructured,
  runOpenAIText,
} from "@/server/reasoning/openai-client";
import { isAgentelseError } from "@/server/security/errors";

function openaiResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STRUCTURED_BODY = {
  choices: [
    {
      message: { content: '{"answer":"hello"}' },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7 },
};

const CALL_ARGS = {
  model: "gpt-test",
  system: "sys",
  user: "usr",
  jsonSchema: { type: "object" },
  maxOutputTokens: 100,
};

describe("openai-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("parses schema-formatted JSON output and reports token usage", async () => {
    fetchMock.mockResolvedValue(openaiResponse(200, STRUCTURED_BODY));

    await expect(runOpenAIStructured(CALL_ARGS)).resolves.toEqual({
      raw: { answer: "hello" },
      inputTokens: 12,
      outputTokens: 7,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(false);
    expect(body.max_completion_tokens).toBe(100);
  });

  it("retries a transient 503 and succeeds once OpenAI recovers", async () => {
    fetchMock
      .mockResolvedValueOnce(
        openaiResponse(503, { error: { message: "overloaded" } }),
      )
      .mockResolvedValueOnce(
        openaiResponse(503, { error: { message: "overloaded" } }),
      )
      .mockResolvedValueOnce(openaiResponse(200, STRUCTURED_BODY));

    const promise = runOpenAIStructured(CALL_ARGS);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ raw: { answer: "hello" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the max attempts if OpenAI stays rate-limited", async () => {
    fetchMock.mockResolvedValue(
      openaiResponse(429, { error: { message: "quota exceeded" } }),
    );

    const promise = runOpenAIStructured(CALL_ARGS);
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) && error.code === "PROVIDER_RATE_LIMITED",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry a non-transient error (bad request)", async () => {
    fetchMock.mockResolvedValue(
      openaiResponse(400, { error: { message: "invalid schema" } }),
    );

    await expect(runOpenAIStructured(CALL_ARGS)).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) && error.code === "INVALID_PROVIDER_RESULT",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the finish_reason when non-JSON output isn't a length truncation", async () => {
    fetchMock.mockResolvedValue(
      openaiResponse(200, {
        choices: [
          { message: { content: "not json" }, finish_reason: "content_filter" },
        ],
      }),
    );

    await expect(runOpenAIStructured(CALL_ARGS)).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) &&
        error.code === "INVALID_PROVIDER_RESULT" &&
        error.message.includes("content_filter"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up once the retry ceiling is reached on persistent length truncation", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        openaiResponse(200, {
          choices: [{ message: { content: "{" }, finish_reason: "length" }],
        }),
      ),
    );

    await expect(
      runOpenAIStructured({ ...CALL_ARGS, maxOutputTokens: 40_000 }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) &&
        error.code === "INVALID_PROVIDER_RESULT" &&
        error.message.includes("length"),
    );
    // 40_000 -> 65_536 (capped) is the only doubling step available before
    // the ceiling stops further retries.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a connection-level failure (fetch throwing) and succeeds once it recovers", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(openaiResponse(200, STRUCTURED_BODY));

    const promise = runOpenAIStructured(CALL_ARGS);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ raw: { answer: "hello" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the max attempts on a persistent connection failure", async () => {
    const networkError = new Error("fetch failed");
    fetchMock.mockRejectedValue(networkError);

    const promise = runOpenAIStructured(CALL_ARGS);
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBe(networkError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a length-truncated response with double the token budget and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        openaiResponse(200, {
          choices: [
            {
              message: { content: '{"answer":"unfinis' },
              finish_reason: "length",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        openaiResponse(200, {
          choices: [
            {
              message: { content: '{"answer":"done"}' },
              finish_reason: "stop",
            },
          ],
        }),
      );

    const promise = runOpenAIStructured({
      ...CALL_ARGS,
      maxOutputTokens: 1000,
    });

    await expect(promise).resolves.toMatchObject({ raw: { answer: "done" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(secondBody.max_completion_tokens).toBe(2000);
  });

  it("meters every HTTP call: the truncated first response and the retry each get a row, cached tokens priced at 10%", async () => {
    vi.mocked(recordUsage).mockClear();
    fetchMock
      .mockResolvedValueOnce(
        openaiResponse(200, {
          choices: [
            { message: { content: '{"a":"unfin' }, finish_reason: "length" },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
      )
      .mockResolvedValueOnce(
        openaiResponse(200, {
          choices: [
            { message: { content: '{"a":"ok"}' }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 800,
            prompt_tokens_details: { cached_tokens: 600 },
          },
        }),
      );

    const result = await runOpenAIStructured({
      ...CALL_ARGS,
      model: "gpt-5.6-luna",
      maxOutputTokens: 1000,
    });

    expect(result.cachedTokens).toBe(600);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    const [first, second] = vi
      .mocked(recordUsage)
      .mock.calls.map(([row]) => row);
    // gpt-5.6-luna: $1 in / $6 out per million.
    expect(first).toMatchObject({
      kind: "TEXT",
      provider: "openai",
      success: true,
      costEstimated: false,
      cachedTokens: undefined,
    });
    expect(first!.costUsd).toBeCloseTo(0.001 + 0.003, 8);
    expect(second!.cachedTokens).toBe(600);
    // 400 full-price + 600 cached(10%) input, 800 output.
    expect(second!.costUsd).toBeCloseTo(0.0004 + 0.00006 + 0.0048, 8);
  });

  it("records a connection failure as an estimated zero-cost failed row", async () => {
    vi.mocked(recordUsage).mockClear();
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const promise = runOpenAIStructured(CALL_ARGS);
    const assertion = expect(promise).rejects.toThrow("socket hang up");
    await vi.runAllTimersAsync();
    await assertion;

    expect(recordUsage).toHaveBeenCalledTimes(4);
    expect(vi.mocked(recordUsage).mock.calls[0]![0]).toMatchObject({
      success: false,
      costUsd: 0,
      costEstimated: true,
      errorCode: "NETWORK",
    });
  });

  it("maps attachments to content parts placed before the user text", async () => {
    fetchMock.mockResolvedValue(openaiResponse(200, STRUCTURED_BODY));

    await runOpenAIStructured({
      ...CALL_ARGS,
      attachments: [
        { mimeType: "image/png", data: "aGVsbG8=" },
        { mimeType: "application/pdf", data: "cGRm" },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const content = body.messages[1].content;
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url.url).toBe("data:image/png;base64,aGVsbG8=");
    expect(content[1].type).toBe("file");
    expect(content[2]).toEqual({ type: "text", text: "usr" });
  });
});

describe("runOpenAIText", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const TEXT_ARGS = {
    model: "gpt-test",
    system: "sys",
    user: "usr",
    maxOutputTokens: 100,
  };

  it("returns trimmed plain text and token usage, without a response_format", async () => {
    fetchMock.mockResolvedValue(
      openaiResponse(200, {
        choices: [
          { message: { content: "  hello there  " }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    );

    await expect(runOpenAIText(TEXT_ARGS)).resolves.toEqual({
      text: "hello there",
      inputTokens: 5,
      outputTokens: 3,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.response_format).toBeUndefined();
  });

  it("throws when the model returns no text", async () => {
    fetchMock.mockResolvedValue(
      openaiResponse(200, {
        choices: [
          { message: { content: "" }, finish_reason: "content_filter" },
        ],
      }),
    );

    await expect(runOpenAIText(TEXT_ARGS)).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) &&
        error.code === "INVALID_PROVIDER_RESULT" &&
        error.message.includes("content_filter"),
    );
  });

  it("retries an empty, length-truncated response with double the token budget and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        openaiResponse(200, {
          choices: [{ message: { content: "" }, finish_reason: "length" }],
        }),
      )
      .mockResolvedValueOnce(
        openaiResponse(200, {
          choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        }),
      );

    await expect(runOpenAIText(TEXT_ARGS)).resolves.toMatchObject({
      text: "hello",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(secondBody.max_completion_tokens).toBe(200);
  });

  it("gives up once the retry ceiling is reached on persistent empty length truncation", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        openaiResponse(200, {
          choices: [{ message: { content: "" }, finish_reason: "length" }],
        }),
      ),
    );

    await expect(
      runOpenAIText({ ...TEXT_ARGS, maxOutputTokens: 40_000 }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) &&
        error.code === "INVALID_PROVIDER_RESULT" &&
        error.message.includes("length"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
