import "server-only";

import OpenAI from "openai";

import { getEnv } from "@/lib/env";
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
};

// The header's OpenAI balance (billing/openai-credit.ts) is a snapshot minus
// every gpt-* ReasoningCall, and a high-quality render is the dearest thing
// this app buys — so each one is logged. No workspace reaches this client;
// "system" keeps the row out of per-workspace reports while the shared
// key's balance still counts it. Never throws: a bookkeeping failure must
// not cost the caller a render OpenAI already billed.
async function recordImageSpend(
  usage: ImageUsage | undefined,
  billing: ImageBilling,
): Promise<void> {
  try {
    await ReasoningCallRepository.record({
      workspaceId: "system",
      purpose: "image.generate",
      model: billing.model,
      isMock: false,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      costUsd: estimateImageCostUsd({
        quality: billing.quality,
        size: billing.size,
        usage,
      }),
      durationMs: Date.now() - billing.startedAt,
      status: "OK",
    });
  } catch (error) {
    console.error("[openai-image] could not record image spend", error);
  }
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
): Promise<GeneratedCreativeImage | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) return null;

  const model = env.OPENAI_IMAGE_MODEL;
  const size = sizeParam(imageSize);
  const inputImage = baseImage ?? referenceImage;
  const billing: ImageBilling = { model, quality, size, startedAt: Date.now() };

  if (onPartial && !inputImage) {
    const streamed = await streamOpenAIImage(
      env.OPENAI_API_KEY,
      { model, prompt, size, quality },
      onPartial,
      billing,
    );
    if (streamed) return streamed;
  }

  try {
    let response: Response;
    if (inputImage) {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("size", size);
      form.set("quality", quality);
      const ext = inputImage.mimeType.split("/")[1] ?? "png";
      form.set(
        "image",
        new Blob([Buffer.from(inputImage.data, "base64")], {
          type: inputImage.mimeType,
        }),
        `input.${ext}`,
      );
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
      return null;
    }
    return await storeResult(
      { data: [{ b64_json: finalB64 }], usage: finalUsage },
      "stream",
      billing,
    );
  } catch (error) {
    console.error("[openai-image] streaming generation failed", error);
    return null;
  }
}
