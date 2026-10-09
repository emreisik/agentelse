import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "Max budget per task": once an operation has spent past its cost ceiling, the
// NEXT paid call must not start. Every paid-call client does this check as its
// first act (assertTaskRoom, billing/usage-context.ts), and a client that forgets
// it is a hole in the ceiling nobody would notice. openai-client.test.ts pins one
// of them; this file runs ALL FIVE paid-call sites under a meter that is already
// over its ceiling and proves each one refuses with BUDGET_EXCEEDED / taskCeiling
// without a single request leaving the process (no fetch, no OpenAI SDK call, no
// fal call), and that the very same call does go out while the job is under it.

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-test",
    OPENAI_LITE_MODEL: "gpt-test-mini",
    OPENAI_PRO_MODEL: "gpt-test-pro",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
    FAL_API_KEY: "test-fal-key",
  }),
}));

// The OpenAI SDK is faked: search runs through responses.create, the streamed
// image render through images.generate.
const sdk = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  imagesGenerate: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    responses = { create: sdk.responsesCreate };
    images = { generate: sdk.imagesGenerate };
  },
}));

// The real error mapper needs the SDK's error classes; no call here reaches it.
vi.mock("@/server/chat/openai-chat-client", () => ({
  toAgentelseError: (error: unknown) => error,
}));

const storage = vi.hoisted(() => ({
  putAsset: vi.fn(async (_buffer: Buffer, ext: string) => ({
    storageKey: `r2://fake.${ext}`,
    filename: `fake.${ext}`,
  })),
}));
vi.mock("@/server/storage/asset-storage", () => storage);

vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: { record: vi.fn(async () => ({})) },
}));

import { runWithUsageScope } from "@/server/billing/usage-context";
import { UsageMeter } from "@/server/billing/usage-meter";
import { generateFalImage } from "@/server/reasoning/fal-image-client";
import {
  runOpenAIStructured,
  runOpenAIText,
} from "@/server/reasoning/openai-client";
import { generateOpenAIImage } from "@/server/reasoning/openai-image-client";
import {
  runOpenAIStructuredWithSearch,
  runOpenAITextWithSearch,
} from "@/server/reasoning/openai-search-client";
import { AgentelseError } from "@/server/security/errors";

const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Everything that could leave the process: HTTP (OpenAI Chat Completions, the
// image endpoints, fal.ai) and the OpenAI SDK (search, streamed images).
const outboundCalls = () =>
  fetchMock.mock.calls.length +
  sdk.responsesCreate.mock.calls.length +
  sdk.imagesGenerate.mock.calls.length;

const CEILING = BigInt(1_000);

function meterWith(spentMicros: number): UsageMeter {
  const meter = new UsageMeter({
    workspaceId: "ws-1",
    operationId: "exec:job-1",
    ceilingMicros: CEILING,
  });
  meter.add({
    callId: "earlier-call",
    kind: "TEXT",
    costMicros: BigInt(spentMicros),
    success: true,
  });
  return meter;
}

const overTheCeiling = () => meterWith(1_001);
const underTheCeiling = () => meterWith(1_000);

const inJob = <T>(meter: UsageMeter, run: () => Promise<T>): Promise<T> =>
  runWithUsageScope({ workspaceId: "ws-1", meter }, run);

const textInput = {
  model: "gpt-test",
  system: "sys",
  user: "usr",
  maxOutputTokens: 100,
};
const structuredInput = { ...textInput, jsonSchema: { type: "object" } };

// Chat Completions answers (text and structured).
const completion = (content: string) =>
  jsonResponse(200, {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  });

// A Responses API answer (search variants).
const searchAnswer = (outputText: string) => ({
  status: "completed",
  output_text: outputText,
  output: [{ type: "web_search_call" }],
  usage: { input_tokens: 12, output_tokens: 7 },
});

async function* streamedImage() {
  yield { type: "image_generation.completed", b64_json: ONE_PX_PNG_B64 };
}

// fal.ai's queue: submit, one status poll that is already COMPLETED, the result,
// then the download of the image it names.
const FAL_STATUS_URL =
  "https://queue.fal.run/fal-ai/flux/dev/requests/r1/status";
const FAL_RESPONSE_URL = "https://queue.fal.run/fal-ai/flux/dev/requests/r1";
const FAL_IMAGE_URL = "https://v3.fal.media/files/a.png";
async function falQueue(url: string | URL | Request): Promise<Response> {
  const target = String(url);
  if (target === FAL_STATUS_URL) {
    return jsonResponse(200, { status: "COMPLETED" });
  }
  if (target === FAL_RESPONSE_URL) {
    return jsonResponse(200, {
      images: [{ url: FAL_IMAGE_URL, content_type: "image/png" }],
    });
  }
  if (target === FAL_IMAGE_URL) return new Response(new Uint8Array([1, 2, 3]));
  return jsonResponse(200, {
    request_id: "r1",
    status_url: FAL_STATUS_URL,
    response_url: FAL_RESPONSE_URL,
  });
}

type Site = {
  name: string;
  // Arms the fakes so that the call succeeds when it is allowed to run.
  arm: () => void;
  run: () => Promise<unknown>;
};

const armImageEndpoints = () =>
  fetchMock.mockImplementation(async () =>
    jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
  );

const sites: Site[] = [
  {
    name: "openai-client: runOpenAIText (callOpenAI)",
    arm: () => fetchMock.mockImplementation(async () => completion("a text")),
    run: () => runOpenAIText(textInput),
  },
  {
    name: "openai-client: runOpenAIStructured (callOpenAI)",
    arm: () =>
      fetchMock.mockImplementation(async () => completion('{"answer":"hi"}')),
    run: () => runOpenAIStructured(structuredInput),
  },
  {
    name: "openai-search-client: runOpenAITextWithSearch",
    arm: () => sdk.responsesCreate.mockResolvedValue(searchAnswer("a report")),
    run: () => runOpenAITextWithSearch(textInput),
  },
  {
    name: "openai-search-client: runOpenAIStructuredWithSearch",
    arm: () =>
      sdk.responsesCreate.mockResolvedValue(searchAnswer('{"answer":"hi"}')),
    run: () => runOpenAIStructuredWithSearch(structuredInput),
  },
  {
    name: "openai-image-client: generateOpenAIImage (text to image)",
    arm: armImageEndpoints,
    run: () => generateOpenAIImage("a red apple"),
  },
  {
    name: "openai-image-client: generateOpenAIImage (edit of a picture)",
    arm: armImageEndpoints,
    run: () =>
      generateOpenAIImage("make the sky purple", {
        data: "aGVsbG8=",
        mimeType: "image/png",
      }),
  },
  {
    name: "openai-image-client: generateOpenAIImage (streamed previews)",
    arm: () =>
      sdk.imagesGenerate.mockImplementation(async () => streamedImage()),
    run: () =>
      generateOpenAIImage(
        "a red apple",
        undefined,
        undefined,
        undefined,
        "high",
        () => undefined,
      ),
  },
  {
    name: "fal-image-client: generateFalImage",
    arm: () => fetchMock.mockImplementation(falQueue),
    run: () => generateFalImage("fal-ai/flux/dev", "a red apple"),
  },
];

// [name, site] pairs: the name is the title of every test below.
const siteCases = sites.map((site) => [site.name, site] as const);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  sdk.responsesCreate.mockReset();
  sdk.imagesGenerate.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a job that is over its cost ceiling", () => {
  it.each(siteCases)(
    "%s refuses the next paid call before anything leaves the process",
    async (_name, { arm, run }) => {
      arm();
      const meter = overTheCeiling();
      expect(meter.exceeded).toBe(true);

      const failure = await inJob(meter, run).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AgentelseError);
      expect(failure).toMatchObject({
        code: "BUDGET_EXCEEDED",
        meta: { limit: "taskCeiling" },
      });
      expect(outboundCalls()).toBe(0);
    },
  );
});

// The same fakes and the same calls, one micro-USD under the line: this is what
// keeps "nothing was sent" above from being true merely because the fakes were
// never wired to the clients.
describe("a job that is still within its cost ceiling", () => {
  it.each(siteCases)("%s goes out normally", async (_name, { arm, run }) => {
    arm();
    const meter = underTheCeiling();
    expect(meter.exceeded).toBe(false);

    await inJob(meter, run);

    expect(outboundCalls()).toBeGreaterThan(0);
  });
});

describe("the retries of one call are paid calls too", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("openai-client: an attempt that finds the ceiling crossed meanwhile is not sent", async () => {
    const meter = underTheCeiling();
    // The first attempt meets a transient 503. While it waits to be retried
    // another paid call of the same job finishes and the job crosses its ceiling:
    // the retry is a paid call and must not start.
    fetchMock
      .mockImplementationOnce(async () => {
        meter.add({
          callId: "concurrent-call",
          kind: "TEXT",
          costMicros: BigInt(500),
          success: true,
        });
        return jsonResponse(503, { error: { message: "overloaded" } });
      })
      .mockImplementation(async () => completion("a text"));

    const run = inJob(meter, () => runOpenAIText(textInput)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    const failure = await run;

    expect(failure).toMatchObject({
      code: "BUDGET_EXCEEDED",
      meta: { limit: "taskCeiling" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
