import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolates the tests from whatever OPENAI_API_KEY the real .env happens to
// have — the client only reads these fields off getEnv(). Same pattern as
// gemini-client.test.ts.
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-test",
    OPENAI_LITE_MODEL: "gpt-test-mini",
    OPENAI_PRO_MODEL: "gpt-test-pro",
  }),
}));

import { runOpenAIStructured } from "@/server/reasoning/openai-client";
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

  it("surfaces the finish_reason when output is cut off mid-JSON", async () => {
    fetchMock.mockResolvedValue(
      openaiResponse(200, {
        choices: [
          { message: { content: '{"answer":"hel' }, finish_reason: "length" },
        ],
      }),
    );

    await expect(runOpenAIStructured(CALL_ARGS)).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) &&
        error.code === "INVALID_PROVIDER_RESULT" &&
        error.message.includes("length"),
    );
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
