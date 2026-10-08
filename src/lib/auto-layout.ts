import type { PostStyleTraits } from "@/lib/post-style";
import {
  aspectClassOf,
  type AspectClass,
  type HeadlineZone,
  type LayoutTemplate,
} from "@/lib/layout-templates";

// The automatic post design. Nobody configures a layout: it is derived from
// what the brand is (an archetype), the canvas it is drawn on (format and
// platform safe zones) and the brand's colours. The result is an ordinary
// LayoutTemplate, so the existing compositing (logo, bar / band, headline)
// runs unchanged. A brand that saves its own layouts still wins over this.
//
// The archetypes are the handful of looks that cover how brands in a category
// usually present their posts, written down once instead of asked of every
// user. Pure and client-safe.

export const ARCHETYPES = [
  "editorial",
  "statement",
  "product",
  "promo",
  "info",
  "minimal-luxe",
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

// The designs a brand picks from. No bars, bands or lines: every design is the
// picture, a headline and the logo, placed with care.
export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  editorial: "Editorial",
  statement: "Statement",
  product: "Bottom headline",
  promo: "Poster",
  info: "Column",
  "minimal-luxe": "Minimal",
};

export const ARCHETYPE_HINT: Record<Archetype, string> = {
  editorial: "Headline across the top, small logo in the corner. Fits most brands.",
  statement: "One big centered line with the logo above it. Bold and simple.",
  product: "Headline low on the picture, logo up in the corner. Lets the subject lead.",
  promo: "A huge headline in the upper left, logo at the bottom right. For offers and launches.",
  info: "A text column on the left, the subject on the right. For services and explainers.",
  "minimal-luxe": "No headline, only a small centered logo. Lets the photo speak.",
};

export function isArchetype(value: unknown): value is Archetype {
  return (
    typeof value === "string" &&
    (ARCHETYPES as readonly string[]).includes(value)
  );
}

// --- classification (deterministic, no model) -----------------------------------

// Words that point at a look, in the brand's own text (Turkish and English).
// Matched as substrings of the lower-cased text, so stems work for Turkish
// suffixes.
const KEYWORDS: Record<
  Exclude<Archetype, "editorial" | "statement">,
  string[]
> = {
  promo: [
    "indirim",
    "kampanya",
    "fırsat",
    "outlet",
    "e-ticaret",
    "eticaret",
    "perakende",
    "market",
    "mağaza",
    "sale",
    "discount",
    "retail",
    "e-commerce",
    "ecommerce",
    "marketplace",
    "supermarket",
  ],
  product: [
    "ürün",
    "kozmetik",
    "güzellik",
    "bakım",
    "gıda",
    "yiyecek",
    "kafe",
    "cafe",
    "restoran",
    "restaurant",
    "bakery",
    "fırın",
    "giyim",
    "moda",
    "tekstil",
    "mobilya",
    "furniture",
    "ayakkabı",
    "beauty",
    "cosmetic",
    "skincare",
    "food",
    "beverage",
    "coffee",
    "kahve",
    "fashion",
    "apparel",
    "product",
    "emlak",
    "gayrimenkul",
    "real estate",
    "otomotiv",
    "automotive",
  ],
  "minimal-luxe": [
    "lüks",
    "luxury",
    "butik",
    "boutique",
    "mücevher",
    "jewel",
    "premium",
    "atelier",
    "spa",
    "wellness",
    "fine dining",
    "interior",
    "iç mimar",
    "mimari",
    "architect",
    "sanat",
    "gallery",
    "galeri",
    "parfüm",
    "perfume",
  ],
  info: [
    "yazılım",
    "software",
    "saas",
    "b2b",
    "danışmanlık",
    "consult",
    "ajans",
    "agency",
    "eğitim",
    "education",
    "kurs",
    "academy",
    "akademi",
    "klinik",
    "clinic",
    "sağlık",
    "health",
    "hastane",
    "diş",
    "dental",
    "hukuk",
    "law",
    "avukat",
    "finans",
    "finance",
    "sigorta",
    "insurance",
    "muhasebe",
    "accounting",
    "teknoloji",
    "technology",
    "platform",
    "lojistik",
    "logistics",
  ],
};

const MOOD_BOOST: Record<string, Archetype> = {
  luxury: "minimal-luxe",
  luxurious: "minimal-luxe",
  elegant: "minimal-luxe",
  minimal: "minimal-luxe",
  minimalist: "minimal-luxe",
  refined: "minimal-luxe",
  lüks: "minimal-luxe",
  zarif: "minimal-luxe",
  sade: "minimal-luxe",
  bold: "promo",
  energetic: "promo",
  playful: "promo",
  vibrant: "promo",
  cesur: "promo",
  enerjik: "promo",
  trustworthy: "info",
  professional: "info",
  corporate: "info",
  güvenilir: "info",
  kurumsal: "info",
  profesyonel: "info",
};

// Ties go to the earlier one.
const TIE_ORDER: Archetype[] = ["product", "info", "minimal-luxe", "promo"];

export function classifyArchetype(input: {
  // Whatever the brand says about itself: summary, positioning, business
  // model, products, services.
  text: string;
  moodTags?: string[];
}): Archetype {
  const text = input.text.toLocaleLowerCase("tr");
  const scores: Record<Archetype, number> = {
    editorial: 0,
    statement: 0,
    product: 0,
    promo: 0,
    "minimal-luxe": 0,
    info: 0,
  };
  for (const [archetype, words] of Object.entries(KEYWORDS) as [
    keyof typeof KEYWORDS,
    string[],
  ][]) {
    for (const word of words) {
      if (text.includes(word)) scores[archetype] += 1;
    }
  }
  for (const tag of input.moodTags ?? []) {
    const boosted = MOOD_BOOST[tag.trim().toLocaleLowerCase("tr")];
    if (boosted) scores[boosted] += 1.5;
  }

  let best: Archetype = "editorial";
  let bestScore = 0;
  for (const archetype of TIE_ORDER) {
    if (scores[archetype] > bestScore) {
      best = archetype;
      bestScore = scores[archetype];
    }
  }
  return best;
}

// --- layout ---------------------------------------------------------------------

type Canvas = { width: number; height: number };

const DEFAULT_CANVAS: Canvas = { width: 1080, height: 1350 };

const COMPOSITION: Record<HeadlineZone, string> = {
  TOP: "Keep the upper third calm and low-detail so the headline reads clearly; place the main subject in the lower two thirds.",
  UPPER_LEFT:
    "Keep the upper-left area calm and low-detail for the headline; the subject sits to the right and lower.",
  CENTER:
    "Keep the center of the frame calm and evenly toned so the headline reads clearly across it; busy detail stays toward the edges.",
  LEFT_COLUMN:
    "Keep the left half of the frame calm and low-detail for the text column; place the subject on the right.",
  BOTTOM:
    "Keep the lower third calm and low-detail for the headline; place the main subject in the upper two thirds.",
};

const NO_HEADLINE: LayoutTemplate["headline"] = {
  enabled: false,
  zone: "TOP",
  align: "center",
  maxLines: 3,
  scale: "L",
};

const NO_BAR: LayoutTemplate["bar"] = {
  enabled: false,
  position: "BOTTOM",
  heightPercent: 4,
  style: "line",
  color: "accent",
};

// The same physical margin on every format: 4% of the short side, expressed as
// the percent of the width the compositor takes.
function marginPercent(canvas: Canvas): number {
  const short = Math.min(canvas.width, canvas.height);
  const percent = (0.04 * short * 100) / canvas.width;
  return Math.max(1, Math.min(15, Math.round(percent)));
}

type Shape = {
  logo: Pick<LayoutTemplate["logo"], "position" | "sizePercent">;
  headline: LayoutTemplate["headline"];
};

const text = (
  zone: HeadlineZone,
  align: "left" | "center",
  scale: "M" | "L" | "XL",
  maxLines: number,
): LayoutTemplate["headline"] => ({
  enabled: true,
  zone,
  align,
  maxLines,
  scale,
});

// Each design, per kind of canvas. On a Story the app covers the top and the
// bottom of the frame: the compositor keeps the logo and the words clear of it.
function shapeFor(archetype: Archetype, aspect: AspectClass): Shape {
  const wide = aspect === "landscape";
  const story = aspect === "vertical";

  switch (archetype) {
    case "statement":
      return {
        logo: {
          position: story ? "CENTER_BOTTOM" : "TOP_CENTER",
          sizePercent: story ? 20 : 14,
        },
        headline: text("CENTER", "center", wide ? "L" : "XL", story ? 5 : 4),
      };
    case "product":
      return {
        logo: { position: "TOP_LEFT", sizePercent: story ? 20 : wide ? 12 : 15 },
        headline: text("BOTTOM", "left", "L", story ? 4 : wide ? 2 : 3),
      };
    case "promo":
      return {
        logo: {
          position: story ? "CENTER_BOTTOM" : "BOTTOM_RIGHT",
          sizePercent: story ? 22 : wide ? 12 : 16,
        },
        headline: wide
          ? text("LEFT_COLUMN", "left", "XL", 4)
          : text("UPPER_LEFT", "left", "XL", story ? 5 : 4),
      };
    case "info":
      return {
        logo: {
          position: story ? "CENTER_BOTTOM" : "TOP_LEFT",
          sizePercent: story ? 20 : wide ? 12 : 15,
        },
        headline: story
          ? text("CENTER", "center", "L", 5)
          : text("LEFT_COLUMN", "left", wide ? "L" : "M", 4),
      };
    case "minimal-luxe":
      return {
        logo: {
          position: "CENTER_BOTTOM",
          sizePercent: story ? 16 : wide ? 11 : 12,
        },
        headline: NO_HEADLINE,
      };
    default:
      return {
        logo: {
          position: story ? "CENTER_BOTTOM" : wide ? "TOP_RIGHT" : "BOTTOM_LEFT",
          sizePercent: story ? 20 : wide ? 11 : 16,
        },
        headline: story
          ? text("CENTER", "center", "L", 4)
          : wide
            ? text("LEFT_COLUMN", "left", "L", 4)
            : text("TOP", "center", "L", 3),
      };
  }
}

// The brand's own example posts, where they agree, decide the placement over
// the design's: the logo corner and the headline zone / alignment / size. Not on
// a Story, whose safe areas leave no room to follow them.
function followExamples(shape: Shape, traits: PostStyleTraits): Shape {
  return {
    logo: {
      position:
        traits.logoCorner === "none" ? shape.logo.position : traits.logoCorner,
      sizePercent: shape.logo.sizePercent,
    },
    headline:
      traits.headlineZone === "none"
        ? NO_HEADLINE
        : text(
            traits.headlineZone,
            traits.headlineAlign,
            traits.headlineScale,
            traits.headlineZone === "LEFT_COLUMN" ? 4 : 3,
          ),
  };
}

export function autoLayoutId(
  archetype: Archetype,
  aspect: AspectClass,
): string {
  return `auto-${archetype}-${aspect}`;
}

// The archetype a stored auto layout id was made with (a revision keeps it).
export function archetypeOfAutoId(
  id: string | null | undefined,
): Archetype | null {
  const match = /^auto-([a-z-]+?)-(portrait|square|landscape|vertical)$/.exec(
    id ?? "",
  );
  return match && isArchetype(match[1]) ? match[1] : null;
}

export function autoLayout(input: {
  archetype: Archetype;
  pixelSize?: Canvas;
  // What the brand's example posts agree on (post-style.ts postStyleTraitsOf).
  traits?: PostStyleTraits | null;
}): LayoutTemplate {
  const canvas = input.pixelSize ?? DEFAULT_CANVAS;
  const aspect = aspectClassOf(canvas);
  let shape = shapeFor(input.archetype, aspect);
  if (input.traits && aspect !== "vertical") {
    shape = followExamples(shape, input.traits);
  }

  return {
    id: autoLayoutId(input.archetype, aspect),
    name: `Auto · ${ARCHETYPE_LABEL[input.archetype]}`,
    description: "Designed automatically from the brand and the post format.",
    formats: [aspect],
    logo: {
      position: shape.logo.position,
      sizePercent: shape.logo.sizePercent,
      marginPercent: marginPercent(canvas),
      onBand: false,
    },
    // No bar, band or line in any design.
    bar: NO_BAR,
    headline: shape.headline,
    composition: shape.headline.enabled ? COMPOSITION[shape.headline.zone] : "",
  };
}
