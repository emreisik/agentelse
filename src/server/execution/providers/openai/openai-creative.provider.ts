import "server-only";

import type {
  CapabilityKey,
  CreativeContentFormat,
  ExecutionProviderType,
  SocialPlatform,
} from "@prisma/client";
import { z } from "zod";

import { parseColorSwatches, parseFontNames } from "@/lib/color-swatches";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import {
  FALLBACK_TEXT_PLACEMENT,
  headlineZonePhrase,
  type TextPlacement,
} from "@/lib/layout-templates";
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
  keepCleanPicture,
  readPictureForAdapting,
  type PhotoSource,
} from "@/server/media/adapt-picture";
import { fitPhotoToCanvas } from "@/server/media/photo-fit";
import {
  loadBrandPhoto,
  recordPhotoUse,
} from "@/server/brand/media/photo-source";
import type { OnImageText } from "@/server/media/creative-text";
import {
  loadStyleReferences,
  NO_STYLE_REFERENCES,
} from "@/server/media/style-references";
import { barColorCandidates } from "@/lib/bar-color-candidates";
import { archetypeOfBrandContext } from "@/lib/brand-archetype";
import { applyBrandTemplate } from "@/server/media/creative-template";
import { headlineBudget, type HeadlineBudget } from "@/server/media/headline-budget";
import { writeOnImageText } from "@/server/media/headline-copywriter";
import { directImage } from "@/server/media/art-director";
import { assembleScene, directionAvoid } from "@/lib/art-direction";
import { deleteAsset, putAsset } from "@/server/storage/asset-storage";
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

// Only when the post carries words on its picture — its layout has a headline
// zone, or the brand's Post Style Kit follows example posts with text: the
// text step also writes them, and creative-text.ts typesets them onto the
// picture afterwards (the image model never draws them). For a kit, its
// examples decide whether any are needed (empty = a post with no words).
const TEXT_FIELDS = {
  headline: z.string().optional(),
  highlight: z.string().optional(),
  lines: z.array(z.string()).max(6).optional(),
};
const TextOutputSchema = CreativeOutputSchema.extend(TEXT_FIELDS);
const VariantTextOutputSchema = VariantOutputSchema.extend(TEXT_FIELDS);

// Why the text step writes on-image words: the layout's headline zone, or the
// kit's examples.
type TextMode = "layout" | "kit";

// The most supporting lines set under a headline (creative-text.ts).
const MAX_TEXT_LINES = 2;

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
  // Only when the client chose text on the image: one headline, typeset onto
  // the picture afterwards in the layout's headline zone (creative-text.ts).
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
  // The words typeset on the picture, and the picture as it was before they
  // (and the logo / band) went on: the post's other formats are laid out from
  // that clean picture and get the same words again (adapt-picture.ts).
  onImageText?: OnImageText;
  artConcept?: string;
  // The brand's own photo this picture is cut from (photo mode): no model drew
  // it, and the post's other formats are cut from the same photo again.
  photoSource?: PhotoSource;
  cleanPicture?: { storageKey: string; mimeType: string };
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

// The words a post carries on its picture, from the text step's answer or the
// chat's preset (empty headline = the post has none).
function overlayOf(value: unknown): OnImageText | undefined {
  if (!value || typeof value !== "object") return undefined;
  const words = value as {
    headline?: unknown;
    highlight?: unknown;
    lines?: unknown;
    cta?: unknown;
  };
  const headline =
    typeof words.headline === "string" ? words.headline.trim() : "";
  if (!headline) return undefined;
  const lines = (Array.isArray(words.lines) ? words.lines : [])
    .flatMap((line) =>
      typeof line === "string" && line.trim() ? [line.trim().slice(0, 80)] : [],
    )
    .slice(0, MAX_TEXT_LINES);
  const highlight =
    typeof words.highlight === "string" ? words.highlight.trim() : "";
  const cta =
    typeof words.cta === "string" ? words.cta.trim().slice(0, 28) : "";
  return {
    headline: headline.slice(0, 120),
    ...(highlight ? { highlight } : {}),
    ...(lines.length > 0 ? { lines } : {}),
    ...(cta ? { cta } : {}),
  };
}

// The model's first draft of the post's words. A dedicated copywriter step
// (headline-copywriter.ts) then rewrites it with the brand's voice and the
// layout's room; this draft is what stands if that step cannot run.
function textInstruction(mode: TextMode, budget: HeadlineBudget): string {
  const size = `${budget.minWords}-${budget.maxWords} words, at most ${budget.maxChars} characters`;
  if (mode === "layout") {
    return `The post's layout carries a headline that is typeset onto the picture afterwards, exactly as you write it. ALSO produce: \`headline\` — the hook of this post in ${size}: a complete thought that leads with a concrete benefit, a number, a sharp question or a bold claim, never generic filler such as "Discover our products", in the same language as the caption, with no hashtags, emoji, quotation marks or full stop at the end; when the brief already gives an on-image headline, use it as written. \`highlight\` (optional): the one or two words of the headline that carry the hook, set in the brand's accent colour. \`lines\` (optional, at most one): a supporting line of at most 8 words (the offer, the date or the call to action), only when it adds something the headline does not say. Take every fact, price and claim from the brief: never invent prices, discounts or promises. \`imagePrompt\` describes a picture with no text at all.`;
  }
  return `The brand's example posts carry designed text on the image, so ALSO produce: \`headline\` (the main on-image line, ${size}, in the same language as the caption; leave it empty if the examples carry no text), \`highlight\` (the words of it to emphasise, optional) and \`lines\` (at most 2 shorter texts the design has, such as a sub-headline, a price or a button label; empty if none). They are typeset onto the picture afterwards, so \`imagePrompt\` describes a picture with no text at all. Take every fact, price and claim from the brief: never invent prices, discounts or promises.`;
}

function buildSystemPrompt(
  brandContext: unknown,
  alternativeCount?: number,
  textMode?: TextMode,
  budget?: HeadlineBudget,
): string {
  return [
    "You are Agentelse's creative engine for a digital agency.",
    "Given a creative brief and brand context, produce: `caption` (short social caption), `copy` (longer supporting marketing copy), and `imagePrompt` (a concrete, literal visual description for an image generator — subject, composition, style, colours; no text overlays, no brand logos).",
    ...(alternativeCount
      ? [
          `Also produce \`alternativeImagePrompts\`: exactly ${alternativeCount} more image prompts for the SAME post, each with a clearly different composition, light and framing from \`imagePrompt\` and from each other, all obeying the same brand rules.`,
        ]
      : []),
    ...(textMode && budget ? [textInstruction(textMode, budget)] : []),
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
    // Photo mode: the brand's own photo is the picture (docs/brand-media.md).
    // One photo is one picture, so a variants request does not apply.
    const photoAssetIds = Array.isArray(input.photoAssetIds)
      ? input.photoAssetIds.filter(
          (id): id is string => typeof id === "string" && id.length <= 64,
        )
      : [];
    const variantCount = photoAssetIds.length
      ? undefined
      : variantCountOf(input.variantCount);

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
      // The photo: the one the job names, or the one the post's own picture was
      // cut from (another format of a photo post). A photo that is gone falls
      // back to adapting the picture as it is.
      const projectId = request.context.projectId;
      const photo = photoAssetIds[0]
        ? await loadBrandPhoto(photoAssetIds[0], projectId)
        : adaptFrom?.photoSource
          ? await loadBrandPhoto(adaptFrom.photoSource.assetId, projectId)
          : null;
      if (photoAssetIds[0] && !photo) {
        throw new Error("The photo could not be read.");
      }
      const preset = PresetSchema.safeParse(input.preset);
      const brandCtx = (input.brandContext ?? {}) as {
        logoAssetId?: string | null;
        darkLogoAssetId?: string | null;
        approvedColors?: unknown;
        approvedFonts?: unknown;
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
      const styleRefs = adaptFrom || photo
        ? NO_STYLE_REFERENCES
        : await loadStyleReferences({
            projectId,
            visualIdentity: brandCtx.visualIdentity,
            exampleIds: preset.success
              ? preset.data.styleExampleIds
              : undefined,
            productAssetIds: preset.success
              ? preset.data.productAssetIds
              : undefined,
          });
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
      // exactly as before layouts existed. Decided before the text step: a
      // layout with a headline zone is what asks it for the post's words.
      const layoutPlan = planCreativeLayout({
        visualIdentity: brandCtx.visualIdentity,
        hasLogo: Boolean(brandCtx.logoAssetId || brandCtx.darkLogoAssetId),
        archetype: archetypeOfBrandContext(input.brandContext),
        legacyColors: parseColorSwatches(brandCtx.approvedColors).map(
          (swatch) => swatch.hex,
        ),
        // The chat's pick; else the layout of the pool idea a planned post
        // was made from (plan-run.ts specOf, docs/ideas.md).
        requestedId: preset.success
          ? preset.data.layoutId
          : typeof input.layoutId === "string" && input.layoutId.length <= 40
            ? input.layoutId
            : null,
        pixelSize: platformFormat.pixelSize,
        // The image model never draws the words: they are typeset below.
        hasHeadline: false,
      });

      // How much the words of this post can say: decided by the room its layout
      // gives them on this canvas.
      const budget = headlineBudget({
        placement: layoutPlan.textPlacement ?? FALLBACK_TEXT_PLACEMENT,
        canvas: platformFormat.pixelSize ?? { width: 1080, height: 1350 },
      });

      // The text step also writes the post's on-image words when its layout
      // has a headline zone, or the kit follows example posts that carry text
      // (a chat preset brings its own words; an adaptation reuses its post's).
      const textMode: TextMode | undefined =
        preset.success || adaptFrom
          ? undefined
          : layoutPlan.textPlacement
            ? "layout"
            : styleRefs.matchStyle
              ? "kit"
              : undefined;
      const outputSchema = variantCount
        ? textMode
          ? VariantTextOutputSchema
          : VariantOutputSchema
        : textMode
          ? TextOutputSchema
          : CreativeOutputSchema;
      const parsed = preset.success
        ? preset.data
        : outputSchema.parse(
            (
              await runOpenAIStructured({
                model: openaiModelForTier(),
                system: buildSystemPrompt(
                  input.brandContext,
                  variantCount ? variantCount - 1 : undefined,
                  textMode,
                  budget,
                ),
                user: photo?.description
                  ? `${brief}\n\nThe post's picture is the brand's own real photo: ${photo.description} Write the caption, the copy and the headline for this exact photo; do not describe another scene.`
                  : brief,
                jsonSchema: z.toJSONSchema(outputSchema),
                // A 3-field schema can still be cut off mid-JSON on a small
                // budget when `copy`/`imagePrompt` are asked to be
                // substantial — 8192 keeps this call out of that failure
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
      // The words this picture carries: the chat's, the text step's, or (for
      // another format of a post) the post's own.
      const draftOverlay = preset.success
        ? overlayOf(preset.data.overlay)
        : adaptFrom
          ? adaptFrom.text
          : textMode
            ? overlayOf(parsed)
            : undefined;
      // The model's draft is rewritten by the copywriter step, with the brand's
      // voice and the room this layout has. Words the client dictated (a chat
      // preset) and the words of a post being adapted are never touched.
      // The copywriter and the art director read the same brand but write
      // different things, so they run together: the words that go on the
      // picture, and the picture itself.
      const polishedPromise =
        textMode && !preset.success && !adaptFrom && draftOverlay
          ? writeOnImageText({
              brandContext: input.brandContext,
              brief,
              caption:
                "caption" in parsed ? String(parsed.caption ?? "") : undefined,
              draft: draftOverlay,
              budget,
            })
          : Promise.resolve(null);
      const directionPromise = adaptFrom || photo
        ? Promise.resolve(null)
        : directImage({
            brandContext: input.brandContext,
            brief,
            caption:
              "caption" in parsed ? String(parsed.caption ?? "") : undefined,
            draft: parsed.imagePrompt,
            platformLabel: platformFormat.label,
            formatLabel: platformFormat.contentFormatLabel,
            pixelSize: platformFormat.pixelSize,
            // Where the words will be typeset: that area stays calm.
            calmArea:
              draftOverlay && layoutPlan.textPlacement
                ? headlineZonePhrase(layoutPlan.textPlacement.zone)
                : undefined,
            reservedZones: layoutPlan.reservedZones,
            followsExamples: styleRefs.exampleCount > 0 && styleRefs.matchStyle,
            hasProductPhotos: styleRefs.productCount > 0,
            pictures: variantCount ?? 1,
          });
      const [polished, direction] = await Promise.all([
        polishedPromise,
        directionPromise,
      ]);
      // The scene the image model is told to make: the director's, else the
      // text step's own description.
      const mainScene = direction ? assembleScene(direction) : parsed.imagePrompt;
      const overlay = polished ?? draftOverlay;
      // Where they are typeset: the layout's headline zone, else (a layout
      // without one, no saved layouts) large and centered in the upper third.
      const textPlacement: TextPlacement | null = overlay
        ? (layoutPlan.textPlacement ?? FALLBACK_TEXT_PLACEMENT)
        : null;
      const textArea = textPlacement
        ? headlineZonePhrase(textPlacement.zone)
        : undefined;
      const promptFor = (subject: string) =>
        buildCreativePrompt({
          subject,
          extraAvoid: direction ? directionAvoid(direction) : undefined,
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
          // A textless picture with a calm area where the words go.
          textArea,
        });
      const finalImagePrompt = promptFor(mainScene);
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
              // generation): stream previews.
              ...(streamed
                ? {
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

      // The post's words as the compositing sets them: the brand kit's font
      // and colours, clear of the platform's UI on a Story.
      const identity = brandCtx.visualIdentity;
      const templateText =
        overlay && textPlacement
          ? {
              ...overlay,
              placement: textPlacement,
              fontFamily: parseFontNames(brandCtx.approvedFonts)[0] ?? null,
              darkInk: identity?.primaryColors?.[0]?.hex ?? null,
              accentHex: identity?.accentColors?.[0]?.hex ?? null,
              safeZone: safeZonePercent(
                platformFormat.safeZone,
                platformFormat.pixelSize,
              ),
            }
          : undefined;
      let textDrawn = false;

      // Deterministic logo + accent-bar + words compositing — the ONE
      // guarantee in this pipeline (prompt text alone is stochastic). Reads
      // from the frozen context snapshot (brandCtx), never a live Brand Brain
      // query — this execution's behavior must not change mid-flight from a
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
            accentColors: barColorCandidates(brandCtx.visualIdentity),
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
            text: templateText,
          });
          if (templated?.textDrawn) textDrawn = true;
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
      let photoSource: PhotoSource | undefined;
      let alternatives: { image: GeneratedCreativeImage; label: string }[] = [];
      let cleanPicture: { storageKey: string; mimeType: string } | undefined;
      if (photo) {
        // The brand's own photo, cut to this canvas around its subject and clear
        // of the headline: no model draws or redraws it. It is a COPY that goes
        // through the compositing below, never the library's original.
        const fitted = await fitPhotoToCanvas({
          source: photo.bytes,
          canvas: platformFormat.pixelSize,
          focal: photo.focal,
          avoidZone: textPlacement?.zone ?? null,
        });
        const stored = await putAsset(fitted.buffer, "jpg", fitted.mimeType);
        const cut: GeneratedCreativeImage = {
          storageKey: stored.storageKey,
          filename: stored.filename,
          mimeType: fitted.mimeType,
          size: fitted.buffer.length,
          provider: "openai",
          width: fitted.width,
          height: fitted.height,
        };
        photoSource = { assetId: photo.assetId, fit: fitted.fit };
        if (templateText) cleanPicture = await keepCleanPicture(cut);
        image = await brandTemplated(cut);
        if (cleanPicture && !textDrawn) {
          await deleteAsset(cleanPicture.storageKey);
          cleanPicture = undefined;
        }
        // A new use of the photo, not another format of a post already counted.
        if (photoAssetIds[0]) await recordPhotoUse(photo.assetId);
      } else if (variantCount) {
        // The main picture and the N-1 alternatives render concurrently; a
        // render that fails or returns nothing is dropped (billing is per
        // successful image), so one bad render never costs the other two.
        const prompts = [
          mainScene,
          ...(direction?.alternatives?.length
            ? direction.alternatives
            : "alternativeImagePrompts" in parsed &&
                Array.isArray(parsed.alternativeImagePrompts)
              ? parsed.alternativeImagePrompts
              : []
          ).filter((p) => p.trim() !== ""),
        ].slice(0, variantCount);
        // Fewer prompts than pictures asked for: re-render the main prompt
        // rather than ask for fewer pictures than the button promised.
        while (prompts.length < variantCount) prompts.push(mainScene);
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
                // The clean picture: its words are set again afterwards.
                textArea: adaptFrom.text ? textArea : undefined,
              }),
              {
                baseImage: { data: adaptFrom.data, mimeType: adaptFrom.mimeType },
                imageSize: platformFormat.pixelSize,
                quality,
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
        if (image) {
          // The picture before its words, logo and band: the post's other
          // formats are laid out from it (adapt-picture.ts).
          if (templateText) cleanPicture = await keepCleanPicture(image);
          image = await brandTemplated(image);
          // No words went on after all (no room, a compositing error): the
          // copy has nothing to give the other formats.
          if (cleanPicture && !textDrawn) {
            await deleteAsset(cleanPicture.storageKey);
            cleanPicture = undefined;
          }
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
        layoutTemplate: layoutPlan.meta,
        ...(variantCount ? { alternatives } : {}),
        ...(adaptFrom && typeof input.adaptFromAssetId === "string"
          ? { adaptedFrom: input.adaptFromAssetId }
          : {}),
        ...(overlay && textDrawn ? { onImageText: overlay } : {}),
        ...(cleanPicture && textDrawn ? { cleanPicture } : {}),
        // The idea the picture was directed from (art-director.ts).
        ...(direction ? { artConcept: direction.concept } : {}),
        ...(photoSource ? { photoSource } : {}),
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
        ...(record.onImageText ? { onImageText: record.onImageText } : {}),
        ...(record.artConcept ? { artConcept: record.artConcept } : {}),
        ...(record.cleanPicture ? { cleanPicture: record.cleanPicture } : {}),
        ...(record.photoSource ? { photoSource: record.photoSource } : {}),
      },
      isMock: false,
    };
  }
}
