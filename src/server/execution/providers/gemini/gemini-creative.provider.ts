import "server-only";

import type {
  CapabilityKey,
  ExecutionProviderType,
  SocialPlatform,
} from "@prisma/client";
import { z } from "zod";

import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import {
  geminiModel,
  isGeminiConfigured,
  runGeminiStructured,
} from "@/server/reasoning/gemini-client";
import {
  generateCreativeImage,
  isCreativeImageConfigured,
  type GeneratedCreativeImage,
} from "@/server/media/creative-image";
import { buildCreativePrompt } from "@/server/media/creative-prompt-builder";
import { loadBrandLogoImage } from "@/server/media/brand-logo";
import type {
  ExecutionAcceptedResult,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "CREATE_SOCIAL_CREATIVE",
  "CREATE_AD_CREATIVE",
]);

const CreativeOutputSchema = z.object({
  caption: z.string(),
  copy: z.string(),
  imagePrompt: z.string(),
});

type StoredResult = {
  status: "completed" | "failed";
  caption?: string;
  copy?: string;
  image?: GeneratedCreativeImage;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

function localeInstruction(brandContext: unknown): string {
  const ctx = (brandContext ?? {}) as { language?: unknown; country?: unknown };
  const language =
    typeof ctx.language === "string" && ctx.language
      ? ctx.language
      : "the brand's default language";
  const country =
    typeof ctx.country === "string" && ctx.country
      ? ctx.country
      : "the brand's default market";
  return `Write "caption" and "copy" entirely in ${language}, culturally relevant to the ${country} market.`;
}

function buildSystemPrompt(brandContext: unknown): string {
  return [
    "You are Agentelse's creative engine for a digital agency.",
    "Given a creative brief and brand context, produce: `caption` (short social caption), `copy` (longer supporting marketing copy), and `imagePrompt` (a concrete, literal visual description for an image generator — subject, composition, style, colours; no text overlays, no brand logos).",
    "Respect any negativeBrief/approvedClaims entries in the brand context as hard constraints — never violate them.",
    localeInstruction(brandContext),
    "Brand context (JSON, may be partial):",
    JSON.stringify(brandContext ?? {}),
  ].join("\n\n");
}

// Gemini produces both the text and the image (see @/server/media/creative-image
// for the image path) — a single provider combines the two because the
// image prompt is generated as part of the creative text. If image
// generation fails, the job still completes with the text (no asset); the
// creative flow doesn't fail because of the image.
export class GeminiCreativeProvider implements ExecutionProvider {
  readonly key = "gemini-creative";
  readonly type: ExecutionProviderType = "AI";

  get isConfigured(): boolean {
    return isGeminiConfigured();
  }

  async canExecute(capability: CapabilityKey): Promise<boolean> {
    return OWNED_CAPABILITIES.has(capability);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const input = (request.payload ?? {}) as Record<string, unknown>;
    const brief =
      typeof input.request === "string" ? input.request : JSON.stringify(input);

    try {
      const { raw } = await runGeminiStructured({
        model: geminiModel(),
        system: buildSystemPrompt(input.brandContext),
        user: brief,
        jsonSchema: z.toJSONSchema(CreativeOutputSchema),
        maxOutputTokens: 2048,
      });
      const parsed = CreativeOutputSchema.parse(raw);

      const platformFormat = getCreativePlatformFormat(
        typeof input.platform === "string"
          ? (input.platform as SocialPlatform)
          : undefined,
      );
      const brandCtx = (input.brandContext ?? {}) as {
        logoAssetId?: string | null;
        approvedColors?: unknown;
      };
      const logoImage = await loadBrandLogoImage(brandCtx.logoAssetId);
      const finalImagePrompt = buildCreativePrompt({
        subject: parsed.imagePrompt,
        brandContext: input.brandContext,
        platformLabel: platformFormat.label,
        caption: parsed.caption,
        hasLogoReference: Boolean(logoImage),
      });
      const image = isCreativeImageConfigured()
        ? ((await generateCreativeImage(finalImagePrompt, {
            aspectRatio: platformFormat.aspectRatio,
            imageSize: platformFormat.pixelSize,
            referenceImage: logoImage ?? undefined,
          })) ?? undefined)
        : undefined;

      // The logo is now passed to the AI as a visual reference instead of
      // deterministic stamping (see the loadBrandLogoImage call above) —
      // applyBrandTemplate still exists and is used in the Visual Studio's
      // "edit" mode (creative-actions.ts), but it's now redundant in this
      // automated generation flow and carries a double-logo risk, so it was
      // removed here.

      store.set(request.correlationId, {
        status: "completed",
        caption: parsed.caption,
        copy: parsed.copy,
        image,
      });
    } catch (error) {
      store.set(request.correlationId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { executionReference: request.correlationId, isMock: false };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record = store.get(executionReference);
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown Gemini execution reference",
        isMock: false,
      };
    }
    if (record.status === "failed") {
      return {
        status: "FAILED",
        errorMessage: record.errorMessage,
        isMock: false,
      };
    }
    return {
      status: "COMPLETED",
      rawResult: {
        caption: record.caption,
        copy: record.copy,
        image: record.image,
      },
      isMock: false,
    };
  }
}
