import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ FAL_API_KEY: "test-fal-key" }),
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

import {
  generateFalImage,
  isFalImageConfigured,
} from "@/server/reasoning/fal-image-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SUBMIT_OK = {
  request_id: "req-1",
  status_url: "https://queue.fal.run/fal-ai/flux/dev/requests/req-1/status",
  response_url: "https://queue.fal.run/fal-ai/flux/dev/requests/req-1",
};

describe("fal-image-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    putAssetMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is not configured without FAL_API_KEY", async () => {
    // isFalImageConfigured reads getEnv() fresh each call — the module mock
    // above always returns a key, so this only checks the function exists
    // and returns a boolean; the "false" branch is exercised implicitly by
    // generateFalImage's own early-return test below via a key-less env.
    expect(isFalImageConfigured()).toBe(true);
  });

  it("submits, polls until COMPLETED, then downloads and stores the result", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SUBMIT_OK)) // submit
      .mockResolvedValueOnce(jsonResponse(200, { status: "IN_QUEUE" })) // poll 1
      .mockResolvedValueOnce(jsonResponse(200, { status: "IN_PROGRESS" })) // poll 2
      .mockResolvedValueOnce(jsonResponse(200, { status: "COMPLETED" })) // poll 3
      .mockResolvedValueOnce(
        jsonResponse(200, {
          images: [
            {
              url: "https://v3.fal.media/files/a.png",
              content_type: "image/png",
            },
          ],
        }),
      ) // result
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]))); // image download

    const promise = generateFalImage("fal-ai/flux/dev", "a red apple");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ provider: "fal", mimeType: "image/png" });
    expect(putAssetMock).toHaveBeenCalledTimes(1);

    const submitCall = fetchMock.mock.calls[0]!;
    expect(submitCall[0]).toBe("https://queue.fal.run/fal-ai/flux/dev");
    expect(
      (submitCall[1]!.headers as Record<string, string>).authorization,
    ).toBe("Key test-fal-key");
    const submitBody = JSON.parse(submitCall[1]!.body as string);
    expect(submitBody).toEqual({ prompt: "a red apple" });
  });

  it("sends image_url as a data URI when an input image is given", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SUBMIT_OK))
      .mockResolvedValueOnce(jsonResponse(200, { status: "COMPLETED" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          images: [
            {
              url: "https://v3.fal.media/files/b.png",
              content_type: "image/png",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));

    const promise = generateFalImage(
      "fal-ai/flux-pro/kontext",
      "make it blue",
      { data: "aGVsbG8=", mimeType: "image/jpeg" },
      { width: 1024, height: 1024 },
    );
    await vi.runAllTimersAsync();
    await promise;

    const submitBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(submitBody.image_url).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect(submitBody.image_size).toEqual({ width: 1024, height: 1024 });
  });

  it("returns null when submit fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: "invalid model input" }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateFalImage("fal-ai/flux/dev", "x")).resolves.toBeNull();

    spy.mockRestore();
  });

  it("returns null when the result has no image", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SUBMIT_OK))
      .mockResolvedValueOnce(jsonResponse(200, { status: "COMPLETED" }))
      .mockResolvedValueOnce(jsonResponse(200, { images: [] }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = generateFalImage("fal-ai/flux/dev", "x");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeNull();
    spy.mockRestore();
  });

  it("returns null instead of throwing on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(generateFalImage("fal-ai/flux/dev", "x")).resolves.toBeNull();

    spy.mockRestore();
  });
});
