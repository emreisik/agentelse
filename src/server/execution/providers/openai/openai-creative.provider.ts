import "server-only";

import type {
  CapabilityKey,
  CreativeContentFormat,
  ExecutionProviderType,
  SocialPlatform,
} from "@prisma/client";
import { z } from "zod";

import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { VARIANT_COUNT, VARIANT_QUALITY } from "@/lib/works/variants";
import {
  emitCreativeProgress,
  hasCreativeProgressListener,
} from "@/server/media/creative-progress";
import {
  isOpenAIConfigured,
  openaiModelForTier,
  runOpenAIStructured,
} from "@/server/reasoning/openai-client";
import {
  generateCreativeImage,
  isCreativeImageConfigured,
  type GeneratedCreativeImage,
} from "@/server/media/creative-image";
import {
  planCreativeLayout,
  safeZonePercent,
} from "@/server/media/creative-layout";
import { buildCreativePrompt } from "@/server/media/creative-prompt-builder";
import {
  adaptPicturePrompt,
  readPictureForAdapting,
} from "@/server/media/adapt-picture";
import {
  loadStyleReferences,
  NO_STYLE_REFERENCES,
} from "@/server/media/style-references";
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

// Only for a variants job (payload.variantCount): the text step also writes
// the other compositions. A separate schema keeps the one the model sees for
// every other job exactly as it was.
const VariantOutputSchema = CreativeOutputSchema.extend({
  alternativeImagePrompts: z.array(z.string()).optional(),
});

// Only while the brand's Post Style Kit asks to follow its example posts: the
// text step also writes the words the design carries on the image. The kit's
// examples decide whether any are needed (empty = a post with no on-image text).
const KitOutputSchema = CreativeOutputSchema.extend({
  headline: z.string().optional(),
  highlight: z.string().optional(),
  lines: z.array(z.string()).max(6).optional(),
});

// The chat's inline generation (generate_image) has the conversation model
// write the copy and image prompt itself — it already holds the brand
// context — so the provider can skip its own text LLM round trip (5-30 s).
const PresetSchema = z.object({
  caption: z.string(),
  copy: z.string(),
  imagePrompt: z.string().min(1),
  alternativeImagePrompts: z.array(z.string()).optional(),
  // One of the brand's post layouts (src/lib/layout-templates.ts) picked in
  // the chat. Absent or unknown = the brand's default for this format.
  layoutId: z.string().max(40).optional(),
  // Which of the brand's Post Style examples this post follows (the agent
  // picked them), and the real product's pictures. Absent = the newest
  // examples and no product picture (lib/post-style.ts, style-references.ts).
  styleExampleIds: z.array(z.string().max(64)).max(3).optional(),
  productAssetIds: z.array(z.string().max(64)).max(3).optional(),
  // Only when the client chose text on the image: one headline, rendered by
  // the image model (see creative-prompt-builder.ts's TYPOGRAPHY block).
  // The brand logo is NOT part of this — applyBrandTemplate adds it below.
  overlay: z
    .object({
      headline: z.string().min(1),
      highlight: z.string().optional(),
      // The design's other texts (sub-headline, price, button label...).
      lines: z.array(z.string().min(1).max(80)).max(6).optional(),
    })
    .optional(),
});

const QUALITIES = new Set(["low", "medium", "high"]);

type StoredResult = {
  status: "completed" | "failed";
  caption?: string;
  copy?: string;
  image?: GeneratedCreativeImage;
  platform?: SocialPlatform;
  aspectRatio?: string;
  contentFormat?: CreativeContentFormat;
  // Which post layout laid this out (null: the brand's base template).
  layoutTemplate?: { id: string; name: string } | null;
  // Variants job only: the extra renders of the same piece (never the main).
  alternatives?: { image: GeneratedCreativeImage; label: string }[];
  // The post's picture this one was adapted from (another format of the same
  // post): not a picture of its own, so it never becomes the post's picture.
  adaptedFrom?: string;
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

// A variants job asks for 2..VARIANT_COUNT pictures in total; anything else
// (absent, 1, a string, a float) is an ordinary single-image job.
function variantCountOf(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 2 &&
    value <= VARIANT_COUNT
    ? value
    : undefined;
}

// An absent quality means "high" downstream (about 4x the price of medium),
// which would silently triple the stated cost of a variants tap.
function clampVariantQuality(
  quality: "low" | "medium" | "high" | undefined,
): "low" | "medium" {
  return quality === "low" ? "low" : VARIANT_QUALITY;
}

// The words a kit-following post carries on the image, from the text step's
// answer (empty headline = the post has none).
function kitOverlayOf(
  parsed: unknown,
): { headline: string; highlight?: string; lines?: string[] } | undefined {
  const value = parsed as {
    headline?: string;
    highlight?: string;
    lines?: string[];
  };
  const headline = value.headline?.trim();
  if (!headline) return undefined;
  const lines = (value.lines ?? [])
    .map((line) => line.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 6);
  return {
    headline: headline.slice(0, 120),
    highlight: value.highlight?.trim() || undefined,
    ...(lines.length > 0 ? { lines } : {}),
  };
}

function buildSystemPrompt(
  brandContext: unknown,
  alternativeCount?: number,
  kitText?: boolean,
): string {
  return [
    "You are Agentelse's creative engine for a digital agency.",
    "Given a creative brief and brand context, produce: `caption` (short social caption), `copy` (longer supporting marketing copy), and `imagePrompt` (a concrete, literal visual description for an image generator — subject, composition, style, colours; no text overlays, no brand logos).",
    ...(alternativeCount
      ? [
          `Also produce \`alternativeImagePrompts\`: exactly ${alternativeCount} more image prompts for the SAME post, each with a clearly different composition, light and framing from \`imagePrompt\` and from each other, all obeying the same brand rules.`,
        ]
      : []),
    ...(kitText
      ? [
          "The brand's example posts carry designed text on the image, so ALSO produce: `headline` (the main on-image line, at most 8 words, in the brand language; leave it empty if the examples carry no text), `highlight` (the words of it to emphasise, optional) and `lines` (up to 3 shorter texts the design has, such as a sub-headline, a price or a button label; empty if none). Take every fact, price and claim from the brief: never invent prices, discounts or promises.",
        ]
      : []),
    "Respect any negativeBrief/approvedClaims entries in the brand context as hard constraints — never violate them.",
    localeInstruction(brandContext),
    "Brand context (JSON, may be partial):",
    JSON.stringify(brandContext ?? {}),
  ].join("\n\n");
}

// OpenAI produces both the text and the image prompt (see
// @/server/media/creative-image for the actual image call) — a single
// provider combines the two because the image prompt is generated as part
// of the creative text. If image generation fails, the job still completes
// with the text (no asset); the creative flow doesn't fail because of the
// image.
export class OpenAiCreativeProvider implements ExecutionProvider {
  readonly key = "openai-creative";
  readonly type: ExecutionProviderType = "AI";

  get isConfigured(): boolean {
    return isOpenAIConfigured();
  }

  async canExecute(capability: CapabilityKey): Promise<boolean> {
    return OWNED_CAPABILITIES.has(capability);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const input = (request.payload ?? {}) as Record<string, unknown>;
    const brief =
      typeof input.request === "string" ? input.request : JSON.stringify(input);
    const variantCount = variantCountOf(input.variantCount);

    try {
      // Another format of a post that already has its picture (plan-run.ts,
      // "one post, one picture"): that picture is re-laid out, never redrawn.
      const adaptFrom =
        typeof input.adaptFromAssetId === "string" && !variantCount
          ? await readPictureForAdapting(input.adaptFromAssetId)
          : undefined;
      if (typeof input.adaptFromAssetId === "string" && !variantCount && !adaptFrom) {
        throw new Error("The post's picture could not be read.");
      }
      const preset = PresetSchema.safeParse(input.preset);
      const brandCtx = (input.brandContext ?? {}) as {
        logoAssetId?: string | null;
        darkLogoAssetId?: string | null;
        approvedColors?: unknown;
        visualIdentity?: BrandVisualIdentityContext | null;
      };
      // The pictures this render follows: the brand's Post Style examples, then
      // the real product of the post (or, without a kit, the one old style
      // board). The logo itself is NEVER one of them: applyBrandTemplate adds
      // it afterward, guaranteed (prompt text can only nudge a stochastic
      // model, never guarantee exact placement). A board or an example is
      // style to follow, never literal content to copy (see
      // creative-prompt-builder.ts).
      // An adaptation follows its own picture and nothing else.
      const styleRefs = adaptFrom
        ? NO_STYLE_REFERENCES
        : await loadStyleReferences({
            visualIdentity: brandCtx.visualIdentity,
            exampleIds: preset.success
              ? preset.data.styleExampleIds
              : undefined,
            productAssetIds: preset.success
              ? preset.data.productAssetIds
              : undefined,
          });
      // The text step also writes the design's on-image words when the kit asks
      // to follow its examples (a post of an ordinary job stays textless; an
      // adaptation already has its words in the picture).
      const kitText =
        !preset.success && !variantCount && !adaptFrom && styleRefs.matchStyle;
      const parsed = preset.success
        ? preset.data
        : (variantCount
            ? VariantOutputSchema
            : kitText
              ? KitOutputSchema
              : CreativeOutputSchema
          ).parse(
            (
              await runOpenAIStructured({
                model: openaiModelForTier(),
                system: buildSystemPrompt(
                  input.brandContext,
                  variantCount ? variantCount - 1 : undefined,
                  kitText,
                ),
                user: brief,
                jsonSchema: z.toJSONSchema(
                  variantCount
                    ? VariantOutputSchema
                    : kitText
                      ? KitOutputSchema
                      : CreativeOutputSchema,
                ),
                // See gemini-creative.provider.ts's former history (now
                // removed): a 3-field schema can still be cut off mid-JSON
                // on a small budget when `copy`/`imagePrompt` are asked to
                // be substantial — 8192 keeps this call out of that failure
                // class from the start.
                maxOutputTokens: 8192,
              })
            ).raw,
          );
      const requestedQuality =
        typeof input.quality === "string" && QUALITIES.has(input.quality)
          ? (input.quality as "low" | "medium" | "high")
          : undefined;
      const quality = variantCount
        ? clampVariantQuality(requestedQuality)
        : requestedQuality;
      const streamed = hasCreativeProgressListener(request.executionJobId);
      const overlay = preset.success
        ? preset.data.overlay
        : kitText
          ? kitOverlayOf(parsed)
          : undefined;

      const platformFormat = getCreativePlatformFormat(
        typeof input.platform === "string"
          ? (input.platform as SocialPlatform)
          : undefined,
        // Story/Reel/etc, when the chat request named one explicitly —
        // see command-service.ts's contentFormatPayloadExtra. Omitted =
        // the platform's own default, same as before this existed.
        typeof input.contentFormat === "string"
          ? (input.contentFormat as CreativeContentFormat)
          : undefined,
      );
      // Which post layout applies (the chat's pick, else the brand's
      // default for this format) and what it means for the prompt and for
      // the compositing below. No saved layouts = the brand's base template,
      // exactly as before layouts existed.
      const layoutPlan = planCreativeLayout({
        visualIdentity: brandCtx.visualIdentity,
        hasLogo: Boolean(brandCtx.logoAssetId || brandCtx.darkLogoAssetId),
        requestedId: preset.success ? preset.data.layoutId : null,
        pixelSize: platformFormat.pixelSize,
        hasHeadline: Boolean(overlay),
      });
      const promptFor = (subject: string) =>
        buildCreativePrompt({
          subject,
          brandContext: input.brandContext,
          platformLabel: platformFormat.label,
          contentFormatLabel: platformFormat.contentFormatLabel,
          pixelSize: platformFormat.pixelSize,
          safeZone: platformFormat.safeZone,
          hasStyleReference: styleRefs.legacyBoard,
          postStyle: styleRefs.section,
          matchStyle: styleRefs.matchStyle,
          reservedZones: layoutPlan.reservedZones,
          layoutComposition: layoutPlan.composition,
          typography: overlay
            ? {
                ...overlay,
                // The brand's own first accent colour, when configured, so the
                // highlighted words match the palette.
                accentHex: brandCtx.visualIdentity?.accentColors?.[0]?.hex,
                placement: layoutPlan.headlinePlacement,
              }
            : undefined,
        });
      const finalImagePrompt = promptFor(parsed.imagePrompt);
      // One render. `live` = this is the picture the watcher sees streaming
      // (the main one); an extra variant never streams, its partial frames
      // would overwrite the main preview.
      const renderRaw = async (
        prompt: string,
        live: boolean,
      ): Promise<GeneratedCreativeImage | undefined> =>
        isCreativeImageConfigured()
          ? ((await generateCreativeImage(prompt, {
              imageSize: platformFormat.pixelSize,
              // One picture (the old style board) goes the way it always did;
              // the kit's examples and the product go as an ordered set.
              ...(styleRefs.exampleCount > 0 || styleRefs.productCount > 0
                ? { referenceImages: styleRefs.images }
                : { referenceImage: styleRefs.images[0] ?? undefined }),
              // Absent for worker-driven jobs: unchanged behavior ("high").
              quality,
              // Somebody is watching this render live (inline chat
              // generation): stream previews and don't detour via Gemini.
              ...(streamed
                ? {
                    skipGemini: true,
                    ...(live
                      ? {
                          onPartial: (partial: {
                            index: number;
                            b64: string;
                          }) =>
                            emitCreativeProgress(request.executionJobId, {
                              type: "partial",
                              index: partial.index,
                              dataUrl: `data:image/png;base64,${partial.b64}`,
                            }),
                        }
                      : {}),
                  }
                : {}),
            })) ?? undefined)
          : undefined;

      // Deterministic logo + accent-bar compositing — the ONE guarantee in
      // this pipeline (prompt text alone is stochastic). Reads from the
      // frozen context snapshot (brandCtx), never a live Brand Brain query
      // — this execution's behavior must not change mid-flight from a
      // concurrent Visual Identity edit (spec section 35). Best-effort: a
      // templating failure must never fail creative generation.
      const brandTemplated = async (
        rendered: GeneratedCreativeImage,
      ): Promise<GeneratedCreativeImage> => {
        try {
          const templated = await applyBrandTemplate({
            storageKey: rendered.storageKey,
            mimeType: rendered.mimeType,
            lightLogoAssetId: brandCtx.logoAssetId,
            darkLogoAssetId: brandCtx.darkLogoAssetId,
            accentColors: brandCtx.visualIdentity?.accentColors,
            legacyApprovedColors: brandCtx.approvedColors,
            template: layoutPlan.template,
            // Story / Reel: keep a corner logo out of the app's own UI bands.
            // Only with a saved layout: brands without one keep their exact
            // previous compositing.
            safeZone: layoutPlan.layout
              ? safeZonePercent(
                  platformFormat.safeZone,
                  platformFormat.pixelSize,
                )
              : undefined,
            trimLogo: Boolean(layoutPlan.layout),
          });
          if (templated) return { ...rendered, size: templated.size };
        } catch (error) {
          console.error(
            "[openai-creative-provider] applyBrandTemplate failed:",
            error,
          );
        }
        return rendered;
      };

      let image: GeneratedCreativeImage | undefined;
      let alternatives: { image: GeneratedCreativeImage; label: string }[] = [];
      if (variantCount) {
        // The main picture and the N-1 alternatives render concurrently; a
        // render that fails or returns nothing is dropped (billing is per
        // successful image), so one bad render never costs the other two.
        const prompts = [
          parsed.imagePrompt,
          ...("alternativeImagePrompts" in parsed &&
          Array.isArray(parsed.alternativeImagePrompts)
            ? parsed.alternativeImagePrompts
            : []
          ).filter((p) => p.trim() !== ""),
        ].slice(0, variantCount);
        // Fewer prompts than pictures asked for: re-render the main prompt
        // rather than ask for fewer pictures than the button promised.
        while (prompts.length < variantCount) prompts.push(parsed.imagePrompt);
        const settled = await Promise.all(
          prompts.map(async (subject, index) => {
            try {
              const rendered = await renderRaw(promptFor(subject), index === 0);
              return {
                image: rendered ? await brandTemplated(rendered) : undefined,
                error: undefined as unknown,
              };
            } catch (error) {
              return { image: undefined, error };
            }
          }),
        );
        const rendered = settled.flatMap((r) => (r.image ? [r.image] : []));
        // Nothing survived, whether a render threw or generateCreativeImage
        // answered null (it never throws on a failed render: every tier is
        // caught and it ends in null): fail the job instead of completing an
        // empty piece that would take the slot and could not be retried.
        const firstError = settled.find((r) => r.error !== undefined)?.error;
        if (rendered.length === 0) {
          throw firstError ?? new Error("No picture could be made.");
        }
        // The main render may be the one that failed: the first picture that
        // survived leads, so the job still completes with a main image.
        image = rendered[0];
        alternatives = rendered.slice(1).map((alt, i) => ({
          image: alt,
          label: `Option ${i + 2}`,
        }));
      } else if (adaptFrom) {
        const adapted = isCreativeImageConfigured()
          ? await generateCreativeImage(
              adaptPicturePrompt({
                pixelSize: platformFormat.pixelSize,
                aspectRatio: platformFormat.aspectRatio,
                formatLabel: platformFormat.contentFormatLabel,
                safeZone: platformFormat.safeZone,
                reservedZones: layoutPlan.reservedZones,
              }),
              {
                baseImage: adaptFrom,
                imageSize: platformFormat.pixelSize,
                quality,
                ...(streamed ? { skipGemini: true } : {}),
              },
            )
          : null;
        // A piece without its post's picture would not be the same post: fail
        // the job (the slot can be made again) rather than finish it bare.
        if (!adapted) {
          throw new Error("The post's picture could not be adapted to this format.");
        }
        image = await brandTemplated(adapted);
      } else {
        image = await renderRaw(finalImagePrompt, true);
        if (image) image = await brandTemplated(image);
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
        layoutTemplate: layoutPlan.meta,
        ...(variantCount ? { alternatives } : {}),
        ...(adaptFrom && typeof input.adaptFromAssetId === "string"
          ? { adaptedFrom: input.adaptFromAssetId }
          : {}),
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
        errorMessage: "Unknown OpenAI execution reference",
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
        layoutTemplate: record.layoutTemplate ?? null,
        ...(record.alternatives ? { alternatives: record.alternatives } : {}),
        ...(record.adaptedFrom ? { adaptedFrom: record.adaptedFrom } : {}),
      },
      isMock: false,
    };
  }
}
