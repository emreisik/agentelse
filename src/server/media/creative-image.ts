import "server-only";

import sharp from "sharp";

import {
  generateOpenAIImage,
  isOpenAIImageConfigured,
  type GeneratedCreativeImage as GeneratedByOpenAI,
} from "@/server/reasoning/openai-image-client";
import {
  generateCreativeImageAsset as generateViaOpenClaw,
  isOpenClawImageConfigured,
  type GeneratedCreativeImage as GeneratedByOpenClaw,
} from "@/server/execution/providers/openclaw/openclaw-image-client";
import { readAsset, overwriteAsset } from "@/server/storage/asset-storage";

export type GeneratedCreativeImage = (
  GeneratedByOpenAI | GeneratedByOpenClaw
) & {
  // The real, measured pixel size after normalize() below — not what was
  // requested (both backends can drift slightly from the target); this is
  // what the "N x M px" note under the image is allowed to trust.
  width: number;
  height: number;
};

// OpenAI/OpenClaw both write image bytes via putAsset() and return a
// storageKey; this measures the actual result with sharp and, if it doesn't
// match the platform's target pixel size, resizes it in place (cover +
// attention-based crop, so the subject isn't naively center-cropped) before
// any caller can persist or display it. Without this step the pixel-size
// note shown under generated images would be a guess, not a fact.
async function normalizeToTarget(
  image: GeneratedByOpenAI | GeneratedByOpenClaw,
  target?: { width: number; height: number },
): Promise<GeneratedCreativeImage> {
  const buffer = await readAsset(image.storageKey);
  const meta = await sharp(buffer).metadata();

  if (
    !target ||
    (meta.width === target.width && meta.height === target.height)
  ) {
    return {
      ...image,
      width: meta.width ?? target?.width ?? 0,
      height: meta.height ?? target?.height ?? 0,
    };
  }

  const resized = await sharp(buffer)
    .resize(target.width, target.height, {
      fit: "cover",
      position: sharp.strategy.attention,
    })
    .toBuffer();
  await overwriteAsset(image.storageKey, resized, image.mimeType);

  return {
    ...image,
    size: resized.byteLength,
    width: target.width,
    height: target.height,
  };
}

// The single entry point for image generation. Preference order:
//
//   1. OpenAI (gpt-image-2 — see openai-image-client.ts).
//   2. OpenClaw — `infer image generate`, billing goes to the OpenAI
//      session configured in OpenClaw (openai/gpt-image-2). Fallback if
//      OpenAI isn't configured or its call fails (quota, safety refusal,
//      network) — the creative flow shouldn't get stuck on one provider's
//      bad day. Last resort: it doesn't support a reference image (see
//      GenerateCreativeImageOptions).
export function isCreativeImageConfigured(): boolean {
  return isOpenAIImageConfigured() || isOpenClawImageConfigured();
}

export type GenerateCreativeImageOptions = {
  // When given, the image isn't generated from scratch — the existing
  // image is edited according to the instruction. Since the OpenClaw
  // fallback doesn't support editing, when that path is taken, the
  // instruction is used as a fresh generation prompt instead.
  baseImage?: { data: string; mimeType: string };
  // For giving the model the brand's actual logo as a visual reference
  // during from-scratch generation (see openai-image-client.ts). Not used
  // on the OpenClaw path — see below.
  referenceImage?: { data: string; mimeType: string };
  imageSize?: { width: number; height: number };
};

async function tryOpenAI(
  prompt: string,
  options: GenerateCreativeImageOptions,
): Promise<GeneratedByOpenAI | null> {
  if (!isOpenAIImageConfigured()) return null;
  return generateOpenAIImage(
    prompt,
    options.baseImage,
    options.imageSize,
    options.referenceImage,
  );
}

export async function generateCreativeImage(
  prompt: string,
  options?: GenerateCreativeImageOptions,
): Promise<GeneratedCreativeImage | null> {
  const opts = options ?? {};

  const image = await tryOpenAI(prompt, opts);
  if (image) return normalizeToTarget(image, opts.imageSize);

  // The OpenClaw fallback doesn't accept a reference image (there's no
  // such parameter in the CLI) — so a logo/brand reference is only usable
  // on the OpenAI path above, and is silently ignored here.
  if (isOpenClawImageConfigured()) {
    const viaOpenClaw = await generateViaOpenClaw(prompt, opts.imageSize);
    if (viaOpenClaw) return normalizeToTarget(viaOpenClaw, opts.imageSize);
  }
  return null;
}
