import "server-only";

import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";

// Turns a bare subject description into the structured brief real ad-tool
// prompt templates converge on (Subject / Style+Lighting / Composition /
// Brand / Avoid) instead of a single unguided sentence. Two things this
// buys, backed by 2026 prompting research for modern image models:
// explicit photography vocabulary pushes output away from the generic
// "AI-rendered" look, and a natural-language "avoid" block stands in for
// the negative-prompt field these models don't expose.
export type CreativePromptInput = {
  subject: string;
  // Whatever ConstitutionService.getBrandContext()/the task's brandContext
  // payload returns, merged with resolveBrandStyleContext() output by the
  // caller (see creative-actions.ts/context-builder.ts) — shape varies, so
  // this is read defensively rather than typed against one source.
  brandContext?: unknown;
  platformLabel?: string;
  // Human label for the content-type slot, e.g. "Story (9:16)" — see
  // src/lib/creative-platform-format.ts. Only meaningful together with
  // platformLabel.
  contentFormatLabel?: string;
  // Exact target canvas — stated explicitly so the model composes to fill
  // it rather than leaving letterboxing; creative-image.ts still normalizes
  // the actual output with sharp afterward, since the requested size is
  // best-effort, not a guarantee.
  pixelSize?: { width: number; height: number };
  // Approximate top/bottom margin, in px, reserved by the platform's own UI
  // chrome on full-screen vertical formats (Story/Reel/Shorts) — keeps
  // critical subject matter and on-image text out of that band.
  safeZone?: { top?: number; bottom?: number };
  // True if the caller is actually passing a referenceImage (see
  // brand-logo.ts's loadReferenceImage) — so the style-reference
  // instruction below is only written when an image is actually being
  // attached. Renamed from hasLogoReference: the logo itself is no longer
  // ever sent to the AI this way (see openai-creative.provider.ts /
  // creative-actions.ts) — it's added afterward, guaranteed, by
  // applyBrandTemplate. This slot now carries an optional brand "style
  // board" image instead, which the wording below explicitly must NOT be
  // copied for its literal subject/logo content — only style/palette/mood.
  hasStyleReference?: boolean;
  // Areas the brand's compositing will cover afterwards (logo, colour bar or
  // band): key subject matter and any text stay out of them.
  reservedZones?: string;
  // Scene guidance from the chosen post layout ("keep the upper third calm...").
  layoutComposition?: string;
  // Headline mode (chat's generate_image, only when the client wants text
  // on the image): the model renders that one headline itself instead of
  // producing a textless photo. Absent = the classic textless behavior.
  typography?: CreativeTypography;
  // Where the post's words are typeset AFTER the render (creative-text.ts),
  // e.g. "in the upper third of the frame": the picture stays textless and
  // keeps that area calm for them.
  textArea?: string;
  // The Post Style Kit's section for this render (lib/post-style.ts
  // postStyleSection): what the attached example and product pictures are, and
  // the brand's standing instructions. It rules over every other design choice.
  postStyle?: string | null;
  // The kit asks for posts that follow its examples closely: the examples decide
  // layout and typography, so the layout's own composition and headline
  // placement notes stand aside.
  matchStyle?: boolean;
  // What the art director says would spoil THIS picture (art-direction.ts
  // directionAvoid), added to the brand's own avoid list.
  extraAvoid?: string;
};

export type CreativeTypography = {
  // The on-image line the client asked for, brand language. Rendered
  // exactly, character for character (Turkish diacritics included).
  headline: string;
  // Words of the headline set in the accent colour.
  highlight?: string;
  // Accent colour hex from the brand's visual identity, when configured.
  accentHex?: string;
  // How the headline is set and where it goes, from the chosen post layout
  // ("large, centered, at most 3 lines, placed in the upper third...").
  // Absent = a generic "calm area of the scene".
  placement?: string;
  // Further on-image texts (sub-headline, price, button label, badge), each
  // rendered exactly once where the design puts that kind of text.
  lines?: string[];
};

// Global baseline — applies to every generation regardless of brand. A
// brand's Visual Identity settings (see extractBrandStyle below) ADD to
// these, never replace them; this is the quality floor every image starts
// from.
const STYLE_AND_LIGHTING =
  "Professional, polished social-media/marketing graphic design — " +
  "photographic, illustrated, or a stylish mix, whichever best fits the " +
  "subject. Clean, intentional, on-brand — not a generic AI-rendered look.";

// Textless baseline vs. editorial mode: the only difference is who owns the
// words. Everything else in the avoid list applies to both.
const AVOID_TEXTLESS =
  "any text, words, letters, numbers, or typography anywhere in the " +
  "image (no headlines, captions, logos, or watermarks — the image must be " +
  "completely textless; captions are added separately, outside the image), ";

// Textless too, but the post does carry words: we set them afterwards.
const AVOID_TEXT_SET_AFTER =
  "any text, words, letters, numbers, or typography anywhere in the " +
  "image (no headlines, captions, logos, or watermarks — the image must be " +
  "completely textless; the post's words are typeset onto it afterwards), ";

const AVOID_EDITORIAL_TEXT =
  "any text other than the headline specified in " +
  "TYPOGRAPHY — no extra words, no gibberish or pseudo-text anywhere (screens, " +
  "signs and UI mockups use abstract bars and lines instead of writing), " +
  "no extra logos or watermarks, ";

const AVOID_REST =
  "airbrushed skin, plastic/waxy texture, over-smoothed CGI look, " +
  "perfectly symmetrical artificial composition, glossy 3D-render sheen, " +
  "stock-photo watermarks, extra or malformed limbs. " +
  "Prefer: visible natural texture, subtle imperfections, natural " +
  "asymmetry, candid unposed framing, faint natural film grain.";

// Typography mode only changes WHO owns the words and how much finish the
// image needs — never the look. The look (palette, photography style, mood,
// composition, always-include / always-avoid) comes from the brand's own
// Visual Identity through the BRAND / STYLE sections below and from what the
// client chose in conversation; nothing here prescribes a scene, a setting or
// a colour.
const EDITORIAL_BASELINE =
  "Art-directed, high-finish marketing image with ONE clear focal idea and a " +
  "confident, uncluttered composition. Follow the BRAND section for palette, " +
  "photography style, mood and rules — those take precedence over any " +
  "generic taste. Crisp, professional, not a generic AI-rendered look.";

function typographyBlock(
  t: CreativeTypography,
  reservedZones?: string,
  matchStyle?: boolean,
): string {
  const accent = t.accentHex
    ? `the brand accent colour ${t.accentHex}`
    : "the brand's accent colour from the BRAND section";
  const lines = (t.lines ?? []).filter((line) => line.trim());
  const parts = [
    lines.length > 0
      ? "Render exactly these texts, character for character, correctly spelled with every diacritic (ş ğ ı İ ö ü ç etc.), perfectly sharp and legible. They are the ONLY texts in the image."
      : "Render exactly this text, character for character, correctly spelled with every diacritic (ş ğ ı İ ö ü ç etc.), perfectly sharp and legible. It is the ONLY text in the image.",
    matchStyle
      ? `HEADLINE: "${t.headline}" — set in the typeface, weight, case, colour and size relationship of the headline in the reference posts, at most 3-4 lines${t.highlight ? `; set the words "${t.highlight}" the way the reference posts highlight words` : ""}.`
      : `HEADLINE: "${t.headline}" — set in a refined typeface that suits the brand's tone (from the BRAND section), high contrast against its background, at most 3-4 lines, generous margins${t.highlight ? `; set the words "${t.highlight}" in ${accent}` : ""}.`,
    lines.length > 0
      ? `OTHER TEXTS, each exactly once, placed where the design puts that kind of text (sub-headline, price, button label, badge): ${lines.map((line) => `"${line}"`).join(", ")}.`
      : "",
    matchStyle
      ? "Place every text where the reference posts place that kind of text."
      : t.placement
        ? `Set the headline ${t.placement}. Keep that area calm (deepen it with a subtle natural gradient if needed) so contrast is strong.`
        : "Place it on a calm area of the scene (deepen that area with a subtle natural gradient if needed) so contrast is strong.",
    reservedZones
      ? `Keep text and busy detail out of: ${reservedZones}`
      : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const PHOTOGRAPHY_STYLE_PHRASE: Record<string, string> = {
  PHOTOGRAPHIC: "Photographic, camera-realistic imagery.",
  ILLUSTRATED: "Illustrated / hand-drawn artwork style, not photorealistic.",
  // Deliberately can read as contradicting the global AVOID line's "glossy
  // 3D-render sheen" — a brand that explicitly picks this style has opted
  // into that look; the global default is the fallback, not a hard rule.
  THREE_D_RENDER: "Clean 3D-rendered / CGI illustration style.",
  FLAT_DESIGN:
    "Flat, minimal graphic design — solid shapes and color blocks, no photographic realism.",
  MIXED:
    "A stylish mix of photographic and illustrated elements, whichever best fits the subject.",
};

const BACKGROUND_TONE_PHRASE: Record<string, string> = {
  LIGHT: "Prefer a light, airy background.",
  DARK: "Prefer a dark, moody background.",
  BRAND_COLORED:
    "Prefer a background tinted toward the brand's own palette rather than neutral.",
};

type ExtractedBrandStyle = {
  // BRAND section — positioning, tone, colors, background preference.
  brandLine: string | null;
  // Appended to the global STYLE_AND_LIGHTING baseline.
  styleAddition: string | null;
  // Appended to the global AVOID baseline.
  avoidAddition: string | null;
  // Appended to the COMPOSITION section.
  compositionAddition: string | null;
};

function colorLine(
  label: string,
  swatches: BrandVisualIdentityContext["primaryColors"],
): string | null {
  if (!swatches.length) return null;
  const list = swatches
    .map((swatch) =>
      swatch.name ? `${swatch.name} (${swatch.hex})` : swatch.hex,
    )
    .join(", ");
  return `${label}: ${list}`;
}

// Structured BrandVisualIdentity data (see brand-style-context.ts) takes
// priority when present; a brand that hasn't configured it yet falls back
// to today's defensive summarization of the legacy
// visualGuidelines/approvedColors Json fields — same output as before this
// feature existed, so nothing changes for brands that haven't opted in.
function extractFromVisualIdentity(
  identity: BrandVisualIdentityContext,
): Omit<ExtractedBrandStyle, "brandLine"> & { colorLines: string[] } {
  const colorLines = [
    colorLine("Primary brand colors (dominant)", identity.primaryColors),
    colorLine("Secondary colors", identity.secondaryColors),
    colorLine("Accent colors", identity.accentColors),
  ].filter((line): line is string => Boolean(line));

  const stylePieces = [
    identity.photographyStyle
      ? PHOTOGRAPHY_STYLE_PHRASE[identity.photographyStyle]
      : null,
    identity.styleRefinement?.trim() || null,
    identity.moodTags.length
      ? `Mood/aesthetic: ${identity.moodTags.join(", ")}.`
      : null,
  ].filter((piece): piece is string => Boolean(piece));

  return {
    colorLines,
    styleAddition: stylePieces.length ? stylePieces.join(" ") : null,
    avoidAddition: identity.alwaysAvoid.length
      ? identity.alwaysAvoid.join(", ")
      : null,
    compositionAddition: identity.compositionNotes?.trim() || null,
  };
}

// Guards against a real field-name collision: BrandConstitution.payload
// already has its own `visualIdentity` field (an AI-synthesized free-text
// STRING — see constitution-synthesis.ts), and creative-actions.ts spreads
// getBrandContext()'s raw constitution payload into brandContext before
// overriding visualIdentity with the structured shape. If any call site
// ever forgets that override, ctx.visualIdentity is a string, not this
// module's structured object — treating it as one without checking would
// crash on `.primaryColors.length` instead of just falling back cleanly.
function isStructuredVisualIdentity(
  value: unknown,
): value is BrandVisualIdentityContext {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { primaryColors?: unknown }).primaryColors)
  );
}

function extractBrandStyle(brandContext: unknown): ExtractedBrandStyle {
  const empty: ExtractedBrandStyle = {
    brandLine: null,
    styleAddition: null,
    avoidAddition: null,
    compositionAddition: null,
  };
  if (!brandContext || typeof brandContext !== "object") return empty;
  const ctx = brandContext as Record<string, unknown>;
  const brandLineParts: string[] = [];

  const positioning = ctx.positioning;
  if (typeof positioning === "string" && positioning.trim())
    brandLineParts.push(positioning.trim());

  const tone = ctx.toneOfVoice;
  if (typeof tone === "string" && tone.trim())
    brandLineParts.push(`Tone: ${tone.trim()}`);

  const identity = isStructuredVisualIdentity(ctx.visualIdentity)
    ? ctx.visualIdentity
    : null;
  let styleAddition: string | null = null;
  let avoidAddition: string | null = null;
  let compositionAddition: string | null = null;

  if (identity) {
    const extracted = extractFromVisualIdentity(identity);
    brandLineParts.push(...extracted.colorLines);
    if (
      identity.backgroundTone &&
      identity.backgroundTone !== "NO_PREFERENCE"
    ) {
      const phrase = BACKGROUND_TONE_PHRASE[identity.backgroundTone];
      if (phrase) brandLineParts.push(phrase);
    }
    if (identity.alwaysInclude.length) {
      brandLineParts.push(identity.alwaysInclude.join(". "));
    }
    styleAddition = extracted.styleAddition;
    avoidAddition = extracted.avoidAddition;
    compositionAddition = extracted.compositionAddition;
  } else {
    // Legacy fallback — same summarization this file always used before
    // BrandVisualIdentity existed.
    const visualGuidelines = summarizeJsonField(ctx.visualGuidelines);
    if (visualGuidelines)
      brandLineParts.push(`Visual guidelines: ${visualGuidelines}`);

    const colors = summarizeJsonField(ctx.approvedColors);
    if (colors)
      brandLineParts.push(`Brand colors to favour in the scene: ${colors}`);
  }

  return {
    brandLine: brandLineParts.length > 0 ? brandLineParts.join(" ") : null,
    styleAddition,
    avoidAddition,
    compositionAddition,
  };
}

// Fields like legacy approvedColors/visualGuidelines aren't tied to a
// structured schema (free-form Json in BrandDossier, see schema.prisma) —
// this reduces them to a short, readable sentence regardless of whether
// they arrive as a string/array/object. Returns null when empty/undefined
// so no unnecessary line gets added to the prompt.
function summarizeJsonField(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const named = entry as { name?: unknown; hex?: unknown };
          if (typeof named.hex === "string") {
            return typeof named.name === "string"
              ? `${named.name} (${named.hex})`
              : named.hex;
          }
        }
        return null;
      })
      .filter((entry): entry is string => Boolean(entry));
    return items.length > 0 ? items.join(", ") : null;
  }
  return null;
}

export function buildCreativePrompt({
  subject,
  brandContext,
  platformLabel,
  contentFormatLabel,
  pixelSize,
  safeZone,
  hasStyleReference,
  reservedZones,
  layoutComposition,
  typography,
  postStyle,
  matchStyle,
  textArea,
  extraAvoid,
}: CreativePromptInput): string {
  const { brandLine, styleAddition, avoidAddition, compositionAddition } =
    extractBrandStyle(brandContext);

  const compositionParts = [
    platformLabel
      ? `Framed for a ${platformLabel}${contentFormatLabel ? ` ${contentFormatLabel}` : ""} post — clean negative space where a headline or logo could later be placed.`
      : "Clean, uncluttered composition with room for a headline.",
  ];
  if (pixelSize) {
    compositionParts.push(
      `Output canvas: exactly ${pixelSize.width}x${pixelSize.height}px. Compose the full frame to fill this canvas — no letterboxing, no padding bars.`,
    );
  }
  if (safeZone?.top || safeZone?.bottom) {
    const zones = [
      safeZone.top ? `the top ~${safeZone.top}px` : null,
      safeZone.bottom ? `the bottom ~${safeZone.bottom}px` : null,
    ]
      .filter((zone): zone is string => Boolean(zone))
      .join(" and ");
    compositionParts.push(
      `This is a full-screen vertical format: keep all critical subject matter and any on-image text out of ${zones}, reserved for the platform's own UI overlays (profile icon, captions, controls).`,
    );
  }
  if (hasStyleReference) {
    compositionParts.push(
      "A brand style-reference image is attached as the first image — match its visual style, color palette, and mood, but do NOT copy any logo, text, or literal subject matter from it into the new image.",
    );
  }
  if (compositionAddition) compositionParts.push(compositionAddition);
  // The examples decide the layout when the kit asks to follow them.
  if (layoutComposition && !matchStyle) {
    compositionParts.push(layoutComposition);
  }
  if (reservedZones) {
    compositionParts.push(
      `Keep the main subject clear of these areas, which are covered afterwards: ${reservedZones}`,
    );
  }
  const wordsSetAfter = Boolean(textArea) && !typography;
  if (wordsSetAfter) {
    compositionParts.push(
      `The post's headline is typeset onto the image afterwards ${textArea}: keep that area calm, uncluttered and low-detail, with no text of any kind${matchStyle ? " (where the reference posts carry text, leave clean space instead)" : ""}.`,
    );
  }

  const avoid = `Avoid: ${typography ? AVOID_EDITORIAL_TEXT : wordsSetAfter ? AVOID_TEXT_SET_AFTER : AVOID_TEXTLESS}${AVOID_REST}`;

  return [
    `SUBJECT: ${subject}`,
    postStyle ? `POST STYLE KIT:\n${postStyle}` : null,
    `STYLE & LIGHTING: ${[typography ? EDITORIAL_BASELINE : STYLE_AND_LIGHTING, styleAddition].filter(Boolean).join(" ")}`,
    `COMPOSITION: ${compositionParts.join(" ")}`,
    typography
      ? `TYPOGRAPHY: ${typographyBlock(typography, reservedZones, matchStyle)}`
      : null,
    brandLine ? `BRAND: ${brandLine}` : null,
    `AVOID: ${[avoid, avoidAddition, extraAvoid ? `For this picture: ${extraAvoid}.` : null].filter(Boolean).join(" ")}`,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
