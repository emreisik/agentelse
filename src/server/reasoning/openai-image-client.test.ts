import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
  }),
}));

const putAssetMock = vi.fn(
  async (buffer: Buffer, ext: string, mimeType: string) => ({
    storageKey: `r2://fake.${ext}`,
    filename: `fake.${ext}`,
  }),
);
vi.mock("@/server/storage/asset-storage", () => ({
  putAsset: (...args: Parameters<typeof putAssetMock>) => putAssetMock(...args),
}));

const recordMock = vi.fn<(input: Record<string, unknown>) => Promise<object>>(
  async () => ({}),
);
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: {
    record: (input: Record<string, unknown>) => recordMock(input),
  },
}));

import { generateOpenAIImage } from "@/server/reasoning/openai-image-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("openai-image-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    putAssetMock.mockClear();
    recordMock.mockClear();
    recordMock.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates from scratch via the JSON generations endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    const result = await generateOpenAIImage("a red apple", undefined, {
      width: 1080,
      height: 1350,
    });

    expect(result).toMatchObject({ provider: "openai", mimeType: "image/png" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "gpt-image-2",
      prompt: "a red apple",
      size: "1088x1344", // nearest multiples of 16 to 1080x1350
      quality: "high",
      n: 1,
    });
  });

  it("sends an explicit lower quality when the caller overrides the default", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    await generateOpenAIImage(
      "a red apple",
      undefined,
      { width: 1024, height: 1024 },
      undefined,
      "medium",
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.quality).toBe("medium");
  });

  it("uses the multipart edits endpoint when a base image is given", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    await generateOpenAIImage(
      "make the sky purple",
      { data: "aGVsbG8=", mimeType: "image/jpeg" },
      { width: 1024, height: 1024 },
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("make the sky purple");
    expect(form.get("quality")).toBe("high");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("falls back to the edits endpoint for a reference-image (logo) generation", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    await generateOpenAIImage(
      "product shot with our logo",
      undefined,
      undefined,
      { data: "bG9nbw==", mimeType: "image/png" },
    );

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/images/edits",
    );
  });

  it("returns null and logs on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: "invalid prompt" } }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateOpenAIImage("bad prompt")).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns null when the response has no image data", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateOpenAIImage("empty")).resolves.toBeNull();
    spy.mockRestore();
  });

  it("returns null instead of throwing on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateOpenAIImage("x")).resolves.toBeNull();
    spy.mockRestore();
  });
  // The header balance is "snapshot minus every gpt-* ReasoningCall", so an
  // unrecorded render is money the balance never sees.
  it("records the render's spend from the real token usage", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ b64_json: ONE_PX_PNG_B64 }],
        usage: {
          input_tokens: 1_000,
          input_tokens_details: { text_tokens: 1_000, image_tokens: 0 },
          output_tokens: 4_000,
        },
      }),
    );

    await generateOpenAIImage("a red apple");

    expect(recordMock).toHaveBeenCalledTimes(1);
    const row = recordMock.mock.calls[0]![0] as Record<string, number | string>;
    expect(row).toMatchObject({
      workspaceId: "system",
      purpose: "image.generate",
      model: "gpt-image-2",
      isMock: false,
      status: "OK",
      inputTokens: 1_000,
      outputTokens: 4_000,
    });
    // 1K text in @ $5/M + 4K image out @ $30/M
    expect(row.costUsd).toBeCloseTo(0.005 + 0.12, 6);
  });

  it("falls back to the per-image price when the response has no usage", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    await generateOpenAIImage("a red apple"); // default quality "high", 1024x1024

    const row = recordMock.mock.calls[0]![0] as Record<string, number>;
    expect(row.costUsd).toBeCloseTo(0.211, 6);
  });

  it("does not record anything when the API fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { error: { message: "boom" } }),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await generateOpenAIImage("a red apple")).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("still returns the image when recording the spend fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );
    recordMock.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await generateOpenAIImage("a red apple")).not.toBeNull();
  });
});
