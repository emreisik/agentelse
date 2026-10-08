// The Google Fonts a brand can pick for the words on its posts. A curated
// list, not the whole library: families that are proven on social feeds, read
// well at headline size and have the Latin Extended letters (Turkish ğ ş ı İ,
// and the like) the brands we serve write in. The typesetter fetches the chosen
// family from Google Fonts when it renders (creative-text.ts), so every name
// here must be a real Google Fonts family.

export type FontMood =
  | "Modern sans"
  | "Friendly sans"
  | "Classic sans"
  | "Elegant serif"
  | "Bold display";

export type CuratedFont = { family: string; mood: FontMood; note: string };

export const FONT_MOODS: FontMood[] = [
  "Modern sans",
  "Friendly sans",
  "Classic sans",
  "Elegant serif",
  "Bold display",
];

export const CURATED_FONTS: readonly CuratedFont[] = [
  { family: "Montserrat", mood: "Modern sans", note: "The feed default: clean, wide, confident" },
  { family: "Poppins", mood: "Modern sans", note: "Geometric and friendly, great in bold" },
  { family: "Inter", mood: "Modern sans", note: "Neutral and sharp, built for screens" },
  { family: "DM Sans", mood: "Modern sans", note: "Soft geometric, calm and modern" },
  { family: "Outfit", mood: "Modern sans", note: "Rounded geometry, fresh brands" },
  { family: "Manrope", mood: "Modern sans", note: "Precise and techy, a SaaS favourite" },
  { family: "Plus Jakarta Sans", mood: "Modern sans", note: "Polished startup look" },
  { family: "Space Grotesk", mood: "Modern sans", note: "Distinctive, design-led" },
  { family: "Sora", mood: "Modern sans", note: "Wide and futuristic" },
  { family: "Urbanist", mood: "Modern sans", note: "Light, airy, lifestyle" },
  { family: "Work Sans", mood: "Modern sans", note: "Grounded and professional" },
  { family: "Nunito", mood: "Friendly sans", note: "Rounded terminals, warm and approachable" },
  { family: "Rubik", mood: "Friendly sans", note: "Slightly rounded, playful but sturdy" },
  { family: "Lexend", mood: "Friendly sans", note: "Very readable, open letterforms" },
  { family: "Roboto", mood: "Classic sans", note: "Familiar and neutral" },
  { family: "Open Sans", mood: "Classic sans", note: "Humanist, universally readable" },
  { family: "Lato", mood: "Classic sans", note: "Warm and stable" },
  { family: "Raleway", mood: "Classic sans", note: "Elegant thin-to-bold range" },
  { family: "Source Sans 3", mood: "Classic sans", note: "Clear and practical" },
  { family: "Barlow", mood: "Classic sans", note: "Slightly condensed, sporty" },
  { family: "Playfair Display", mood: "Elegant serif", note: "High-contrast, fashion and luxury" },
  { family: "Cormorant Garamond", mood: "Elegant serif", note: "Refined, light, boutique" },
  { family: "Lora", mood: "Elegant serif", note: "Calligraphic and warm, editorial" },
  { family: "Merriweather", mood: "Elegant serif", note: "Sturdy and trustworthy" },
  { family: "DM Serif Display", mood: "Elegant serif", note: "Dramatic, magazine headlines" },
  { family: "Fraunces", mood: "Elegant serif", note: "Soft, characterful, crafty" },
  { family: "Libre Baskerville", mood: "Elegant serif", note: "Classic book serif" },
  { family: "Bebas Neue", mood: "Bold display", note: "Tall, all-caps posters" },
  { family: "Anton", mood: "Bold display", note: "Heavy condensed, loud promos" },
  { family: "Oswald", mood: "Bold display", note: "Condensed and punchy" },
  { family: "Archivo Black", mood: "Bold display", note: "Very heavy, impactful" },
  { family: "Abril Fatface", mood: "Bold display", note: "Fat-face serif, fashion posters" },
];

const FAMILY_NAME = /^[A-Za-z0-9][A-Za-z0-9 .\-]{0,58}$/;

export function isFamilyName(name: string): boolean {
  return FAMILY_NAME.test(name);
}

export function curatedFont(family: string): CuratedFont | undefined {
  const key = family.trim().toLowerCase();
  return CURATED_FONTS.find((font) => font.family.toLowerCase() === key);
}

// One stylesheet for many families (regular and bold), so a gallery of fonts
// costs one request. Families that lack a weight simply serve what they have.
export function googleFontsStylesheetUrl(families: readonly string[]): string {
  const params = families
    .filter(isFamilyName)
    .map(
      (family) =>
        `family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;700`,
    );
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}

// The font list after choosing a headline font: the choice first (it is the
// one the post words are set in), then the others the brand already had.
export function withHeadlineFont(
  current: readonly string[],
  chosen: string,
): string[] {
  const key = chosen.trim().toLowerCase();
  return [
    chosen.trim(),
    ...current.filter((name) => name.trim().toLowerCase() !== key),
  ].slice(0, 3);
}
