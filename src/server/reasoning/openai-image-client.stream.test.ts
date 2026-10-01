import { beforeEach, describe, expect, it, vi } from "vitest";

// Streaming text-to-image (partial previews) and its fallback: a stream that
// dies must degrade to the plain single request, never to "no image".

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
  }),
}));

const generate = vi.fn();
vi.mock("openai", () => ({
  default: class {
    images = { generate };
  },
}));

const putAsset = vi.fn(async (_b: Buffer, ext: string) => ({
  storageKey: `r2://fake.${ext}`,
  filename: `fake.${ext}`,
}));
vi.mock("@/server/storage/asset-storage", () => ({ putAsset }));

const record = vi.fn<(input: Record<string, unknown>) => Promise<object>>(
  async () => ({}),
);
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: { record },
}));

const { generateOpenAIImage } = await import("./openai-image-client");

async function* events(...items: unknown[]) {
  for (const item of items) yield item;
}

const FINAL = Buffer.from("final-png").toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("generateOpenAIImage streaming", () => {
  it("forwards each partial preview and stores the final image", async () => {
    generate.mockResolvedValue(
      events(
        { type: "image_generation.partial_image", partial_image_index: 0, b64_json: "P0" },
        { type: "image_generation.partial_image", partial_image_index: 1, b64_json: "P1" },
        { type: "image_generation.completed", b64_json: FINAL },
      ),
    );
    const partials: { index: number; b64: string }[] = [];

    const image = await generateOpenAIImage(
      "a clinic",
      undefined,
      { width: 1080, height: 1350 },
      undefined,
      "medium",
      (p) => partials.push(p),
    );

    expect(partials).toEqual([
      { index: 0, b64: "P0" },
      { index: 1, b64: "P1" },
    ]);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        partial_images: 2,
        quality: "medium",
        size: "1088x1344",
      }),
    );
    expect(putAsset.mock.calls[0]![0].toString()).toBe("final-png");
    expect(image).toMatchObject({ storageKey: "r2://fake.png", provider: "openai" });
  });

  it("falls back to the plain request when the stream fails", async () => {
    generate.mockRejectedValue(new Error("stream unsupported"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: FINAL }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const image = await generateOpenAIImage(
      "a clinic",
      undefined,
      undefined,
      undefined,
      "medium",
      () => undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(image).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("never streams edits / reference-image renders", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: FINAL }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateOpenAIImage(
      "restyle",
      { data: "AAA", mimeType: "image/png" },
      undefined,
      undefined,
      "medium",
      () => undefined,
    );

    expect(generate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it("records the streamed render's spend from the completed event's usage", async () => {
    generate.mockResolvedValue(
      events({
        type: "image_generation.completed",
        b64_json: FINAL,
        usage: {
          input_tokens: 200,
          input_tokens_details: { text_tokens: 200, image_tokens: 0 },
          output_tokens: 1_000,
        },
      }),
    );

    await generateOpenAIImage(
      "a clinic",
      undefined,
      undefined,
      undefined,
      "medium",
      () => undefined,
    );

    expect(record).toHaveBeenCalledTimes(1);
    const row = record.mock.calls[0]![0] as Record<string, number | string>;
    expect(row).toMatchObject({ purpose: "image.generate", outputTokens: 1_000 });
    // 200 text in @ $5/M + 1K image out @ $30/M
    expect(row.costUsd).toBeCloseTo(0.001 + 0.03, 6);
  });

  it("bills once when a dead stream falls back to the plain request", async () => {
    generate.mockRejectedValue(new Error("stream unsupported"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ b64_json: FINAL }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await generateOpenAIImage(
      "a clinic",
      undefined,
      undefined,
      undefined,
      "medium",
      () => undefined,
    );

    expect(record).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
