import { describe, expect, it } from "vitest";

import { barColorCandidates } from "@/lib/bar-color-candidates";
import { buildPresetLayouts } from "@/lib/layout-templates";
import { ContextPolicy } from "@/server/context/context-policy";
import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";
import { buildCreativePrompt } from "@/server/media/creative-prompt-builder";
import { planCreativeLayout } from "@/server/media/creative-layout";

// "Does every Visual Identity setting reach the designs?" as a contract: each
// field gets a value no other test uses and must show up in what generation
// really consumes (the image prompt, the layout plan that drives the logo/bar
// compositing, the context a job is allowed to read). A new field that is
// stored but never read fails here instead of silently doing nothing.

const identity = (
  overrides: Partial<BrandVisualIdentityContext> = {},
): BrandVisualIdentityContext => ({
  primaryColors: [{ hex: "#111aaa", name: "PrimaryMarker" }],
  secondaryColors: [{ hex: "#222bbb", name: "SecondaryMarker" }],
  accentColors: [{ hex: "#333ccc", name: "AccentMarker" }],
  photographyStyle: "ILLUSTRATED",
  styleRefinement: "RefinementMarker soft grain",
  moodTags: ["moodmarker-one", "moodmarker-two"],
  compositionNotes: "CompositionMarker rule of thirds",
  backgroundTone: "DARK",
  alwaysInclude: ["IncludeMarker natural light"],
  alwaysAvoid: ["AvoidMarker neon signs"],
  referenceImageAssetId: null,
  layoutTemplates: null,
  template: {
    enabled: true,
    logoPosition: "TOP_LEFT",
    logoSizePercent: 20,
    logoMarginPercent: 6,
    accentBarEnabled: true,
    accentBarColorHex: "#444ddd",
    accentBarHeightPercent: 9,
    accentBarPosition: "TOP",
  },
  ...overrides,
});

function prompt(id: BrandVisualIdentityContext | null) {
  return buildCreativePrompt({
    subject: "a cup of coffee",
    brandContext: {
      positioning: "PositioningMarker",
      toneOfVoice: "warm",
      visualIdentity: id,
    },
  });
}

describe("Visual Identity reaches the image prompt", () => {
  const text = prompt(identity());

  it("carries all three colour roles with their names and codes", () => {
    for (const marker of [
      "PrimaryMarker (#111aaa)",
      "SecondaryMarker (#222bbb)",
      "AccentMarker (#333ccc)",
    ]) {
      expect(text).toContain(marker);
    }
  });

  it("carries photography style, refinement and mood into STYLE & LIGHTING", () => {
    const style = text.slice(
      text.indexOf("STYLE & LIGHTING"),
      text.indexOf("COMPOSITION"),
    );
    expect(style).toContain("Illustrated");
    expect(style).toContain("RefinementMarker");
    expect(style).toContain("moodmarker-one, moodmarker-two");
  });

  it("carries composition notes into COMPOSITION", () => {
    const composition = text.slice(
      text.indexOf("COMPOSITION"),
      text.indexOf("BRAND:"),
    );
    expect(composition).toContain("CompositionMarker");
  });

  it("carries background tone and always-include into BRAND", () => {
    const brand = text.slice(text.indexOf("BRAND:"), text.indexOf("AVOID:"));
    expect(brand).toContain("dark, moody background");
    expect(brand).toContain("IncludeMarker");
    expect(brand).toContain("PositioningMarker");
  });

  it("carries always-avoid into AVOID, after the global baseline", () => {
    const avoid = text.slice(text.indexOf("AVOID:"));
    expect(avoid).toContain("AvoidMarker neon signs");
  });

  it("maps every photography style and background tone to a phrase", () => {
    for (const style of [
      "PHOTOGRAPHIC",
      "ILLUSTRATED",
      "THREE_D_RENDER",
      "FLAT_DESIGN",
      "MIXED",
    ]) {
      const withStyle = prompt(
        identity({ photographyStyle: style, styleRefinement: null }),
      );
      const without = prompt(
        identity({ photographyStyle: null, styleRefinement: null }),
      );
      expect(withStyle).not.toBe(without);
    }
    for (const tone of ["LIGHT", "DARK", "BRAND_COLORED"]) {
      expect(prompt(identity({ backgroundTone: tone }))).not.toBe(
        prompt(identity({ backgroundTone: null })),
      );
    }
  });

  it("falls back to the legacy colours only when there is no visual identity", () => {
    const legacy = buildCreativePrompt({
      subject: "x",
      brandContext: { approvedColors: [{ name: "LegacyMarker", hex: "#999999" }] },
    });
    expect(legacy).toContain("LegacyMarker (#999999)");
    const structured = buildCreativePrompt({
      subject: "x",
      brandContext: {
        approvedColors: [{ name: "LegacyMarker", hex: "#999999" }],
        visualIdentity: identity(),
      },
    });
    expect(structured).not.toContain("LegacyMarker");
  });
});

describe("Visual Identity reaches the logo and bar compositing", () => {
  it("without saved layouts the stored template is applied as is", () => {
    const plan = planCreativeLayout({
      visualIdentity: identity(),
      hasLogo: true,
      hasHeadline: false,
    });
    expect(plan.layout).toBeNull();
    expect(plan.template).toEqual(identity().template);
    expect(plan.reservedZones).toContain("logo");
  });

  it("with saved layouts the layout decides placement and takes its bar colour from the palette", () => {
    const base = identity();
    const layouts = buildPresetLayouts({
      ...base.template,
      accentBarColorHex: null,
    });
    const plan = planCreativeLayout({
      visualIdentity: identity({ layoutTemplates: layouts }),
      hasLogo: true,
      hasHeadline: false,
    });
    expect(plan.layout).not.toBeNull();
    expect(plan.meta?.id).toBeTruthy();
    // The layout's colour role resolves through the brand's own colours.
    const palette = ["#111aaa", "#222bbb", "#333ccc"];
    if (plan.template?.accentBarEnabled) {
      expect(palette).toContain(plan.template.accentBarColorHex);
    }
  });

  it("switching the template off is honoured, layouts included", () => {
    const base = identity();
    const plan = planCreativeLayout({
      visualIdentity: identity({
        layoutTemplates: buildPresetLayouts(base.template),
        template: { ...base.template, enabled: false },
      }),
      hasLogo: true,
      hasHeadline: false,
    });
    expect(plan.layout).toBeNull();
    expect(plan.template?.enabled).toBe(false);
    expect(plan.reservedZones).toBeUndefined();
  });

  it("the bar colour candidates put accent first, then primary, then secondary", () => {
    expect(barColorCandidates(identity()).map((c) => c.hex)).toEqual([
      "#333ccc",
      "#111aaa",
      "#222bbb",
    ]);
  });
});

describe("Visual Identity reaches every job that makes pictures", () => {
  for (const capability of [
    "CREATE_SOCIAL_CREATIVE",
    "CREATE_AD_CREATIVE",
  ] as const) {
    it(`${capability} is allowed to read the identity, colours, fonts and both logos`, () => {
      const fields = ContextPolicy.fieldsFor(capability);
      for (const field of [
        "visualIdentity",
        "approvedColors",
        "approvedFonts",
        "logoAssetId",
        "darkLogoAssetId",
      ] as const) {
        expect(fields).toContain(field);
      }
    });
  }
});
