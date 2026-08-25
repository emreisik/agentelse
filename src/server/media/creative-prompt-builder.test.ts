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
