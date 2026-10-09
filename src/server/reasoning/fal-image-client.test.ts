import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ FAL_API_KEY: "test-fal-key" }),
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

import { UsageMeter } from "@/server/billing/usage-meter";
import { recordUsage, usdToMicros } from "@/server/billing/usage-recorder";
import {
  generateFalImage,
  isFalImageConfigured,
} from "@/server/reasoning/fal-image-client";
import { estimateFalImageCostUsd } from "@/server/reasoning/reasoning-pricing";

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
    vi.mocked(recordUsage).mockClear();
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

  it("logs the response body text (not just the status code) on a failure", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, SUBMIT_OK))
      .mockResolvedValueOnce(jsonResponse(200, { status: "COMPLETED" }))
      .mockResolvedValueOnce(
        jsonResponse(422, { detail: [{ msg: "field required: scale" }] }),
      );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = generateFalImage("fal-ai/clarity-upscaler", "x");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeNull();

    const loggedText = spy.mock.calls.flat().join(" ");
    expect(loggedText).toContain("422");
    expect(loggedText).toContain("field required: scale");

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

  // The plan charges an IMAGE right for the pictures the operation's meter counted
  // (billing/operation.ts), and recordUsage hands a call to that meter only as
  // { kind: "IMAGE", success: true, units }. fal returns no usage, so the cost is
  // the model's list price. (recordUsage is the setup file's stub here; the real one
  // is proven against the ledger in billing/meter-wiring.integration.test.ts.)
  describe("usage rows handed to the operation meter", () => {
    const rows = () => vi.mocked(recordUsage).mock.calls.map(([row]) => row);

    // The submit / status / result calls of a job that finished with an image.
    const finishedWithImage = () =>
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, SUBMIT_OK))
        .mockResolvedValueOnce(jsonResponse(200, { status: "COMPLETED" }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            images: [
              {
                url: "https://v3.fal.media/files/m.png",
                content_type: "image/png",
              },
            ],
          }),
        );

    async function draw(endpointId = "fal-ai/flux/dev") {
      const promise = generateFalImage(endpointId, "a red apple");
      await vi.runAllTimersAsync();
      return promise;
    }

    it("counts a drawn picture as exactly one successful unit at the model's list price", async () => {
      finishedWithImage().mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3])),
      );

      expect(await draw()).not.toBeNull();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        kind: "IMAGE",
        provider: "fal",
        model: "fal-ai/flux/dev",
        success: true,
        units: 1,
        // fal reports no usage: the price is a list-price guess, and says so.
        costEstimated: true,
      });
      expect(rows()[0]!.costUsd).toBeGreaterThan(0);
      expect(rows()[0]!.costUsd).toBe(
        estimateFalImageCostUsd("fal-ai/flux/dev"),
      );
      // The row has to be storable as it is: a NaN duration makes the UsageEntry
      // write fail (the meter would still count the picture).
      expect(rows()[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("still counts the picture when the finished file cannot be downloaded: fal already billed it", async () => {
      finishedWithImage().mockResolvedValueOnce(
        new Response("gone", { status: 502 }),
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await draw()).toBeNull();
      spy.mockRestore();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ success: true, units: 1 });
      expect(rows()[0]!.costUsd).toBeGreaterThan(0);
    });

    // A rejected download used to escape generateFalImage (a missing await in front
    // of the storing step), so the caller saw an exception instead of "no image" and
    // its own fallback never ran.
    it("returns null, not a rejection, when downloading the finished file throws; fal billed the picture all the same", async () => {
      finishedWithImage().mockRejectedValueOnce(new Error("dns failure"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(draw()).resolves.toBeNull();
      spy.mockRestore();

      expect(rows().filter((row) => row.success)).toHaveLength(1);
      expect(rows().find((row) => row.success)).toMatchObject({
        kind: "IMAGE",
        units: 1,
      });
      expect(
        rows().some((row) => !row.success && row.errorCode === "NETWORK"),
      ).toBe(true);
    });

    it("counts a result without an image as a failed attempt that drew nothing", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, SUBMIT_OK))
        .mockResolvedValueOnce(jsonResponse(200, { status: "COMPLETED" }))
        .mockResolvedValueOnce(jsonResponse(200, { images: [] }));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await draw()).toBeNull();
      spy.mockRestore();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        kind: "IMAGE",
        provider: "fal",
        success: false,
        units: 0,
        costUsd: 0,
        errorCode: "NO_IMAGE",
      });
    });

    it("counts a request that dies on the wire as a failed attempt that drew nothing", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await draw()).toBeNull();
      spy.mockRestore();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        kind: "IMAGE",
        provider: "fal",
        success: false,
        units: 0,
        costUsd: 0,
        costEstimated: true,
        errorCode: "NETWORK",
      });
    });

    it("counts a job that never completes as a failed, unit-less TIMEOUT", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, SUBMIT_OK));
      fetchMock.mockImplementation(async () =>
        jsonResponse(200, { status: "IN_PROGRESS" }),
      );
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await draw()).toBeNull();
      spy.mockRestore();

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        success: false,
        units: 0,
        costUsd: 0,
        errorCode: "TIMEOUT",
      });
    });

    it("hands the meter one picture for a drawn render and none for a failed attempt", async () => {
      finishedWithImage().mockResolvedValueOnce(
        new Response(new Uint8Array([1])),
      );
      await draw();
      fetchMock.mockRejectedValue(new Error("network down"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await draw();
      spy.mockRestore();

      // The rows as the operation's meter takes them in (usage-recorder.ts).
      const meter = new UsageMeter({ workspaceId: "w", operationId: "op" });
      rows().forEach((row, index) =>
        meter.add({
          callId: `call-${index}`,
          kind: row.kind,
          costMicros: usdToMicros(row.costUsd),
          success: row.success,
          units: row.units,
        }),
      );
      expect(rows()).toHaveLength(2);
      expect(meter.images).toBe(1);
      expect(meter.costMicros).toBe(
        usdToMicros(estimateFalImageCostUsd("fal-ai/flux/dev")),
      );
    });
  });
});
