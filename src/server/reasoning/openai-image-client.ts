import "server-only";

import OpenAI from "openai";

import { getEnv } from "@/lib/env";
import { getUsageScope } from "@/server/billing/usage-context";
import { recordUsage } from "@/server/billing/usage-recorder";
import {
  estimateImageCostUsd,
  type ImageUsage,
} from "@/server/reasoning/reasoning-pricing";
import { ReasoningCallRepository } from "@/server/repositories/reasoning-call.repository";
import { putAsset } from "@/server/storage/asset-storage";

// OpenAI image generation (gpt-image-2 family) — the app's primary image
// provider (see creative-image.ts, which falls back to OpenClaw if this
// isn't configured or a call fails). Returns null on any failure so callers
// (creative generation, logo) can complete their work without an image
// rather than blowing up the whole job.
//
// Two distinct HTTP shapes depending on the call:
// - Text-to-image (no base/reference image): JSON POST to
//   /v1/images/generations.
// - Editing an existing image, or generating "in the style of" a reference
//   image (the brand logo): multipart POST to /v1/images/edits — gpt-image-2
//   accepts one or more input images this way and treats the first as what
//   to edit/reference.
// GPT image models always return base64 (b64_json), no separate download
// step.

export type ImageQuality = "low" | "medium" | "high" | "auto";

const GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const EDITS_URL = "https://api.openai.com/v1/images/edits";
// Image generation is the slowest call this app makes (high-quality
// gpt-image-2 renders can take well over a minute) — bounded generously so
// a hung request doesn't wedge the caller forever (the same class of bug
// openai-client.ts's FETCH_TIMEOUT_MS was added to fix).
const FETCH_TIMEOUT_MS = 120_000;

export type GeneratedCreativeImage = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  provider: "openai";
};

// A partial (in-progress) preview streamed while the final image renders.
export type ImagePartial = { index: number; b64: string };

let sdkClient: OpenAI | undefined;

// Only the streaming text-to-image path uses the SDK (it parses the SSE for
// us); the non-streaming and edit paths below keep their plain fetch calls.
// No SDK retries: a retried streaming request would re-bill a render the
// caller already saw start.
function getSdkClient(apiKey: string): OpenAI {
  sdkClient ??= new OpenAI({
    apiKey,
    timeout: FETCH_TIMEOUT_MS,
    maxRetries: 0,
  });
  return sdkClient;
}

export function isOpenAIImageConfigured(): boolean {
  return Boolean(getEnv().OPENAI_API_KEY);
}

export function openaiImageModel(): string {
  return getEnv().OPENAI_IMAGE_MODEL;
}

// gpt-image-2 takes an exact "WIDTHxHEIGHT" string (multiples of 16,
// aspect ratio between 1:3 and 3:1, up to ~2048 per side), derived directly
// from the platform's target pixel size. normalizeToTarget still resizes
// the result to the exact target afterward, so perfect precision here
// isn't required, just a reasonably close starting point.
function sizeParam(imageSize?: { width: number; height: number }): string {
  if (!imageSize) return "1024x1024";
  const clamp = (n: number) =>
    Math.min(2048, Math.max(256, Math.round(n / 16) * 16));
  return `${clamp(imageSize.width)}x${clamp(imageSize.height)}`;
}

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string }>;
  usage?: ImageUsage;
  error?: { message?: string };
};

type ImageBilling = {
  model: string;
  quality: ImageQuality;
  size: string;
  startedAt: number;
  // Billed rows written so far (recordImageSpend). An attempt that already
  // wrote its row must not also write a "failed" one when only the storing of
  // the image fails afterwards.
  spendRows: number;
};

// A high-quality render is the dearest thing this app buys, so each one is
// logged with its cost: a UsageEntry (the billing record, kept per workspace
// even after a brand is deleted) and a ReasoningCall for the project's activity
// view. The scope comes from the caller's usage context (usage-context.ts);
// without one the ReasoningCall keeps the old "system" workspace and the
// UsageEntry lands as "unattributed". Never throws: a bookkeeping failure must
// not cost the caller a render OpenAI already billed.
async function recordImageSpend(
  usage: ImageUsage | undefined,
  billing: ImageBilling,
): Promise<void> {
  const scope = getUsageScope();
  const costUsd = estimateImageCostUsd({
    quality: billing.quality,
    size: billing.size,
    usage,
  });
  billing.spendRows += 1;
  await recordUsage({
    kind: "IMAGE",
    provider: "openai",
    // Kalite maliyetin ana sürücüsü (high ≈ 4x medium): raporda görünsün.
    model: `${billing.model}/${billing.quality}`,
    purpose: scope?.purpose ?? "image.generate",
    costUsd,
    // Kullanım döndürmeyen yanıtta kalite başına sabit fiyat kullanılır.
    costEstimated: !usage?.output_tokens,
    success: true,
    durationMs: Date.now() - billing.startedAt,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    units: 1,
  });
  try {
    await ReasoningCallRepository.record({
      workspaceId: scope?.workspaceId ?? "system",
      projectId: scope?.projectId,
      purpose: "image.generate",
      model: billing.model,
      isMock: false,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      costUsd,
      durationMs: Date.now() - billing.startedAt,
      status: "OK",
    });
  } catch (error) {
    console.error("[openai-image] could not record image spend", error);
  }
}

// A request that died on the wire (timeout, reset, broken stream) may still
// have been rendered and billed by OpenAI; its usage is unknown. Recorded as
// an estimated zero-cost failure so reconciliation can count them.
async function recordImageFailure(
  billing: ImageBilling,
  errorCode: string,
): Promise<void> {
  await recordUsage({
    kind: "IMAGE",
    provider: "openai",
    model: `${billing.model}/${billing.quality}`,
    purpose: getUsageScope()?.purpose ?? "image.generate",
    costUsd: 0,
    costEstimated: true,
    success: false,
    errorCode,
    durationMs: Date.now() - billing.startedAt,
    units: 0,
  });
}

async function storeResult(
  payload: OpenAIImageResponse,
  context: string,
  billing: ImageBilling,
): Promise<GeneratedCreativeImage | null> {
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) {
    console.error(`[openai-image] no image in response (${context})`);
    return null;
  }
  // Billed the moment OpenAI returned the image, even if storing it fails.
  await recordImageSpend(payload.usage, billing);
  const buffer = Buffer.from(b64, "base64");
  // gpt-image-2 always returns PNG regardless of input format.
  const { storageKey, filename } = await putAsset(buffer, "png", "image/png");
  return {
    storageKey,
    filename,
    mimeType: "image/png",
    size: buffer.byteLength,
    provider: "openai",
  };
}

// Returns null on failure — see the module comment. baseImage (edit an
// existing image per instruction) and referenceImage (generate from
// scratch but stay faithful to this — e.g. the brand logo) are mutually
// exclusive; if both are given, baseImage wins.
//
// quality defaults to "high": left unset, the API falls back to "auto",
// which favors speed/cost over fidelity and visibly loses fine detail
// (small on-screen text, thin linework) compared to ChatGPT's own image
// tool, which requests "high" by default. Still an explicit parameter —
// not hardcoded — so a caller can opt a cheaper path (bulk/draft
// generation) into "medium"/"low" later.
export async function generateOpenAIImage(
  prompt: string,
  baseImage?: { data: string; mimeType: string },
  imageSize?: { width: number; height: number },
  referenceImage?: { data: string; mimeType: string },
  quality: ImageQuality = "high",
  // When given (text-to-image only), the render is streamed and each partial
  // preview is handed to this callback as it arrives — the ChatGPT-style
  // "image sharpens in place" experience. Any streaming failure falls back
  // to the plain single request below.
  onPartial?: (partial: ImagePartial) => void,
  // Several pictures the render must follow (the brand's example posts, then
  // the real product): sent as the edits endpoint's `image[]`, the first one
  // leading. Ignored when baseImage is given (an edit has one picture).
  referenceImages?: { data: string; mimeType: string }[],
): Promise<GeneratedCreativeImage | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) return null;

  const model = env.OPENAI_IMAGE_MODEL;
  const size = sizeParam(imageSize);
  const inputs = baseImage
    ? [baseImage]
    : referenceImages && referenceImages.length > 0
      ? referenceImages
      : referenceImage
        ? [referenceImage]
        : [];
  const inputImage = inputs[0];
  const billing: ImageBilling = {
    model,
    quality,
    size,
    startedAt: Date.now(),
    spendRows: 0,
  };

  if (onPartial && !inputImage) {
    const streamed = await streamOpenAIImage(
      env.OPENAI_API_KEY,
      { model, prompt, size, quality },
      onPartial,
      billing,
    );
    if (streamed) return streamed;
  }

  const rowsBefore = billing.spendRows;
  try {
    let response: Response;
    if (inputImage) {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("size", size);
      form.set("quality", quality);
      const blobOf = (image: { data: string; mimeType: string }) =>
        new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType });
      const extOf = (image: { mimeType: string }) =>
        image.mimeType.split("/")[1] ?? "png";
      if (inputs.length === 1) {
        form.set("image", blobOf(inputImage), `input.${extOf(inputImage)}`);
      } else {
        // Several pictures: the multipart array form the API documents.
        inputs.forEach((image, index) => {
          form.append("image[]", blobOf(image), `input-${index + 1}.${extOf(image)}`);
        });
      }
      response = await fetch(EDITS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } else {
      response = await fetch(GENERATIONS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    }

    const payload = (await response.json()) as OpenAIImageResponse;
    if (!response.ok) {
      console.error(
        "[openai-image] generation failed:",
        response.status,
        payload.error?.message,
      );
      return null;
    }
    return await storeResult(
      payload,
      inputImage ? "edit" : "generate",
      billing,
    );
  } catch (error) {
    console.error("[openai-image] generation failed", error);
    // The render may have been billed and recorded already (only storing it
    // failed): no second, false "failed" row for the same call.
    if (billing.spendRows === rowsBefore) {
      await recordImageFailure(
        billing,
        error instanceof Error && error.name === "TimeoutError"
          ? "TIMEOUT"
          : "NETWORK",
      );
    }
    return null;
  }
}

// Text-to-image with partial previews. Returns null on any failure so the
// caller can fall back to the non-streaming request (a stream that dies
// halfway leaves nothing usable, unlike the final `completed` event).
async function streamOpenAIImage(
  apiKey: string,
  params: { model: string; prompt: string; size: string; quality: ImageQuality },
  onPartial: (partial: ImagePartial) => void,
  billing: ImageBilling,
): Promise<GeneratedCreativeImage | null> {
  const rowsBefore = billing.spendRows;
  try {
    const stream = await getSdkClient(apiKey).images.generate({
      model: params.model,
      prompt: params.prompt,
      size: params.size as never,
      quality: params.quality,
      n: 1,
      stream: true,
      partial_images: 2,
    });

    let finalB64: string | undefined;
    let finalUsage: ImageUsage | undefined;
    for await (const event of stream) {
      if (event.type === "image_generation.partial_image") {
        onPartial({ index: event.partial_image_index, b64: event.b64_json });
      } else if (event.type === "image_generation.completed") {
        finalB64 = event.b64_json;
        finalUsage = event.usage;
      }
    }
    if (!finalB64) {
      console.error("[openai-image] stream ended without a final image");
      // Partial previews of a render that never completed may still have been
      // billed, and the plain request that follows renders again.
      await recordImageFailure(billing, "NO_FINAL");
      return null;
    }
    return await storeResult(
      { data: [{ b64_json: finalB64 }], usage: finalUsage },
      "stream",
      billing,
    );
  } catch (error) {
    console.error("[openai-image] streaming generation failed", error);
    if (billing.spendRows === rowsBefore) {
      await recordImageFailure(billing, "STREAM");
    }
    return null;
  }
}
