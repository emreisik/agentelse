import "server-only";

import { getEnv } from "@/lib/env";
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
  error?: { message?: string };
};

async function storeResult(
  payload: OpenAIImageResponse,
  context: string,
): Promise<GeneratedCreativeImage | null> {
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) {
    console.error(`[openai-image] no image in response (${context})`);
    return null;
  }
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
export async function generateOpenAIImage(
  prompt: string,
  baseImage?: { data: string; mimeType: string },
  imageSize?: { width: number; height: number },
  referenceImage?: { data: string; mimeType: string },
): Promise<GeneratedCreativeImage | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) return null;

  const model = env.OPENAI_IMAGE_MODEL;
  const size = sizeParam(imageSize);
  const inputImage = baseImage ?? referenceImage;

  try {
    let response: Response;
    if (inputImage) {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("size", size);
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
        body: JSON.stringify({ model, prompt, size, n: 1 }),
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
    return await storeResult(payload, inputImage ? "edit" : "generate");
  } catch (error) {
    console.error("[openai-image] generation failed", error);
    return null;
  }
}
