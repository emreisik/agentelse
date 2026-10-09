import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
  }),
}));

const putAssetMock = vi.fn(
  async (buffer: Buffer, ext: string) => ({
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

import { recordUsage } from "@/server/billing/usage-recorder";
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
    vi.mocked(recordUsage).mockClear();
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

  it("sends several reference pictures as the edits endpoint's image[] array, in order", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    await generateOpenAIImage(
      "a post in our design",
      undefined,
      undefined,
      undefined,
      "high",
      undefined,
      [
        { data: "ZXhhbXBsZTE=", mimeType: "image/jpeg" },
        { data: "ZXhhbXBsZTI=", mimeType: "image/png" },
        { data: "cHJvZHVjdA==", mimeType: "image/png" },
      ],
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    const form = init.body as FormData;
    const sent = form.getAll("image[]");
    expect(sent).toHaveLength(3);
    expect((sent[0] as File).type).toBe("image/jpeg");
    expect((sent[0] as File).name).toBe("input-1.jpeg");
    expect((sent[2] as File).name).toBe("input-3.png");
    // The single-picture field is not used next to the array.
    expect(form.get("image")).toBeNull();
  });

  it("one reference picture in the array is sent the single-picture way", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    await generateOpenAIImage("p", undefined, undefined, undefined, "high", undefined, [
      { data: "b25l", mimeType: "image/png" },
    ]);

    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.getAll("image[]")).toHaveLength(0);
  });

  it("an edit keeps its own picture and ignores the reference set", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
    );

    await generateOpenAIImage(
      "make the sky purple",
      { data: "YmFzZQ==", mimeType: "image/png" },
      undefined,
      undefined,
      "high",
      undefined,
      [
        { data: "cmVm", mimeType: "image/png" },
        { data: "cmVmMg==", mimeType: "image/png" },
      ],
    );

    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.getAll("image[]")).toHaveLength(0);
    expect(form.get("image")).toBeInstanceOf(Blob);
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

  // The plan charges an IMAGE right for the pictures the operation's meter counted
  // (billing/operation.ts), and recordUsage hands a call to that meter only as
  // { kind: "IMAGE", success: true, units }. So what this client reports is what a
  // delivered post costs: a drawn picture must come out as exactly one successful
  // unit, a failed attempt as none. (recordUsage is the setup file's stub here; the
  // real one is proven against the ledger in billing/meter-wiring.integration.test.ts.)
  describe("usage rows handed to the operation meter", () => {
    const rows = () => vi.mocked(recordUsage).mock.calls.map(([row]) => row);

    it.each([
      ["a text-to-image render", undefined],
      [
        "an edit of an existing picture",
        { data: "aGVsbG8=", mimeType: "image/jpeg" },
      ],
    ])("counts %s as exactly one drawn picture", async (_label, baseImage) => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
      );

      expect(
        await generateOpenAIImage("a red apple", baseImage),
      ).not.toBeNull();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        kind: "IMAGE",
        provider: "openai",
        model: "gpt-image-2/high",
        success: true,
        units: 1,
      });
      // A billed render: a zero here would let the cost ceiling and the
      // text-only charge see a free picture.
      expect(rows()[0]!.costUsd).toBeGreaterThan(0);
      // The row has to be storable as it is: a NaN duration makes the UsageEntry
      // write fail (the meter would still count the picture).
      expect(rows()[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("prices the row from the usage OpenAI reported, not from the list price", async () => {
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

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        costEstimated: false,
        inputTokens: 1_000,
        outputTokens: 4_000,
      });
      // 1K text in @ $5/M + 4K image out @ $30/M
      expect(rows()[0]!.costUsd).toBeCloseTo(0.005 + 0.12, 6);
    });

    it("counts a render that was billed but could not be stored once, as a drawn picture", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
      );
      putAssetMock.mockRejectedValueOnce(new Error("disk full"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      // The caller gets nothing back (and so hands the right back), but OpenAI
      // billed the render: one success row, not a second "failed" one on top.
      await expect(generateOpenAIImage("a red apple")).resolves.toBeNull();
      spy.mockRestore();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ success: true, units: 1 });
    });

    it.each([
      ["a network error", new Error("network down"), "NETWORK"],
      ["a timeout", new DOMException("timed out", "TimeoutError"), "TIMEOUT"],
    ])(
      "counts %s as a failed attempt that drew nothing",
      async (_label, failure, errorCode) => {
        fetchMock.mockRejectedValue(failure);
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(generateOpenAIImage("a red apple")).resolves.toBeNull();
        spy.mockRestore();

        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({
          kind: "IMAGE",
          provider: "openai",
          success: false,
          units: 0,
          costUsd: 0,
          costEstimated: true,
          errorCode,
        });
      },
    );

    it("never counts a picture for a call the API refused or answered without one", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      fetchMock.mockResolvedValueOnce(
        jsonResponse(500, { error: { message: "boom" } }),
      );
      await expect(generateOpenAIImage("a red apple")).resolves.toBeNull();
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
      await expect(generateOpenAIImage("a red apple")).resolves.toBeNull();
      spy.mockRestore();

      expect(rows().filter((row) => row.success)).toEqual([]);
    });
  });
});
