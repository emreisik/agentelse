import "server-only";

import { z } from "zod";

import { ArtDirectionSchema, type ArtDirection } from "@/lib/art-direction";
import { strings, text } from "@/lib/brand-context-read";
import {
  openaiModelForTier,
  runOpenAIStructured,
} from "@/server/reasoning/openai-client";

// The step between an idea and the image model. A post idea ("autumn menu
// launch") is turned into the brief a photographer would shoot from, worked
// out FROM THE BRAND: what it sells, who buys it, where they live, how its
// pictures look. The image model then makes that picture instead of the
// average picture of the topic, which is what a bare "image of X" prompt
// gives. Best effort: any failure returns null and the draft prompt the
// caller already has stands.

// What the director reads of the brand: who it is, who it serves, and how its
// pictures are meant to look. Short and labelled, nothing else.
export function artContextOf(brandContext: unknown): Record<string, unknown> {
  const context =
    brandContext && typeof brandContext === "object"
      ? (brandContext as Record<string, unknown>)
      : {};
  const constitution = context.brandConstitution as
    { summary?: unknown; payload?: unknown } | null | undefined;
  const payload = (constitution?.payload ?? {}) as Record<string, unknown>;
  const identity = context.visualIdentity as
    Record<string, unknown> | null | undefined;

  const swatches = (value: unknown) =>
    strings(
      Array.isArray(value)
        ? value.map((entry) => {
            const swatch = entry as { name?: unknown; hex?: unknown } | null;
            return swatch?.name && swatch?.hex
              ? `${String(swatch.name)} ${String(swatch.hex)}`
              : (swatch?.hex ?? null);
          })
        : [],
      6,
    );

  return {
    country: text(context.country, 60),
    language: text(context.language, 40),
    about: text(constitution?.summary, 600) ?? text(context.summary, 600),
    business: text(payload.businessModel, 300),
    positioning: text(context.positioning, 400),
    toneOfVoice: text(context.toneOfVoice, 300),
    audiences:
      strings(context.targetAudiences, 4).length > 0
        ? strings(context.targetAudiences, 4)
        : strings(payload.audiences, 4),
    products:
      strings(context.products, 6).length > 0
        ? strings(context.products, 6)
        : strings(payload.products, 6),
    differentiators: strings(payload.differentiators, 4),
    look: identity
      ? {
          photographyStyle: text(identity.photographyStyle, 40),
          refinement: text(identity.styleRefinement, 300),
          mood: strings(identity.moodTags, 8),
          composition: text(identity.compositionNotes, 300),
          background: text(identity.backgroundTone, 40),
          alwaysInclude: strings(identity.alwaysInclude, 6),
          alwaysAvoid: strings(identity.alwaysAvoid, 6),
          primary: swatches(identity.primaryColors),
          secondary: swatches(identity.secondaryColors),
          accent: swatches(identity.accentColors),
        }
      : null,
    whatWorks: strings(context.brandLearnings, 5),
    neverShow: strings(context.negativeBrief, 8),
    recentScenes: recentScenes(context),
  };
}

// The scenes the brand's latest approved pictures were made from, so the new
// one keeps the same world without repeating the same shot.
function recentScenes(context: Record<string, unknown>): string[] {
  const recent = Array.isArray(context.recentApprovedCreatives)
    ? (context.recentApprovedCreatives as unknown[])
    : [];
  const scenes: string[] = [];
  for (const creative of recent) {
    const versions = (creative as { versions?: unknown })?.versions;
    const metadata = Array.isArray(versions)
      ? (versions[0] as { generationMetadata?: unknown } | undefined)
          ?.generationMetadata
      : undefined;
    const prompt = text(
      (metadata as { prompt?: unknown } | null | undefined)?.prompt,
      220,
    );
    if (prompt) scenes.push(prompt);
  }
  return scenes.slice(0, 3);
}

export type ArtDirectionRequest = {
  brandContext: unknown;
  // The post's idea or brief, as the pipeline has it.
  brief: string;
  caption?: string;
  // The picture prompt already written (by the text step or the chat). The
  // director keeps what it asks for and adds the craft.
  draft?: string;
  platformLabel?: string;
  formatLabel?: string;
  pixelSize?: { width: number; height: number };
  // Where the post's words go, so that area is left calm ("in the upper third
  // of the frame").
  calmArea?: string;
  // The areas the logo is added to afterwards.
  reservedZones?: string;
  // The brand's example posts decide the design: do not invent another look.
  followsExamples?: boolean;
  // Real pictures of the product are attached.
  hasProductPhotos?: boolean;
  // How many pictures are made (alternatives wanted: this minus one).
  pictures?: number;
};

export function buildArtDirectorPrompt(input: ArtDirectionRequest): {
  system: string;
  user: string;
} {
  const alternatives = Math.max(0, (input.pictures ?? 1) - 1);
  const system = [
    "You are the art director of a top creative agency. You turn a social post's idea into the precise visual brief a photographer (or illustrator) would shoot from, so the picture looks made for THIS brand and this idea, not like the average stock picture of the topic.",
    "",
    "HOW TO WORK",
    "1. Understand the brand first. Read what it sells, who buys it, where those people live and how the brand's pictures are meant to look. The picture must be recognisable as this brand's world: its real product or service, its real customer, a setting and details that are true for its country and culture. Never a generic scene that fits any brand.",
    "2. Find the concept: one visual idea that EXPRESSES what the post says (a moment, a contrast, a metaphor made of real things), not a picture of the words. State it in `concept`.",
    "3. Decide every field concretely, the way a shot list does:",
    "   - subject: exact nouns, how many, materials, colours, size, what they are doing. For people: age range, expression, posture and clothing that fit the market, never stereotypes. For a product: exactly the real product, correct in shape and label.",
    "   - setting: the place and what is around the subject, with the depth of the background.",
    "   - composition: framing, camera angle and height, depth layers, where the subject sits in the frame, one clear focal point and room to breathe.",
    "   - lighting: the source, its direction and quality (soft or hard), colour temperature and time of day, where the shadows fall.",
    "   - technique: for a photograph, the lens focal length, aperture and depth of field, and the grade (natural, matte, filmic); for an illustration or 3D render, the medium and the method.",
    "   - texture: tactile detail and honest imperfection (grain of wood, steam, condensation, fabric weave, a fingerprint) that make it read as real.",
    "   - mood: the feeling, in a few words.",
    "4. Brand fit. The brand's colours appear NATURALLY in surfaces, props, wardrobe and light, never as a flat tint over the picture. Follow its photography style, mood words and always-include list; never show anything on its never-show or always-avoid lists. Stay in the same world as its recent scenes but make a NEW scene, not the same shot again.",
    "5. Keep what is asked. A draft prompt may be given: keep every element it or the brief explicitly asks for (subject, product, setting, any instruction from the client) and make it specific and well-crafted. Never contradict a fact: the product is exactly what it is.",
    "6. The words and the logo are added afterwards. The picture itself contains NO text, letters, numbers, logos, watermarks or interface. Keep the calm area and the reserved areas given below clear of the subject and of busy detail.",
    "7. Avoid AI tells: floating glowing particles, waxy or plastic skin, perfect symmetry, melted hands or objects, generic smiling stock handshakes, neon gradients, over-smooth CGI sheen (unless the brand's style is 3D). List 3-6 specific `avoid` items for THIS picture.",
    ...(alternatives > 0
      ? [
          `8. Also write \`alternatives\`: exactly ${alternatives} more complete, self-contained scene briefs (each one paragraph) for the SAME post, each with a clearly different composition, camera angle and light from the main one and from each other, all obeying the same brand rules.`,
        ]
      : []),
    ...(input.followsExamples
      ? [
          "The brand's example posts are attached and decide the DESIGN: do not invent another layout, typography or graphic style. Use your craft for the subject, the light and the realism.",
        ]
      : []),
    ...(input.hasProductPhotos
      ? [
          "Real photographs of the product are attached: show exactly that product; direct the setting, light and framing around it.",
        ]
      : []),
    "",
    "Write in English (the image model reads English) but keep names, places and cultural details true to the brand's market. Return JSON only.",
  ].join("\n");

  const format = [input.platformLabel, input.formatLabel]
    .filter(Boolean)
    .join(" ");
  const user = [
    "BRAND (JSON):",
    JSON.stringify(artContextOf(input.brandContext)),
    "",
    `POST BRIEF: ${input.brief.slice(0, 1500)}`,
    ...(input.caption ? [`CAPTION: ${input.caption.slice(0, 400)}`] : []),
    ...(input.draft
      ? [`DRAFT PICTURE PROMPT: ${input.draft.slice(0, 1200)}`]
      : []),
    format
      ? `FORMAT: ${format}${input.pixelSize ? ` (${input.pixelSize.width}x${input.pixelSize.height}px)` : ""}`
      : "",
    input.calmArea
      ? `CALM AREA: the post's headline is typeset ${input.calmArea}. Keep that area calm, low-detail and evenly lit; place the subject away from it.`
      : "",
    input.reservedZones ? `RESERVED AREAS: ${input.reservedZones}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

export async function directImage(
  input: ArtDirectionRequest,
): Promise<ArtDirection | null> {
  try {
    const { system, user } = buildArtDirectorPrompt(input);
    const { raw } = await runOpenAIStructured({
      model: openaiModelForTier(),
      system,
      user,
      jsonSchema: z.toJSONSchema(ArtDirectionSchema),
      maxOutputTokens: 2600,
    });
    const parsed = ArtDirectionSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.error("[art-director] failed, keeping the draft prompt:", error);
    return null;
  }
}
