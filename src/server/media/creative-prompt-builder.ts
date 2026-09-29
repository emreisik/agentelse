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
};

// Global baseline — applies to every generation regardless of brand. A
// brand's Visual Identity settings (see extractBrandStyle below) ADD to
// these, never replace them; this is the quality floor every image starts
// from.
const STYLE_AND_LIGHTING =
  "Professional, polished social-media/marketing graphic design — " +
  "photographic, illustrated, or a stylish mix, whichever best fits the " +
  "subject. Clean, intentional, on-brand — not a generic AI-rendered look.";

const AVOID =
  "Avoid: any text, words, letters, numbers, or typography anywhere in the " +
  "image (no headlines, captions, logos, or watermarks — the image must be " +
  "completely textless; captions are added separately, outside the image), " +
  "airbrushed skin, plastic/waxy texture, over-smoothed CGI look, " +
  "perfectly symmetrical artificial composition, glossy 3D-render sheen, " +
  "stock-photo watermarks, extra or malformed limbs. " +
  "Prefer: visible natural texture, subtle imperfections, natural " +
  "asymmetry, candid unposed framing, faint natural film grain.";

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

  return [
    `SUBJECT: ${subject}`,
    `STYLE & LIGHTING: ${[STYLE_AND_LIGHTING, styleAddition].filter(Boolean).join(" ")}`,
    `COMPOSITION: ${compositionParts.join(" ")}`,
    brandLine ? `BRAND: ${brandLine}` : null,
    `AVOID: ${[AVOID, avoidAddition].filter(Boolean).join(" ")}`,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
