import { describe, expect, it } from "vitest";

import { buildCreativePrompt } from "@/server/media/creative-prompt-builder";

describe("buildCreativePrompt", () => {
  it("falls back to legacy visualGuidelines/approvedColors summarization when no structured visualIdentity is present", () => {
    const prompt = buildCreativePrompt({
      subject: "a coffee cup",
      brandContext: {
        positioning: "Premium specialty coffee",
        toneOfVoice: "Warm and inviting",
        visualGuidelines: "Always show steam rising",
        approvedColors: ["#6F4E37", { hex: "#E8DCCA", name: "Cream" }],
      },
    });

    expect(prompt).toContain("BRAND: Premium specialty coffee");
    expect(prompt).toContain("Tone: Warm and inviting");
    expect(prompt).toContain("Visual guidelines: Always show steam rising");
    expect(prompt).toContain(
      "Brand colors to favour in the scene: #6F4E37, Cream (#E8DCCA)",
    );
  });

  it("does not silently drop brand colors when brandContext carries no visualGuidelines/approvedColors keys at all (the manual-path bug scenario)", () => {
    // This shape matches what ConstitutionService.getBrandContext() returns
    // on its own (raw Constitution payload or the 5-field dossier slice) —
    // neither has visualGuidelines/approvedColors. Before the fix this
    // produced no BRAND color line at all; the fix is that callers now
    // merge in resolveBrandStyleContext()'s legacy fields, giving this
    // exact shape.
    const prompt = buildCreativePrompt({
      subject: "a coffee cup",
      brandContext: {
        identity: "A specialty coffee brand",
        positioning: "Premium specialty coffee",
        toneOfVoice: "Warm and inviting",
        visualIdentity: "some free-text constitution field, ignored here",
        // merged in by the caller from resolveBrandStyleContext()
        approvedColors: ["#6F4E37"],
      },
    });

    expect(prompt).toContain("Brand colors to favour in the scene: #6F4E37");
  });

  it("prefers structured BrandVisualIdentity data over the legacy summarization when both are present", () => {
    const prompt = buildCreativePrompt({
      subject: "a running shoe",
      brandContext: {
        positioning: "Performance athletic wear",
        toneOfVoice: "Bold",
        // legacy fields present too — should be ignored once visualIdentity exists
        approvedColors: ["#000000"],
        visualIdentity: {
          primaryColors: [{ hex: "#FF4500", name: "Ember Orange" }],
          secondaryColors: [{ hex: "#1A1A1A" }],
          accentColors: [],
          photographyStyle: "PHOTOGRAPHIC",
          styleRefinement: "high-contrast studio lighting",
          moodTags: ["energetic", "bold"],
          compositionNotes: "diagonal dynamic framing",
          backgroundTone: "DARK",
          alwaysInclude: ["show motion blur on the shoe"],
          alwaysAvoid: ["no competitor logos"],
          referenceImageAssetId: null,
          template: {
            enabled: true,
            logoPosition: "BOTTOM_RIGHT",
            logoSizePercent: 16,
            logoMarginPercent: 4,
            accentBarEnabled: true,
            accentBarColorHex: null,
            accentBarHeightPercent: 5,
            accentBarPosition: "BOTTOM",
          },
        },
      },
    });

    expect(prompt).toContain(
      "Primary brand colors (dominant): Ember Orange (#FF4500)",
    );
    expect(prompt).toContain("Secondary colors: #1A1A1A");
    expect(prompt).not.toContain("#000000");
    expect(prompt).toContain(
      "Photographic, camera-realistic imagery. high-contrast studio lighting Mood/aesthetic: energetic, bold.",
    );
    expect(prompt).toContain("Prefer a dark, moody background.");
    expect(prompt).toContain("show motion blur on the shoe");
    expect(prompt).toContain("diagonal dynamic framing");
    expect(prompt).toContain("no competitor logos");
  });

  it("omits the BRAND section entirely when brandContext has nothing usable", () => {
    const prompt = buildCreativePrompt({ subject: "a product" });
    expect(prompt).not.toContain("BRAND:");
  });

  it("keeps the global STYLE_AND_LIGHTING/AVOID baseline even when a brand adds its own", () => {
    const prompt = buildCreativePrompt({
      subject: "a bag",
      brandContext: {
        visualIdentity: {
          primaryColors: [],
          secondaryColors: [],
          accentColors: [],
          photographyStyle: "FLAT_DESIGN",
          styleRefinement: null,
          moodTags: [],
          compositionNotes: null,
          backgroundTone: null,
          alwaysInclude: [],
          alwaysAvoid: ["no glitter effects"],
          referenceImageAssetId: null,
          template: {
            enabled: true,
            logoPosition: "BOTTOM_RIGHT",
            logoSizePercent: 16,
            logoMarginPercent: 4,
            accentBarEnabled: true,
            accentBarColorHex: null,
            accentBarHeightPercent: 5,
            accentBarPosition: "BOTTOM",
          },
        },
      },
    });

    expect(prompt).toContain("not a generic AI-rendered look.");
    expect(prompt).toContain("stock-photo watermarks");
    expect(prompt).toContain("no glitter effects");
  });
});

describe("buildCreativePrompt with a post layout", () => {
  it("adds the layout's scene guidance and the areas compositing will cover", () => {
    const prompt = buildCreativePrompt({
      subject: "A calm clinic reception",
      layoutComposition: "Keep the upper third calm and low-detail.",
      reservedZones:
        "the bottom 13% of the frame (a solid brand-color band is added there).",
    });
    expect(prompt).toContain("Keep the upper third calm and low-detail.");
    expect(prompt).toContain(
      "Keep the main subject clear of these areas, which are covered afterwards: the bottom 13% of the frame",
    );
    // Still a textless image.
    expect(prompt).toContain("completely textless");
    expect(prompt).not.toContain("TYPOGRAPHY:");
  });

  it("places the headline where the layout says and keeps text out of covered areas", () => {
    const prompt = buildCreativePrompt({
      subject: "A calm clinic reception",
      reservedZones: "the bottom-right corner (the brand logo is added there).",
      typography: {
        headline: "Klinik siteniz ilk soruları yanıtlıyor mu?",
        highlight: "ilk soruları",
        placement: "large, centered, at most 3 lines, placed in the upper third of the frame",
      },
    });
    expect(prompt).toContain("TYPOGRAPHY:");
    expect(prompt).toContain(
      "Set the headline large, centered, at most 3 lines, placed in the upper third of the frame.",
    );
    expect(prompt).toContain(
      "Keep text and busy detail out of: the bottom-right corner",
    );
    expect(prompt).not.toContain("Place it on a calm area of the scene");
  });

  it("keeps the generic wording when no layout gives a placement", () => {
    const prompt = buildCreativePrompt({
      subject: "s",
      typography: { headline: "Hello" },
    });
    expect(prompt).toContain("Place it on a calm area of the scene");
  });
});

describe("buildCreativePrompt with a Post Style Kit", () => {
  const section = "REFERENCE POSTS: the first 2 attached images are example posts.\n\nALWAYS: dark.";

  it("puts the kit's section right after the subject, above every other taste", () => {
    const prompt = buildCreativePrompt({
      subject: "an iPhone auction",
      postStyle: section,
    });
    const sections = prompt.split("\n\n");
    expect(sections[0]).toBe("SUBJECT: an iPhone auction");
    expect(prompt).toContain(`POST STYLE KIT:\n${section}`);
    expect(prompt.indexOf("POST STYLE KIT:")).toBeLessThan(
      prompt.indexOf("STYLE & LIGHTING:"),
    );
  });

  it("adds nothing without a kit", () => {
    const prompt = buildCreativePrompt({ subject: "s" });
    expect(prompt).not.toContain("POST STYLE KIT");
    expect(buildCreativePrompt({ subject: "s", postStyle: null })).toBe(prompt);
  });

  it("matching the examples: the layout's scene notes stand aside, its reserved areas do not", () => {
    const input = {
      subject: "s",
      layoutComposition: "Keep the upper third calm.",
      reservedZones: "the bottom band",
    };
    const free = buildCreativePrompt(input);
    expect(free).toContain("Keep the upper third calm.");
    const matched = buildCreativePrompt({ ...input, matchStyle: true });
    expect(matched).not.toContain("Keep the upper third calm.");
    expect(matched).toContain("which are covered afterwards: the bottom band");
  });

  it("matching the examples: the headline takes the reference posts' typography and places", () => {
    const prompt = buildCreativePrompt({
      subject: "s",
      matchStyle: true,
      typography: {
        headline: "iPhone 16 Pro Max",
        highlight: "Pro Max",
        placement: "large, centered, in the upper third",
      },
    });
    expect(prompt).toContain(
      'HEADLINE: "iPhone 16 Pro Max" — set in the typeface, weight, case, colour and size relationship of the headline in the reference posts',
    );
    expect(prompt).toContain("the way the reference posts highlight words");
    expect(prompt).toContain("Place every text where the reference posts place that kind of text.");
    // The layout's own placement is not used: the examples decide.
    expect(prompt).not.toContain("in the upper third");
  });

  it("further on-image texts are rendered exactly once each, and only those", () => {
    const prompt = buildCreativePrompt({
      subject: "s",
      typography: {
        headline: "Hello",
        lines: ["Başlangıç 1 TL", "  ", "Teklif ver"],
      },
    });
    expect(prompt).toContain("Render exactly these texts");
    expect(prompt).toContain("They are the ONLY texts in the image.");
    expect(prompt).toContain(
      'OTHER TEXTS, each exactly once, placed where the design puts that kind of text (sub-headline, price, button label, badge): "Başlangıç 1 TL", "Teklif ver".',
    );
    expect(prompt).not.toContain('""');
    // A single headline keeps its old wording.
    expect(
      buildCreativePrompt({ subject: "s", typography: { headline: "Hello" } }),
    ).toContain("Render exactly this text, character for character");
  });

  it("words typeset afterwards: a textless picture that keeps their area calm", () => {
    const prompt = buildCreativePrompt({
      subject: "s",
      textArea: "in the upper third of the frame",
    });
    expect(prompt).toContain(
      "The post's headline is typeset onto the image afterwards in the upper third of the frame: keep that area calm, uncluttered and low-detail, with no text of any kind.",
    );
    expect(prompt).toContain("completely textless; the post's words are typeset onto it afterwards");
    expect(prompt).not.toContain("TYPOGRAPHY:");
    // Following example posts that carry text: their text areas stay empty.
    expect(
      buildCreativePrompt({ subject: "s", textArea: "centered", matchStyle: true }),
    ).toContain("where the reference posts carry text, leave clean space instead");
  });
});
