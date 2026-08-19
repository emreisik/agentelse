import "server-only";

// Turns a bare subject description into the structured brief real ad-tool
// prompt templates converge on (Subject / Style+Lighting / Composition /
// Brand / Avoid) instead of a single unguided sentence. Two things this
// buys, backed by 2026 prompting research for Gemini-class image models:
// explicit photography vocabulary pushes output away from the generic
// "AI-rendered" look, and a natural-language "avoid" block stands in for
// the negative-prompt field these models don't expose.
export type CreativePromptInput = {
  subject: string;
  // Whatever ConstitutionService.getBrandContext()/the task's brandContext
  // payload returns — shape varies (constitution vs. dossier fallback), so
  // this is read defensively rather than typed against one source.
  brandContext?: unknown;
  platformLabel?: string;
  // Human label for the content-type slot, e.g. "Story (9:16)" — see
  // src/lib/creative-platform-format.ts. Only meaningful together with
  // platformLabel.
  contentFormatLabel?: string;
  // Exact target canvas — stated explicitly so the model composes to fill
  // it rather than leaving letterboxing; creative-image.ts still normalizes
  // the actual output with sharp afterward, since Gemini's aspectRatio
  // param is best-effort, not a guarantee.
  pixelSize?: { width: number; height: number };
  // Approximate top/bottom margin, in px, reserved by the platform's own UI
  // chrome on full-screen vertical formats (Story/Reel/Shorts) — keeps
  // critical subject matter and on-image text out of that band.
  safeZone?: { top?: number; bottom?: number };
  // The headline text to render on the image — if given, a "render this
  // text" instruction is added to the composition; if omitted, it can
  // stay textless as before.
  caption?: string;
  // True if the caller is actually passing a referenceImage (see
  // brand-logo.ts) — so the "attached logo" instruction is only written
  // into the prompt text when an image is actually being attached.
  hasLogoReference?: boolean;
};

const STYLE_AND_LIGHTING =
  "Professional, polished social-media/marketing graphic design — " +
  "photographic, illustrated, or a stylish mix, whichever best fits the " +
  "subject. Clean, intentional, on-brand — not a generic AI-rendered look.";

const AVOID =
  "Avoid: airbrushed skin, plastic/waxy texture, over-smoothed CGI look, " +
  "perfectly symmetrical artificial composition, glossy 3D-render sheen, " +
  "stock-photo watermarks, distorted text, extra or malformed limbs. " +
  "Prefer: visible natural texture, subtle imperfections, natural " +
  "asymmetry, candid unposed framing, faint natural film grain.";

// The actual shape of brandContext — see
// src/server/context/context-builder.ts (buildExecutionContext, the
// CREATE_SOCIAL_CREATIVE/CREATE_AD_CREATIVE fields). `identity`/`visualIdentity`
// never appear in these capabilities' context (they only exist in
// BrandConstitution.payload, which itself isn't in the fields list) — not
// looking for them here is deliberate; the wrong field names that used to
// be here never matched anything.
function extractBrandStyle(brandContext: unknown): string | null {
  if (!brandContext || typeof brandContext !== "object") return null;
  const ctx = brandContext as Record<string, unknown>;
  const parts: string[] = [];

  const positioning = ctx.positioning;
  if (typeof positioning === "string" && positioning.trim())
    parts.push(positioning.trim());

  const tone = ctx.toneOfVoice;
  if (typeof tone === "string" && tone.trim())
    parts.push(`Tone: ${tone.trim()}`);

  const visualGuidelines = summarizeJsonField(ctx.visualGuidelines);
  if (visualGuidelines) parts.push(`Visual guidelines: ${visualGuidelines}`);

  const colors = summarizeJsonField(ctx.approvedColors);
  if (colors) parts.push(`Brand colors to favour in the scene: ${colors}`);

  return parts.length > 0 ? parts.join(" ") : null;
}

// Fields like approvedColors/visualGuidelines aren't tied to a structured
// schema yet (free-form Json in BrandDossier, see schema.prisma) — this
// reduces them to a short, readable sentence regardless of whether they
// arrive as a string/array/object. Returns null when empty/undefined so no
// unnecessary line gets added to the prompt.
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
  caption,
  hasLogoReference,
}: CreativePromptInput): string {
  const brandStyle = extractBrandStyle(brandContext);
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
  if (caption?.trim()) {
    compositionParts.push(
      `Include the headline text: "${caption.trim()}" — rendered legibly, in a style consistent with the brand tone.`,
    );
  }
  if (hasLogoReference) {
    compositionParts.push(
      "A reference image of the brand's real logo is attached as the first image — incorporate it accurately and tastefully into the design; do not redraw, reinterpret, or distort it.",
    );
  }

  return [
    `SUBJECT: ${subject}`,
    `STYLE & LIGHTING: ${STYLE_AND_LIGHTING}`,
    `COMPOSITION: ${compositionParts.join(" ")}`,
    brandStyle ? `BRAND: ${brandStyle}` : null,
    `AVOID: ${AVOID}`,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
