import "server-only";

import { getEnv } from "@/lib/env";
import { putAsset } from "@/server/storage/asset-storage";

// Gemini image generation. The difference from OpenClaw's `infer image
// generate` path: the call is made directly with the app's own
// GEMINI_API_KEY, so billing also goes to the Gemini account — not to
// OpenClaw's OpenAI session.
//
// Image models behave differently from text models: the response comes as
// base64 inside `inlineData`, there's no separate "images" endpoint. Live
// verified (gemini-3.1-flash-image -> image/jpeg, ~10s).

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeneratedCreativeImage = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  // Which backend produced it — so creative-image.ts's silent Gemini->OpenClaw
  // fallback switch can later be traced (via generationMetadata). If the
  // model name is wrong/invalid, the Gemini call fails with 404/400, and
  // without this, which backend was actually in play could only be told
  // from the server logs.
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

// Returns null on failure — callers (creative generation, logo) must be
// able to complete their work even without an image.
// When baseImage is given, the model doesn't generate from scratch, it
// EDITS the given image according to the instruction (Gemini image models
// do both generation and editing from the same generateContent endpoint;
// the difference is adding inlineData to the input).
// referenceImage is for a different scenario than baseImage: giving the
// model the brand's actual logo as a visual reference during from-scratch
// generation, saying "here it is, stay faithful to it." The two are never
// used together — if baseImage is present (edit mode), referenceImage is
// ignored.
export async function generateGeminiImage(
  prompt: string,
  baseImage?: { data: string; mimeType: string },
  // Gemini-supported ratio string, e.g. "4:5", "9:16" — best-effort: if the
  // exact request field ever changes shape, an unrecognized field is
  // expected to be ignored rather than break generation. Confirm the field
  // name against a live call before relying on it.
  aspectRatio?: string,
  referenceImage?: { data: string; mimeType: string },
): Promise<GeneratedCreativeImage | null> {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) return null;

  const model = env.GEMINI_IMAGE_MODEL;

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
            parts: baseImage
              ? [
                  {
                    inlineData: {
                      mimeType: baseImage.mimeType,
                      data: baseImage.data,
                    },
                  },
                  { text: prompt },
                ]
              : referenceImage
                ? [
                    {
                      inlineData: {
                        mimeType: referenceImage.mimeType,
                        data: referenceImage.data,
                      },
                    },
                    { text: prompt },
                  ]
                : [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
        },
      }),
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
