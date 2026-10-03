import "server-only";

import { getEnv } from "@/lib/env";
import { putAsset } from "@/server/storage/asset-storage";

// Gemini image generation ("Nano Banana" family) — the app's primary image
// provider (see creative-image.ts, which falls back to OpenAI, then
// OpenClaw, then fal.ai if this isn't configured or a call fails). Returns
// null on any failure so callers (creative generation, logo) can complete
// their work without an image rather than blowing up the whole job.
//
// Image models behave differently from text models: the response comes as
// base64 inside `inlineData`, there's no separate "images" endpoint.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// Image generation is the slowest call this app makes — bounded generously
// so a hung request doesn't wedge the caller forever (the same class of bug
// openai-client.ts's FETCH_TIMEOUT_MS was added to fix).
const FETCH_TIMEOUT_MS = 120_000;

export type GeneratedCreativeImage = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  provider: "gemini";
};

type GeminiImageResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isGeminiImageConfigured(): boolean {
  return Boolean(getEnv().GEMINI_API_KEY);
}

export function geminiImageModel(): string {
  return getEnv().GEMINI_IMAGE_MODEL;
}

// A known-supported set of Gemini image aspect ratios. Gemini takes a ratio
// string, not exact pixel dimensions (unlike gpt-image-2's "WIDTHxHEIGHT")
// — creative-image.ts's normalizeToTarget resizes the result to the exact
// target afterward regardless, so this only needs to pick a reasonably
// close starting ratio, not an exact ratio.
const SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

function aspectRatioParam(imageSize?: {
  width: number;
  height: number;
}): string {
  if (!imageSize || !imageSize.height) return "1:1";
  const target = imageSize.width / imageSize.height;
  let best = SUPPORTED_ASPECT_RATIOS[0]!;
  let bestDiff = Infinity;
  for (const ratio of SUPPORTED_ASPECT_RATIOS) {
    const [w, h] = ratio.split(":").map(Number) as [number, number];
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ratio;
    }
  }
  return best;
}

// Returns null on failure — callers (creative generation, logo) must be
// able to complete their work even without an image.
// When baseImage is given, the model doesn't generate from scratch, it
// EDITS the given image according to the instruction (Gemini image models
// do both generation and editing from the same generateContent endpoint;
// the difference is adding inlineData to the input).
// referenceImage is for a different scenario than baseImage: giving the
// model the brand's actual logo/style board as a visual reference during
// from-scratch generation. The two are never used together — if baseImage
// is present (edit mode), referenceImage is ignored.
export async function generateGeminiImage(
  prompt: string,
  baseImage?: { data: string; mimeType: string },
  imageSize?: { width: number; height: number },
  referenceImage?: { data: string; mimeType: string },
  // Several reference pictures (the brand's example posts, then the real
  // product), in the order the prompt names them. Ignored in edit mode.
  referenceImages?: { data: string; mimeType: string }[],
): Promise<GeneratedCreativeImage | null> {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) return null;

  const model = env.GEMINI_IMAGE_MODEL;
  const inputs = baseImage
    ? [baseImage]
    : referenceImages && referenceImages.length > 0
      ? referenceImages
      : referenceImage
        ? [referenceImage]
        : [];

  try {
    const response = await fetch(`${BASE_URL}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts:
              inputs.length > 0
                ? [
                    ...inputs.map((image) => ({
                      inlineData: {
                        mimeType: image.mimeType,
                        data: image.data,
                      },
                    })),
                    { text: prompt },
                  ]
                : [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: aspectRatioParam(imageSize) },
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const payload = (await response.json()) as GeminiImageResponse;
    if (!response.ok) {
      console.error(
        "[gemini-image] generation failed:",
        response.status,
        payload.error?.message,
      );
      return null;
    }

    const candidate = payload.candidates?.[0];
    const inline = (candidate?.content?.parts ?? []).find(
      (part) => part.inlineData?.data,
    )?.inlineData;
    if (!inline?.data) {
      console.error(
        "[gemini-image] no image in response, finishReason:",
        candidate?.finishReason,
      );
      return null;
    }

    const mimeType = inline.mimeType ?? "image/png";
    const ext = EXTENSION_BY_MIME[mimeType] ?? "png";
    const buffer = Buffer.from(inline.data, "base64");

    const { storageKey, filename } = await putAsset(buffer, ext, mimeType);

    return {
      storageKey,
      filename,
      mimeType,
      size: buffer.byteLength,
      provider: "gemini",
    };
  } catch (error) {
    console.error("[gemini-image] generation failed", error);
    return null;
  }
}
