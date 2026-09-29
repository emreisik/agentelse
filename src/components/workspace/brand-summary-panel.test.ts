import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The panel's interactive leaves import server actions (prisma, next-auth,
// object storage); none of them run during a static render.
vi.mock("@/server/actions/project-actions", () => ({
  updateApprovedFontsAction: vi.fn(),
}));
vi.mock("@/server/actions/brand-visual-identity-actions", () => ({
  updateVisualIdentityColorsAction: vi.fn(),
}));
vi.mock("@/server/actions/brand-layout-actions", () => ({
  updateLayoutTemplatesAction: vi.fn(),
}));
vi.mock("@/server/actions/brand-scan-actions", () => ({
  applyBrandScanAction: vi.fn(),
  scanBrandWebsiteAction: vi.fn(),
}));

const { BrandSummaryPanel } = await import("./brand-summary-panel");
const { buildBrandKit, DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");

import type { BrandTwin } from "@/server/brand-twin/brand-twin";
import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";

const twin = (overrides: Partial<BrandTwin> = {}): BrandTwin => ({
  brandId: "brand-1",
  projectId: "proj-1",
  name: "Web Health",
  version: 1,
  confidence: "high",
  isMock: false,
  identity: null,
  businessModel: null,
  positioning: null,
  valueProposition: "Measurable patient acquisition",
  audience: [],
  markets: ["Turkey"],
  products: [],
  voice: { personality: "Confident, calm", toneOfVoice: null },
  visualDNA: { description: null, colors: [], fonts: [], logoAssetId: null },
  approvedClaims: [],
  unverifiedClaims: [],
  negativeRules: ["No stock smiles"],
  currentFocus: null,
  creativePreferences: [],
  creativeMemory: { works: [], avoid: [] },
  sources: [],
  updatedAt: null,
  ...overrides,
});

const identity = (
  overrides: Partial<BrandVisualIdentityContext> = {},
): BrandVisualIdentityContext => ({
  primaryColors: [{ hex: "#0b1f3a", name: "Navy" }],
  secondaryColors: [{ hex: "#0d9488", name: "Teal" }],
  accentColors: [{ hex: "#2dd4bf" }],
  photographyStyle: "PHOTOGRAPHIC",
  styleRefinement: "Soft daylight, clean surfaces",
  moodTags: ["calm", "trustworthy"],
  compositionNotes: "Generous negative space",
  backgroundTone: "DARK",
  alwaysInclude: ["natural light"],
  alwaysAvoid: ["stock smiles"],
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
  ...overrides,
});

function render(
  brand: BrandTwin | null,
  kitInput: Parameters<typeof buildBrandKit>[0] | null,
  website: string | null = "webhealth.com.tr",
) {
  return renderToStaticMarkup(
    createElement(BrandSummaryPanel, {
      projectId: "proj-1",
      brand,
      website,
      kit: kitInput ? buildBrandKit(kitInput) : null,
    }),
  );
}

const fullKit = {
  legacyColors: [],
  fonts: ["Playfair Display", "Inter"],
  logoAssetId: "logo-light",
  darkLogoAssetId: "logo-dark",
  identity: identity(),
};

describe("BrandSummaryPanel (visual brand kit)", () => {
  it("renders the hero in the brand colour with readable ink and the matching logo", () => {
    const html = render(twin(), fullKit);
    expect(html).toContain('data-kit="hero"');
    // Navy is dark: the hero uses it as the surface, white ink, and the LIGHT
    // logo variant (legible on dark).
    expect(html).toMatch(/data-kit="hero"[^>]*background:\s*#0b1f3a/i);
    expect(html).toMatch(/data-kit="hero"[^>]*color:\s*#ffffff/i);
    const hero = html.slice(html.indexOf('data-kit="hero"'), html.indexOf('data-kit="palette-strip"'));
    expect(hero).toContain("/api/assets/logo-light");
    expect(hero).not.toContain("/api/assets/logo-dark");
    // Palette strip along the bottom of the hero: all three colours.
    expect(html).toContain('data-kit="palette-strip"');
  });

  it("puts identity, site and actions on the hero card, with the name shown once", () => {
    const html = render(twin(), fullKit);
    const hero = html.slice(html.indexOf('data-kit="hero"'), html.indexOf('data-kit="palette-strip"'));
    expect(hero).toContain("webhealth.com.tr");
    expect(hero).toContain("Scan site");
    expect(hero).toContain('aria-label="Brand settings"');
    // The visible name is rendered exactly once (the logo's alt text is separate).
    expect(html.match(/>Web Health</g)).toHaveLength(1);
  });

  it("shows each logo variant on the surface it is made for", () => {
    const html = render(twin(), fullKit);
    expect(html).toContain('data-kit="logo-on-light"');
    expect(html).toContain('data-kit="logo-on-dark"');
    const onLight = html.slice(html.indexOf('data-kit="logo-on-light"'), html.indexOf('data-kit="logo-on-dark"'));
    expect(onLight).toContain("/api/assets/logo-dark");
    expect(onLight).toMatch(/background-color:\s*#ffffff/i);
    const onDark = html.slice(html.indexOf('data-kit="logo-on-dark"'));
    expect(onDark).toContain("/api/assets/logo-light");
    // The dark tile uses the brand's own (dark) primary colour.
    expect(onDark).toMatch(/background-color:\s*#0b1f3a/i);
  });

  it("leaves a logo out of the hero when only the wrong variant exists, and invites the missing one", () => {
    const html = render(twin(), { ...fullKit, logoAssetId: null });
    const hero = html.slice(html.indexOf('data-kit="hero"'), html.indexOf('data-kit="palette-strip"'));
    // Only a DARK-coloured logo exists; the hero is dark, so it must not appear there.
    expect(hero).not.toContain("/api/assets/");
    expect(hero).toContain("Web Health");
    expect(html).toContain('data-kit="logo-on-dark-missing"');
    expect(html).toContain("Add a light-colored logo");
    expect(html).toContain('data-kit="logo-on-light"');
  });

  it("lays out the palette by role with copyable hex swatches and contrast-aware labels", () => {
    const html = render(twin(), fullKit);
    for (const label of ["Primary", "Secondary", "Accent"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("#0B1F3A");
    expect(html).toContain("Navy");
    expect(html).toContain("#2DD4BF");
    // White label on navy, dark label on the bright teal accent.
    expect(html).toMatch(/background-color:\s*#0b1f3a;\s*color:\s*#ffffff/i);
    expect(html).toMatch(/background-color:\s*#2dd4bf;\s*color:\s*#0b0b0b/i);
    expect(html).toContain("Click to copy");
  });

  it("shows fonts, style, mood and the post layout", () => {
    const html = render(twin(), fullKit);
    expect(html).toContain("Playfair Display");
    expect(html).toContain("Inter");
    expect(html).toContain("Photographic");
    expect(html).toContain("Dark backgrounds");
    expect(html).toContain("trustworthy");
    expect(html).toContain("natural light");
    expect(html).toContain("stock smiles");
    expect(html).toContain("POST LAYOUTS");
    expect(html).toContain('data-kit="layout-preview"');
    // No layouts saved yet: the brand's own template shown as the default
    // "Classic", with the suggested set beside it.
    expect(html).toContain("Classic");
    expect(html).toContain("no headline · logo bottom-right corner · thin bar bottom");
    expect(html).toContain("Set up layouts");
    expect(html).toContain("Suggested layouts, not saved yet");
    expect(html.match(/data-kit="layout-thumb"/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it("shows the saved default layout and says posts follow it", () => {
    const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
    const html = render(twin(), {
      ...fullKit,
      identity: identity({ layoutTemplates: { ...layouts, defaultId: "bottom-band" } }),
    });
    expect(html).toContain("Brand band");
    expect(html).toContain("headline bottom, left · logo bottom-left corner · brand band bottom");
    expect(html).toContain("Edit layouts");
    expect(html).toContain("New posts follow these layouts");
    expect(html).not.toContain("Suggested layouts, not saved yet");
  });

  it("keeps the strategy text, collapsed by default, and a scan button", () => {
    const html = render(twin(), fullKit);
    expect(html).toContain("BRAND STRATEGY");
    expect(html).toContain("Measurable patient acquisition");
    expect(html).toContain("No stock smiles");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("Scan site");
  });

  it("presents legacy colours as one unlabelled row", () => {
    const html = render(twin(), {
      legacyColors: [{ hex: "#123456" }, { hex: "#abcdef" }],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: null,
    });
    expect(html).toContain('data-kit="palette-colors"');
    expect(html).not.toContain('data-kit="palette-primary"');
    expect(html).toContain("#123456");
    // Hero falls back to the first colour it has.
    expect(html).toMatch(/data-kit="hero"[^>]*background:\s*#123456/i);
    // Default post template applies when no identity row exists.
    expect(html).toContain("no headline · logo bottom-right corner · thin bar bottom");
  });

  it("invites a scan when there is nothing visual yet", () => {
    const html = render(twin(), {
      legacyColors: [],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: null,
    });
    expect(html).toContain('data-kit="empty"');
    expect(html).toContain("Build your brand kit");
    expect(html).toContain("Scan my website");
    expect(html).not.toContain('data-kit="hero"');
    expect(html).not.toContain("COLORS");
    // ...and it is the only scan button on the page.
    expect(html.match(/Scan site/g)).toBeNull();
    // The strategy text is still reachable.
    expect(html).toContain("BRAND STRATEGY");
  });

  it("derives a kit from the twin when none is passed, and handles a missing brand", () => {
    const html = render(
      twin({ visualDNA: { description: null, colors: [{ hex: "#e11d48" }], fonts: [], logoAssetId: "logo-x" } }),
      null,
    );
    expect(html).toContain("#E11D48");
    expect(html).toContain("/api/assets/logo-x");
    expect(render(null, null)).toContain("Brand not set up yet.");
  });
});
