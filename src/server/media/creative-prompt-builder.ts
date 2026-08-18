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
  // Görsele yazılacak başlık metni — verilmişse composition'a "bu metni
  // oku" talimatı eklenir, verilmezse eskisi gibi metinsiz kalabilir.
  caption?: string;
  // Çağıran taraf gerçekten bir referenceImage (bkz. brand-logo.ts)
  // geçiriyorsa true — prompt metnine "ekli logo" talimatı sadece gerçekten
  // bir görsel ekleniyorsa yazılsın diye.
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

// brandContext'in gerçek şekli — bkz. src/server/context/context-builder.ts
// (buildExecutionContext, CREATE_SOCIAL_CREATIVE/CREATE_AD_CREATIVE alanları).
// `identity`/`visualIdentity` bu capability'lerin context'ine hiç girmez
// (yalnızca BrandConstitution.payload'da var, ki o da fields listesinde
// değil) — burada aranmıyor olması bilinçli, eskiden buradaki yanlış alan
// adları hiçbir zaman eşleşmiyordu.
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

// approvedColors/visualGuidelines gibi alanlar henüz yapılandırılmış bir
// şemaya bağlı değil (BrandDossier'da serbest Json, bkz. schema.prisma) —
// string/dizi/obje hangi şekilde gelirse gelsin kısa, okunabilir bir
// cümleye indirger. Boş/tanımsızsa null döner ki prompt'a gereksiz satır
// eklenmesin.
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
  caption,
  hasLogoReference,
}: CreativePromptInput): string {
  const brandStyle = extractBrandStyle(brandContext);
  const compositionParts = [
    platformLabel
      ? `Framed for a ${platformLabel} post — clean negative space where a headline or logo could later be placed.`
      : "Clean, uncluttered composition with room for a headline.",
  ];
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
