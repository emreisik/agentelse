import type { ReasoningDef } from "../types";
import {
  PostStyleAnalysisSchema,
  type PostStyleAnalysis,
} from "@/lib/post-style";

// One example post, taken apart into a design recipe. The recipe is what a
// design team would write in a style guide so someone else could rebuild the
// post for another product; it is read by the image model on every render of
// the brand (see lib/post-style.ts postStyleSection). Rare, user-initiated and
// feeds every later post of the brand: the "default" vision tier, not "lite".
export const postStyleExampleDef: ReasoningDef<PostStyleAnalysis> = {
  purpose: "brand.postStyle.analyzeExample",
  schema: PostStyleAnalysisSchema,
  tier: "default" as const,
  maxTokens: 1800,

  buildPrompt(context) {
    const label =
      typeof context.label === "string" && context.label.trim()
        ? context.label.trim()
        : null;
    return {
      system: [
        "You are a senior art director writing the style-guide entry for ONE example social-media post (the attached image), so another designer or an image model can rebuild the same design for a different product.",
        "Describe how the post is BUILT, not what it is about. Be concrete and specific (positions, proportions, weights, colours as hex when you can read them), never vague adjectives.",
        "",
        "summary: one sentence naming the kind of post and its look.",
        "layout: where every element sits (top, centre, left column, bottom band...), their relative sizes, the reading order and the visual hierarchy.",
        "typography: typeface character (serif/sans, weight, case), sizes relative to each other, alignment, colours, any highlighted words, how many text blocks there are and what each does (headline, sub-line, price, button label...).",
        "colors: the dominant background and accent colours with hex codes, and how colour is used for emphasis.",
        "product: how the product or subject is shown (angle, scale, placement, shadow or glow, reflections, cut-out or in a scene), and what surrounds it.",
        "graphics: every non-photographic element (badges, frames, buttons, icons, price tags, interface or phone mock-ups, dividers, gradients, light effects, a logo and where it sits).",
        "background: the background treatment and depth.",
        "mood: the feeling in a few words.",
        "recipe: the whole design as ONE imperative instruction (about 120-170 words) an image model can follow to make a new post in this exact design for any product: name the layout, the text roles, the typography, the colours with hex codes, the product treatment and the graphic elements. Write it so the PRODUCT AND THE WORDS are placeholders (do not name this example's product or copy its wording).",
        "",
        "Base everything strictly on what is visible. Read any text in the image only to understand its ROLE and style. Never invent details.",
      ].join("\n"),
      user: label
        ? `The client calls this example: "${label}".`
        : "Analyse the attached example post.",
    };
  },

  buildMock(context) {
    const label =
      typeof context.label === "string" && context.label.trim()
        ? context.label.trim()
        : "example";
    return {
      summary: `Mock analysis of ${label}.`,
      layout: "Mock layout.",
      typography: "Mock typography.",
      colors: "Mock colours.",
      product: "Mock product treatment.",
      graphics: "Mock graphics.",
      background: "Mock background.",
      mood: "mock",
      recipe: `Mock design recipe derived from ${label}.`,
    };
  },
};
