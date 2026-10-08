import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MAX_REFERENCES_PER_RENDER,
  PostStyleAnalysisSchema,
  PostStyleDirectivesSchema,
  PostStyleExampleSchema,
  buildPostStyleContext,
  exampleKey,
  exampleSummary,
  parseDirectives,
  parseExample,
  pickReferenceExamples,
  postStyleSection,
  postStyleTraitsOf,
  type PostStyleExample,
  type PostStyleTraits,
} from "./post-style";

const analysis = (recipe = "Dark card, bold headline on top.") => ({
  summary: "Dark premium product ad",
  layout: "",
  typography: "",
  colors: "",
  product: "",
  graphics: "",
  background: "",
  mood: "",
  recipe,
});

const example = (over: Partial<PostStyleExample> = {}): PostStyleExample => ({
  assetId: "a1",
  label: "",
  source: "upload",
  enabled: true,
  analysis: analysis(),
  addedAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

describe("the analysis of an example post", () => {
  it("clips every field, collapses whitespace and fills a missing field with an empty one", () => {
    const parsed = PostStyleAnalysisSchema.parse({
      summary: "  A   dark\n ad ",
      recipe: "x".repeat(2000),
    });
    expect(parsed.summary).toBe("A dark ad");
    expect(parsed.recipe).toHaveLength(900);
    expect(parsed.layout).toBe("");
  });

  it("can be turned into a JSON schema for the model", () => {
    expect(() => z.toJSONSchema(PostStyleAnalysisSchema)).not.toThrow();
  });
});

describe("stored rows", () => {
  it("an example is read back with its defaults, and a broken row is not an example", () => {
    const parsed = parseExample({ assetId: "a1" });
    expect(parsed).toMatchObject({
      assetId: "a1",
      label: "",
      source: "upload",
      enabled: true,
      analysis: null,
    });
    expect(parseExample({ label: "no asset" })).toBeNull();
    expect(parseExample("nope")).toBeNull();
    expect(exampleKey("a1")).toBe("example:a1");
  });

  it("the instructions default to following the examples closely", () => {
    expect(parseDirectives(null)).toEqual({ text: "", fidelity: "match" });
    expect(parseDirectives({ text: "Always dark.", fidelity: "inspired" })).toEqual({
      text: "Always dark.",
      fidelity: "inspired",
    });
    expect(parseDirectives({ text: "x", fidelity: "wild" })).toEqual({
      text: "",
      fidelity: "match",
    });
    expect(PostStyleDirectivesSchema.safeParse({ text: "x".repeat(3000) }).success).toBe(false);
    expect(PostStyleExampleSchema.safeParse({ assetId: "" }).success).toBe(false);
  });
});

describe("buildPostStyleContext", () => {
  it("keeps the switched-on examples, newest first, with the standing instructions", () => {
    const context = buildPostStyleContext({
      directives: { text: " Always dark. ", fidelity: "match" },
      examples: [
        example({ assetId: "old", addedAt: "2026-09-01T00:00:00.000Z" }),
        example({ assetId: "off", enabled: false }),
        example({ assetId: "new", addedAt: "2026-10-02T00:00:00.000Z" }),
      ],
    });
    expect(context?.directives).toBe("Always dark.");
    expect(context?.fidelity).toBe("match");
    expect(context?.examples.map((entry) => entry.assetId)).toEqual(["new", "old"]);
  });

  it("is null when the kit holds nothing a render could use", () => {
    expect(
      buildPostStyleContext({
        directives: { text: "  ", fidelity: "match" },
        examples: [example({ enabled: false })],
      }),
    ).toBeNull();
  });

  it("instructions alone are enough", () => {
    const context = buildPostStyleContext({
      directives: { text: "Always product-focused.", fidelity: "inspired" },
      examples: [],
    });
    expect(context).toEqual({
      fidelity: "inspired",
      directives: "Always product-focused.",
      examples: [],
    });
  });
});

describe("pickReferenceExamples", () => {
  const context = buildPostStyleContext({
    directives: { text: "", fidelity: "match" },
    examples: ["a", "b", "c", "d", "e"].map((id, index) =>
      example({ assetId: id, addedAt: `2026-10-0${index + 1}T00:00:00.000Z` }),
    ),
  });

  it("sends the newest few when nothing is named", () => {
    expect(pickReferenceExamples(context).map((entry) => entry.assetId)).toEqual([
      "e",
      "d",
      "c",
    ]);
    expect(pickReferenceExamples(context)).toHaveLength(MAX_REFERENCES_PER_RENDER);
  });

  it("sends the ones the agent named, in its order, and ignores unknown ids", () => {
    expect(
      pickReferenceExamples(context, ["a", "ghost", "c"]).map((entry) => entry.assetId),
    ).toEqual(["a", "c"]);
    expect(pickReferenceExamples(context, ["ghost"]).map((entry) => entry.assetId)).toEqual([
      "e",
      "d",
      "c",
    ]);
  });

  it("nothing without a kit", () => {
    expect(pickReferenceExamples(null)).toEqual([]);
    expect(pickReferenceExamples(undefined)).toEqual([]);
  });
});

describe("postStyleSection: what the prompt says about the pictures", () => {
  const context = buildPostStyleContext({
    directives: { text: "Always a dark gradient.", fidelity: "match" },
    examples: [example()],
  })!;

  it("match: the examples are the design standard, only the content changes, no logo is drawn", () => {
    const text = postStyleSection({
      context,
      examples: context.examples,
      referenceCount: 2,
      productCount: 0,
    })!;
    expect(text).toContain("the first 2 attached images are example posts");
    expect(text).toContain("Recreate that design as faithfully as you can");
    expect(text).toContain("Change ONLY the content");
    expect(text).toContain("Do not draw any logo or brand mark");
    expect(text).toContain("DESIGN NOTES FROM THE EXAMPLES:\n- Dark card, bold headline on top.");
    expect(text).toContain("override any other taste: Always a dark gradient.");
    expect(text).not.toContain("PRODUCT:");
  });

  it("inspired: direction only", () => {
    const inspired = { ...context, fidelity: "inspired" as const };
    const text = postStyleSection({
      context: inspired,
      examples: inspired.examples,
      referenceCount: 1,
      productCount: 0,
    })!;
    expect(text).toContain("the first 1 attached image is an example post");
    expect(text).toContain("as the design direction");
    expect(text).not.toContain("Recreate that design");
  });

  it("names the real product's pictures only when they are attached", () => {
    const withProduct = postStyleSection({
      context,
      examples: context.examples,
      referenceCount: 1,
      productCount: 2,
    })!;
    expect(withProduct).toContain("next 2 attached images show the REAL product");
    expect(withProduct).toContain("Do not redesign, replace or invent the product");
    const one = postStyleSection({
      context,
      examples: [],
      referenceCount: 0,
      productCount: 1,
    })!;
    expect(one).toContain("next attached image shows the REAL product");
    // No example picture was attached: no promise about them.
    expect(one).not.toContain("REFERENCE POSTS");
  });

  it("works for a product picture alone (no kit) and is null when there is nothing to say", () => {
    expect(
      postStyleSection({ context: null, examples: [], referenceCount: 0, productCount: 1 }),
    ).toContain("REAL product");
    expect(
      postStyleSection({ context: null, examples: [], referenceCount: 0, productCount: 0 }),
    ).toBeNull();
  });

  it("instructions alone still reach the prompt", () => {
    const text = postStyleSection({
      context: { fidelity: "match", directives: "Always dark.", examples: [] },
      examples: [],
      referenceCount: 0,
      productCount: 0,
    });
    expect(text).toBe(
      "The brand's standing post instructions. They apply to EVERY post and override any other taste: Always dark.",
    );
  });
});

describe("exampleSummary", () => {
  it("the summary, else the name, else a plain placeholder", () => {
    expect(exampleSummary({ label: "x", analysis: analysis() })).toBe("Dark premium product ad");
    expect(exampleSummary({ label: "My post", analysis: null })).toBe("My post");
    expect(exampleSummary({ label: "", analysis: null })).toBe("Example post (not analysed yet)");
  });
});

describe("postStyleTraitsOf", () => {
  const traits = (over: Partial<PostStyleTraits> = {}): PostStyleTraits => ({
    logoCorner: "BOTTOM_LEFT",
    headlineZone: "TOP",
    headlineAlign: "center",
    headlineScale: "L",
    bar: "line",
    ...over,
  });
  const example = (assetId: string, t?: PostStyleTraits) => ({
    assetId,
    label: "",
    analysis: t
      ? {
          summary: "s",
          layout: "l",
          typography: "t",
          colors: "c",
          product: "p",
          graphics: "g",
          background: "b",
          mood: "m",
          recipe: "r",
          traits: t,
        }
      : null,
  });
  const context = (examples: ReturnType<typeof example>[]) => ({
    fidelity: "match" as const,
    directives: "",
    examples,
  });

  it("takes what the examples agree on", () => {
    const result = postStyleTraitsOf(
      context([
        example("a", traits({ headlineZone: "BOTTOM", bar: "band" })),
        example("b", traits({ headlineZone: "BOTTOM" })),
        example("c", traits({ headlineZone: "BOTTOM", bar: "band" })),
      ]),
    );
    expect(result).toMatchObject({ headlineZone: "BOTTOM", bar: "band" });
  });

  it("lets the newest example decide a tie", () => {
    const result = postStyleTraitsOf(
      context([
        example("new", traits({ headlineAlign: "left" })),
        example("old", traits({ headlineAlign: "center" })),
      ]),
    );
    expect(result?.headlineAlign).toBe("left");
  });

  it("skips examples without traits, and is null when none has them", () => {
    expect(postStyleTraitsOf(context([example("a")]))).toBeNull();
    expect(postStyleTraitsOf(null)).toBeNull();
    expect(
      postStyleTraitsOf(context([example("a"), example("b", traits())])),
    ).toEqual(traits());
  });

  it("reads analyses stored before traits existed", () => {
    const parsed = PostStyleAnalysisSchema.safeParse({
      summary: "s",
      layout: "l",
      typography: "t",
      colors: "c",
      product: "p",
      graphics: "g",
      background: "b",
      mood: "m",
      recipe: "r",
    });
    expect(parsed.success).toBe(true);
  });
});
