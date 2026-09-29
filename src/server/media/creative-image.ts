import "server-only";

import sharp from "sharp";

import {
  generateGeminiImage,
  isGeminiImageConfigured,
  type GeneratedCreativeImage as GeneratedByGemini,
} from "@/server/reasoning/gemini-image-client";
import {
  generateOpenAIImage,
  isOpenAIImageConfigured,
  type GeneratedCreativeImage as GeneratedByOpenAI,
  type ImageQuality,
} from "@/server/reasoning/openai-image-client";
import {
  generateCreativeImageAsset as generateViaOpenClaw,
  isOpenClawImageConfigured,
  type GeneratedCreativeImage as GeneratedByOpenClaw,
} from "@/server/execution/providers/openclaw/openclaw-image-client";
import {
  generateFalImage,
  isFalImageConfigured,
  type GeneratedFalImage as GeneratedByFal,
} from "@/server/reasoning/fal-image-client";
import { findFalImageModel } from "@/lib/fal-image-models";
import { readAsset, overwriteAsset } from "@/server/storage/asset-storage";

export type GeneratedCreativeImage = (
  GeneratedByGemini | GeneratedByOpenAI | GeneratedByOpenClaw | GeneratedByFal
) & {
  // The real, measured pixel size after normalize() below — not what was
  // requested (both backends can drift slightly from the target); this is
  // what the "N x M px" note under the image is allowed to trust.
  width: number;
  height: number;
};

// Gemini/OpenAI/OpenClaw all write image bytes via putAsset() and return a
// storageKey; this measures the actual result with sharp and, if it doesn't
// match the platform's target pixel size, resizes it in place (cover +
// attention-based crop, so the subject isn't naively center-cropped) before
// any caller can persist or display it. Without this step the pixel-size
// note shown under generated images would be a guess, not a fact.
async function normalizeToTarget(
  image:
    | GeneratedByGemini
    | GeneratedByOpenAI
    | GeneratedByOpenClaw
    | GeneratedByFal,
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
//   1. Gemini ("Nano Banana" — see gemini-image-client.ts). Default backend;
//      falls through automatically when GEMINI_API_KEY is unset or the call
//      fails (quota, safety refusal, network).
//   2. OpenAI (gpt-image-2 — see openai-image-client.ts). Fallback when
//      Gemini isn't configured or its call fails.
//   3. OpenClaw — `infer image generate`, billing goes to the OpenAI
//      session configured in OpenClaw (openai/gpt-image-2). Fallback if
//      neither of the above is configured or succeeds — the creative flow
//      shouldn't get stuck on one provider's bad day. Doesn't support a
//      reference image (see GenerateCreativeImageOptions).
//   4. fal.ai (FLUX Schnell — fast/cheap general-purpose, same family the
//      Image Studio's own "Fast" tier offers) — LAST-RESORT safety net,
//      only when steps 1-3 all failed/aren't configured. Deliberately last:
//      the tiers above already converge on Gemini/OpenAI's own model
//      families, so this is the one tier that's a genuinely different
//      visual style — reserved for "otherwise the job fails outright"
//      rather than routine load-balancing. Also has no reference-image
//      support, so a logo/brand reference is silently dropped here too,
//      same limitation as the OpenClaw tier.
const FALLBACK_FAL_ENDPOINT_ID = "fal-ai/flux/schnell";

function tryFalFallback(
  prompt: string,
  options: GenerateCreativeImageOptions,
): Promise<GeneratedByFal | null> {
  if (!isFalImageConfigured()) return Promise.resolve(null);
  return generateFalImage(
    FALLBACK_FAL_ENDPOINT_ID,
    prompt,
    undefined,
    options.imageSize,
  );
}

export function isCreativeImageConfigured(): boolean {
  return (
    isGeminiImageConfigured() ||
    isOpenAIImageConfigured() ||
    isOpenClawImageConfigured() ||
    isFalImageConfigured()
  );
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
  // Defaults to "high" in both provider clients if left unset — see
  // openai-image-client.ts's generateOpenAIImage comment. Exposed here so
  // a caller can trade fidelity for cost on a bulk/draft generation path.
  quality?: ImageQuality;
  // A fal-image-models.ts id, set only when the user explicitly picked a
  // fal.ai model in the Image Studio. When present it takes over entirely
  // (see generateCreativeImage below) — deliberately no fallback to
  // OpenAI/OpenClaw on failure, since silently substituting a different
  // provider's style for the one the user picked would be more confusing
  // than just reporting the failure.
  falModelId?: string;
};

async function tryFal(
  prompt: string,
  options: GenerateCreativeImageOptions,
): Promise<GeneratedByFal | null> {
  if (!options.falModelId) return null;
  const model = findFalImageModel(options.falModelId);
  if (!model) {
    console.error(
      `[creative-image] unknown fal model id: ${options.falModelId}`,
    );
    return null;
  }
  const inputImage = model.supportsImageInput
    ? (options.baseImage ?? options.referenceImage)
    : undefined;
  return generateFalImage(
    model.endpointId,
    prompt,
    inputImage,
    options.imageSize,
  );
}

async function tryGemini(
  prompt: string,
  options: GenerateCreativeImageOptions,
): Promise<GeneratedByGemini | null> {
  if (!isGeminiImageConfigured()) return null;
  // Catches an actual call failure (quota, safety refusal, network, a
  // billing block on the underlying GCP project — a real 403 seen in
  // production), not just "unconfigured" — without this, a thrown error
  // here propagated straight out of generateCreativeImage() and the OpenAI/
  // OpenClaw/fal tiers below were never even attempted, contradicting this
  // module's own documented "falls through... or the call fails" behavior.
  try {
    return await generateGeminiImage(
      prompt,
      options.baseImage,
      options.imageSize,
      options.referenceImage,
    );
  } catch (error) {
    console.error("[creative-image] Gemini image generation failed:", error);
    return null;
  }
}

async function tryOpenAI(
  prompt: string,
  options: GenerateCreativeImageOptions,
): Promise<GeneratedByOpenAI | null> {
  if (!isOpenAIImageConfigured()) return null;
  try {
    return await generateOpenAIImage(
      prompt,
      options.baseImage,
      options.imageSize,
      options.referenceImage,
      options.quality,
    );
  } catch (error) {
    console.error("[creative-image] OpenAI image generation failed:", error);
    return null;
  }
}

export async function generateCreativeImage(
  prompt: string,
  options?: GenerateCreativeImageOptions,
): Promise<GeneratedCreativeImage | null> {
  const opts = options ?? {};

  if (opts.falModelId) {
    const viaFal = await tryFal(prompt, opts);
    return viaFal ? normalizeToTarget(viaFal, opts.imageSize) : null;
  }

  const viaGemini = await tryGemini(prompt, opts);
  if (viaGemini) return normalizeToTarget(viaGemini, opts.imageSize);

  const image = await tryOpenAI(prompt, opts);
  if (image) return normalizeToTarget(image, opts.imageSize);

  // The OpenClaw fallback doesn't accept a reference image (there's no
  // such parameter in the CLI) — so a logo/brand reference is only usable
  // on the OpenAI path above, and is silently ignored here.
  if (isOpenClawImageConfigured()) {
    try {
      const viaOpenClaw = await generateViaOpenClaw(
        prompt,
        opts.imageSize,
        opts.quality,
      );
      if (viaOpenClaw) return normalizeToTarget(viaOpenClaw, opts.imageSize);
    } catch (error) {
      console.error(
        "[creative-image] OpenClaw image generation failed:",
        error,
      );
    }
  }

  // Last resort — see the module comment above (step 4). Only reached once
  // every earlier tier has failed or is unconfigured — caught too, so a
  // failure here degrades to "no image" (the creative still completes with
  // just caption/copy, see the calling providers) instead of failing the
  // whole task.
  try {
    const viaFal = await tryFalFallback(prompt, opts);
    if (viaFal) return normalizeToTarget(viaFal, opts.imageSize);
  } catch (error) {
    console.error("[creative-image] fal.ai fallback failed:", error);
  }

  return null;
}
