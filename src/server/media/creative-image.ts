import "server-only";

import {
  generateGeminiImage,
  isGeminiImageConfigured,
  type GeneratedCreativeImage as GeneratedByGemini,
} from "@/server/reasoning/gemini-image-client";
import {
  generateCreativeImageAsset as generateViaOpenClaw,
  isOpenClawImageConfigured,
  type GeneratedCreativeImage as GeneratedByOpenClaw,
} from "@/server/execution/providers/openclaw/openclaw-image-client";

export type GeneratedCreativeImage = GeneratedByGemini | GeneratedByOpenClaw;

// The single entry point for image generation. The preference order is
// deliberate:
//
//   1. Gemini — the app's own GEMINI_API_KEY, billing goes to the Gemini
//      account.
//   2. OpenClaw — `infer image generate`, billing goes to the OpenAI
//      session configured in OpenClaw (openai/gpt-image-2).
//
// If Gemini is configured, we never fall through to OpenClaw; the fallback
// path only kicks in if there's no key, or the Gemini call fails.
export function isCreativeImageConfigured(): boolean {
  return isGeminiImageConfigured() || isOpenClawImageConfigured();
}

export type GenerateCreativeImageOptions = {
  // When given, the image isn't generated from scratch — the existing
  // image is edited according to the instruction. Since the OpenClaw
  // fallback doesn't support editing, when that path is taken, the
  // instruction is used as a fresh generation prompt instead.
  baseImage?: { data: string; mimeType: string };
  // For giving the model the brand's actual logo as a visual reference
  // during from-scratch generation (see gemini-image-client.ts). Only used
  // on the Gemini path — see the note below.
  referenceImage?: { data: string; mimeType: string };
  // The aspect ratio sent to Gemini (like "4:5") and the pixel size sent
  // to OpenClaw — comes from src/lib/creative-platform-format.ts.
  aspectRatio?: string;
  imageSize?: { width: number; height: number };
};

export async function generateCreativeImage(
  prompt: string,
  options?: GenerateCreativeImageOptions,
): Promise<GeneratedCreativeImage | null> {
  const { baseImage, referenceImage, aspectRatio, imageSize } = options ?? {};

  if (isGeminiImageConfigured()) {
    const image = await generateGeminiImage(
      prompt,
      baseImage,
      aspectRatio,
      referenceImage,
    );
    if (image) return image;
    // Gemini failed (quota, safety refusal, network). Try the fallback if
    // one exists — the creative flow shouldn't get stuck on one
    // provider's bad day.
  }

  // The OpenClaw fallback doesn't accept a reference image (there's no
  // such parameter in the CLI) — so a logo/brand reference is only usable
  // on the Gemini path, and is silently ignored here.
  if (isOpenClawImageConfigured())
    return generateViaOpenClaw(prompt, imageSize);
  return null;
}
