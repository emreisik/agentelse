import "server-only";

import type {
  CapabilityKey,
  CreativeContentFormat,
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
import { loadReferenceImage } from "@/server/media/brand-logo";
import { applyBrandTemplate } from "@/server/media/creative-template";
import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";
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
  platform?: SocialPlatform;
  aspectRatio?: string;
  contentFormat?: CreativeContentFormat;
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
        // Was 2048 — the same MAX_TOKENS-truncation-produces-non-JSON-output
        // failure repeatedly hit council-evaluation.ts (37% of prod calls),
        // baseline-audit.ts (27%), constitution-synthesis.ts and
        // department/signal-profile-recommendation.ts (see those files'
        // comments): Gemini's thinking tokens are deducted from this same
        // budget, so it can run out well before the visible text does, even
        // for a 3-field schema. `copy` and `imagePrompt` are both asked to
        // be substantial ("longer supporting marketing copy", "a concrete,
        // literal visual description... subject, composition, style,
        // colours"), which made this call an unmitigated instance of the
        // same class of bug the reasoning/prompts/* callers already fixed.
        maxOutputTokens: 8192,
      });
      const parsed = CreativeOutputSchema.parse(raw);

      const platformFormat = getCreativePlatformFormat(
        typeof input.platform === "string"
          ? (input.platform as SocialPlatform)
          : undefined,
      );
      const brandCtx = (input.brandContext ?? {}) as {
        logoAssetId?: string | null;
        darkLogoAssetId?: string | null;
        approvedColors?: unknown;
        visualIdentity?: BrandVisualIdentityContext | null;
      };
      // The logo itself is NEVER sent to the AI as a referenceImage — it's
      // added afterward, guaranteed, by applyBrandTemplate below (that's
      // the whole point: prompt text can only nudge a stochastic model,
      // never guarantee exact placement). The referenceImage slot instead
      // carries the brand's optional "style board" image, if configured —
      // see hasStyleReference's wording in creative-prompt-builder.ts for
      // why that image must never be copied for its literal content.
      const styleImage = await loadReferenceImage(
        brandCtx.visualIdentity?.referenceImageAssetId,
      );
      const finalImagePrompt = buildCreativePrompt({
        subject: parsed.imagePrompt,
        brandContext: input.brandContext,
        platformLabel: platformFormat.label,
        contentFormatLabel: platformFormat.contentFormatLabel,
        pixelSize: platformFormat.pixelSize,
        safeZone: platformFormat.safeZone,
        caption: parsed.caption,
        hasStyleReference: Boolean(styleImage),
      });
      let image = isCreativeImageConfigured()
        ? ((await generateCreativeImage(finalImagePrompt, {
            aspectRatio: platformFormat.aspectRatio,
            imageSize: platformFormat.pixelSize,
            referenceImage: styleImage ?? undefined,
          })) ?? undefined)
        : undefined;

      // Deterministic logo + accent-bar compositing — the ONE guarantee in
      // this pipeline (prompt text alone is stochastic). Reads from the
      // frozen context snapshot (brandCtx), never a live Brand Brain query
      // — this execution's behavior must not change mid-flight from a
      // concurrent Visual Identity edit (spec section 35). Best-effort: a
      // templating failure must never fail creative generation.
      if (image) {
        try {
          const templated = await applyBrandTemplate({
            storageKey: image.storageKey,
            mimeType: image.mimeType,
            lightLogoAssetId: brandCtx.logoAssetId,
            darkLogoAssetId: brandCtx.darkLogoAssetId,
            accentColors: brandCtx.visualIdentity?.accentColors,
            legacyApprovedColors: brandCtx.approvedColors,
            template: brandCtx.visualIdentity?.template ?? undefined,
          });
          if (templated) image = { ...image, size: templated.size };
        } catch (error) {
          console.error(
            "[gemini-creative-provider] applyBrandTemplate failed:",
            error,
          );
        }
      }

      store.set(request.correlationId, {
        status: "completed",
        caption: parsed.caption,
        copy: parsed.copy,
        image,
        platform:
          typeof input.platform === "string"
            ? (input.platform as SocialPlatform)
            : undefined,
        aspectRatio: platformFormat.aspectRatio,
        contentFormat: platformFormat.contentFormat,
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
        platform: record.platform,
        aspectRatio: record.aspectRatio,
        contentFormat: record.contentFormat,
      },
      isMock: false,
    };
  }
}
