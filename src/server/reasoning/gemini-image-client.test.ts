import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    GEMINI_API_KEY: "test-key",
    GEMINI_IMAGE_MODEL: "gemini-3-pro-image",
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

import { generateGeminiImage } from "@/server/reasoning/gemini-image-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const IMAGE_RESPONSE_BODY = {
  candidates: [
    {
      content: {
        parts: [
          { inlineData: { mimeType: "image/png", data: ONE_PX_PNG_B64 } },
        ],
      },
    },
  ],
};

describe("gemini-image-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    putAssetMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates from scratch, picking the nearest supported aspect ratio", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, IMAGE_RESPONSE_BODY));

    const result = await generateGeminiImage("a red apple", undefined, {
      width: 1080,
      height: 1350,
    });

    expect(result).toMatchObject({ provider: "gemini", mimeType: "image/png" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent",
    );
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.imageConfig.aspectRatio).toBe("4:5"); // 1080x1350 ≈ 4:5
    expect(body.contents[0].parts).toEqual([{ text: "a red apple" }]);
  });

  it("sends the base image as inlineData when editing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, IMAGE_RESPONSE_BODY));

    await generateGeminiImage(
      "make the sky purple",
      { data: "aGVsbG8=", mimeType: "image/jpeg" },
      { width: 1024, height: 1024 },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" },
    });
    expect(body.contents[0].parts[1]).toEqual({ text: "make the sky purple" });
  });

  it("uses the reference image when no base image is given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, IMAGE_RESPONSE_BODY));

    await generateGeminiImage(
      "product shot with our logo",
      undefined,
      undefined,
      { data: "bG9nbw==", mimeType: "image/png" },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: "image/png", data: "bG9nbw==" },
    });
  });

  it("returns null and logs on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: "invalid prompt" } }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateGeminiImage("bad prompt")).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns null when the response has no inline image data", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { candidates: [{ content: { parts: [] } }] }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateGeminiImage("empty")).resolves.toBeNull();
    spy.mockRestore();
  });

  it("returns null instead of throwing on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateGeminiImage("x")).resolves.toBeNull();
    spy.mockRestore();
  });
});
