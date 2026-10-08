import { z } from "zod";

import { HEADLINE_ZONES, LAYOUT_LOGO_POSITIONS } from "@/lib/layout-templates";

// The brand's Post Style Kit: example posts (pictures the client gave, or links
// to them) plus standing instructions that every post is made by. The examples
// are reverse-engineered once into a written design recipe and are sent to the
// image model as reference pictures on every render, so a new post comes out in
// the same design as the examples, with only its content (the product, the
// words) changed.
//
// Stored as BrandFact rows of one category (no schema change): one row per
// example (`example:<assetId>`) and one for the standing instructions
// (`directives`). This module is pure and client-safe.

export const POST_STYLE_CATEGORY = "post_style";
export const DIRECTIVES_KEY = "directives";
export const EXAMPLE_KEY_PREFIX = "example:";

// How many examples a brand keeps, and how many of them go to the model as
// pictures on one render (more pictures cost more and blur the brief).
export const MAX_EXAMPLES = 12;
export const MAX_REFERENCES_PER_RENDER = 3;
export const MAX_DIRECTIVES_CHARS = 2000;
export const MAX_LABEL_CHARS = 60;
// Extra on-image texts (sub-headline, price, button label...) of one post.
export const MAX_ON_IMAGE_LINES = 6;
export const MAX_ON_IMAGE_LINE_CHARS = 80;

export const FIDELITIES = ["match", "inspired"] as const;
export type PostStyleFidelity = (typeof FIDELITIES)[number];

export const EXAMPLE_SOURCES = ["upload", "link", "chat", "liked"] as const;
export type PostStyleExampleSource = (typeof EXAMPLE_SOURCES)[number];

// A clipped, single-spaced string. `.pipe(z.string())` keeps z.toJSONSchema()
// working (a bare .transform() cannot be turned into a JSON schema), and the
// default turns a field the model left out into "" instead of a failed parse.
function text(max: number) {
  return z
    .string()
    .default("")
    .transform((value) => value.replace(/\s+/g, " ").trim().slice(0, max))
    .pipe(z.string());
}

// What a design director reads off one example post, in words another designer
// could rebuild the post from with a different product.
// The few design facts the compositing can act on, read off an example (the
// rest of the analysis is prose for the image model). "none" = the example has
// no such element.
export const PostStyleTraitsSchema = z.object({
  logoCorner: z.enum([...LAYOUT_LOGO_POSITIONS, "none"]),
  headlineZone: z.enum([...HEADLINE_ZONES, "none"]),
  headlineAlign: z.enum(["left", "center"]),
  headlineScale: z.enum(["M", "L", "XL"]),
  bar: z.enum(["none", "line", "band"]),
});
export type PostStyleTraits = z.infer<typeof PostStyleTraitsSchema>;

export const PostStyleAnalysisSchema = z.object({
  summary: text(160),
  layout: text(500),
  typography: text(400),
  colors: text(300),
  product: text(400),
  graphics: text(400),
  background: text(300),
  mood: text(160),
  // The whole design as one instruction a model can follow.
  recipe: text(900),
  // Absent on analyses made before it existed.
  traits: PostStyleTraitsSchema.optional(),
});
export type PostStyleAnalysis = z.infer<typeof PostStyleAnalysisSchema>;

export const PostStyleExampleSchema = z.object({
  assetId: z.string().min(1).max(64),
  label: z.string().trim().max(MAX_LABEL_CHARS).default(""),
  source: z.enum(EXAMPLE_SOURCES).default("upload"),
  // Where a link example came from.
  url: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  analysis: PostStyleAnalysisSchema.nullable().default(null),
  addedAt: z.string().default(""),
});
export type PostStyleExample = z.infer<typeof PostStyleExampleSchema>;

export const PostStyleDirectivesSchema = z.object({
  text: z.string().max(MAX_DIRECTIVES_CHARS).default(""),
  fidelity: z.enum(FIDELITIES).default("match"),
});
export type PostStyleDirectives = z.infer<typeof PostStyleDirectivesSchema>;

export const EMPTY_DIRECTIVES: PostStyleDirectives = {
  text: "",
  fidelity: "match",
};

export function exampleKey(assetId: string): string {
  return `${EXAMPLE_KEY_PREFIX}${assetId}`;
}

export function parseExample(value: unknown): PostStyleExample | null {
  const parsed = PostStyleExampleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseDirectives(value: unknown): PostStyleDirectives {
  const parsed = PostStyleDirectivesSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_DIRECTIVES;
}

// What a generation reads (frozen into the brand context): the standing
// instructions and the examples that are switched on, newest first.
export type PostStyleContextExample = {
  assetId: string;
  label: string;
  analysis: PostStyleAnalysis | null;
};
export type PostStyleContext = {
  fidelity: PostStyleFidelity;
  directives: string;
  examples: PostStyleContextExample[];
};

// What the examples agree on, for the automatic design to follow: the most
// common value of each trait among the enabled, analysed examples. Null when
// none carries traits.
export function postStyleTraitsOf(
  context: PostStyleContext | null | undefined,
): PostStyleTraits | null {
  const all = (context?.examples ?? []).flatMap((example) =>
    example.analysis?.traits ? [example.analysis.traits] : [],
  );
  if (all.length === 0) return null;
  const most = <K extends keyof PostStyleTraits>(key: K): PostStyleTraits[K] => {
    const counts = new Map<PostStyleTraits[K], number>();
    for (const traits of all) {
      counts.set(traits[key], (counts.get(traits[key]) ?? 0) + 1);
    }
    // Ties go to the newest example (the list is newest first).
    let best = all[0]![key];
    let bestCount = 0;
    for (const traits of all) {
      const count = counts.get(traits[key])!;
      if (count > bestCount) {
        best = traits[key];
        bestCount = count;
      }
    }
    return best;
  };
  return {
    logoCorner: most("logoCorner"),
    headlineZone: most("headlineZone"),
    headlineAlign: most("headlineAlign"),
    headlineScale: most("headlineScale"),
    bar: most("bar"),
  };
}

// Null when the kit holds nothing a render could use.
export function buildPostStyleContext(input: {
  directives: PostStyleDirectives;
  examples: readonly PostStyleExample[];
}): PostStyleContext | null {
  const enabled = input.examples
    .filter((example) => example.enabled)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .map((example) => ({
      assetId: example.assetId,
      label: example.label,
      analysis: example.analysis,
    }));
  const directives = input.directives.text.trim();
  if (enabled.length === 0 && !directives) return null;
  return {
    fidelity: input.directives.fidelity,
    directives,
    examples: enabled,
  };
}

// The examples that go to the model as pictures: the ones a request names (the
// agent picked them for this post), else the newest. At most
// MAX_REFERENCES_PER_RENDER, in that order.
export function pickReferenceExamples(
  context: PostStyleContext | null | undefined,
  wantedIds?: readonly string[],
): PostStyleContextExample[] {
  if (!context) return [];
  const wanted = (wantedIds ?? []).flatMap((id) => {
    const found = context.examples.find((example) => example.assetId === id);
    return found ? [found] : [];
  });
  const chosen = wanted.length > 0 ? wanted : context.examples;
  return chosen.slice(0, MAX_REFERENCES_PER_RENDER);
}

const DIRECTIVES_LEAD =
  "The brand's standing post instructions. They apply to EVERY post and override any other taste:";

// The prompt section for a render that uses the kit. `referenceCount` and
// `productCount` are the pictures actually attached (examples first, then the
// real product), so the wording never promises an image that is not there.
export function postStyleSection(input: {
  // Null: no kit, only a real product picture was given for this post.
  context: PostStyleContext | null;
  examples: readonly PostStyleContextExample[];
  referenceCount: number;
  productCount: number;
}): string | null {
  const { context, referenceCount, productCount } = input;
  const parts: string[] = [];

  if (context && referenceCount > 0) {
    parts.push(
      context.fidelity === "match"
        ? `REFERENCE POSTS: the first ${referenceCount} attached image${referenceCount === 1 ? " is an example post" : "s are example posts"} from this brand's own feed — the design standard. Recreate that design as faithfully as you can: the same layout and composition, text zones and hierarchy, typography treatment, graphic elements (badges, frames, buttons, interface mock-ups), colour treatment, background style and overall finish, so the new post clearly belongs to the same series. Change ONLY the content: the product or subject and the words. Never carry over another brand's logo or its own wording. Do not draw any logo or brand mark: the brand's real logo is added afterwards.`
        : `REFERENCE POSTS: the first ${referenceCount} attached image${referenceCount === 1 ? " is an example post" : "s are example posts"} of this brand's post style. Take their layout logic, typography feel, colour treatment and mood as the design direction; the composition may adapt to the new subject. Never carry over another brand's logo or its own wording. Do not draw any logo or brand mark: the brand's real logo is added afterwards.`,
    );
  }

  if (productCount > 0) {
    parts.push(
      `PRODUCT: the ${productCount === 1 ? "next attached image shows" : `next ${productCount} attached images show`} the REAL product of this post. Show exactly that product, prominently and in the design of the reference posts: its shape, proportions, colours, materials, screen or label details and branding reproduced faithfully. Do not redesign, replace or invent the product.`,
    );
  }

  const recipes = input.examples
    .flatMap((example) => {
      const recipe = example.analysis?.recipe.trim();
      return recipe ? [recipe] : [];
    })
    .slice(0, MAX_REFERENCES_PER_RENDER);
  if (recipes.length > 0) {
    parts.push(
      `DESIGN NOTES FROM THE EXAMPLES:\n${recipes.map((recipe) => `- ${recipe}`).join("\n")}`,
    );
  }

  const directives = context?.directives.trim();
  if (directives) parts.push(`${DIRECTIVES_LEAD} ${directives}`);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// The one-line digest the chat agent reads for each example.
export function exampleSummary(example: {
  label: string;
  analysis: PostStyleAnalysis | null;
}): string {
  return (
    example.analysis?.summary.trim() ||
    example.label.trim() ||
    "Example post (not analysed yet)"
  );
}
