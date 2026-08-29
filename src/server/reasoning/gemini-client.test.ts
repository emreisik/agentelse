import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolates the retry behavior from whatever GEMINI_API_KEY the real .env
// happens to have — callGemini only ever reads this one field off getEnv().
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ GEMINI_API_KEY: "test-key" }),
}));

import { runGeminiText } from "@/server/reasoning/gemini-client";
import { isAgentelseError } from "@/server/security/errors";

function geminiResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TEXT_BODY = {
  candidates: [{ content: { parts: [{ text: "hello" }] } }],
};

const CALL_ARGS = {
  model: "gemini-test",
  system: "sys",
  user: "usr",
  maxOutputTokens: 100,
};

describe("gemini-client transient error retry", () => {
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

  it('retries a 503 ("high demand") and succeeds once Gemini recovers', async () => {
    fetchMock
      .mockResolvedValueOnce(
        geminiResponse(503, { error: { message: "The model is overloaded" } }),
      )
      .mockResolvedValueOnce(
        geminiResponse(503, { error: { message: "The model is overloaded" } }),
      )
      .mockResolvedValueOnce(geminiResponse(200, TEXT_BODY));

    const promise = runGeminiText(CALL_ARGS);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ text: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the max attempts if Gemini stays overloaded", async () => {
    fetchMock.mockResolvedValue(
      geminiResponse(503, { error: { message: "The model is overloaded" } }),
    );

    const promise = runGeminiText(CALL_ARGS);
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
      geminiResponse(400, { error: { message: "invalid argument" } }),
    );

    await expect(runGeminiText(CALL_ARGS)).rejects.toSatisfy(
      (error: unknown) =>
        isAgentelseError(error) && error.code === "INVALID_PROVIDER_RESULT",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a connection-level failure (fetch throwing) and succeeds once it recovers", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(geminiResponse(200, TEXT_BODY));

    const promise = runGeminiText(CALL_ARGS);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ text: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the max attempts on a persistent connection failure", async () => {
    const networkError = new Error("fetch failed");
    fetchMock.mockRejectedValue(networkError);

    const promise = runGeminiText(CALL_ARGS);
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBe(networkError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a request timeout and succeeds once it recovers", async () => {
    const timeoutError = new Error("The operation was aborted");
    timeoutError.name = "TimeoutError";
    fetchMock
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(geminiResponse(200, TEXT_BODY));

    const promise = runGeminiText(CALL_ARGS);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ text: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
