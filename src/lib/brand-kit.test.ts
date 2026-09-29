import { describe, expect, it, vi } from "vitest";

// creative-template.ts is server-only and pulls prisma / object storage; only
// its exported constant matters here.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/storage/asset-storage", () => ({
  readAsset: vi.fn(),
  overwriteAsset: vi.fn(),
}));

const { DEFAULT_TEMPLATE_CONFIG } = await import("@/server/media/creative-template");

import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";

import {
  allPaletteHexes,
  anyLogoForLightSurface,
  brandSurfaceColor,
  buildBrandKit,
  DEFAULT_KIT_TEMPLATE,
  kitIsEmpty,
  pickLogoForBackground,
} from "./brand-kit";

const identity = (
  overrides: Partial<BrandVisualIdentityContext> = {},
): BrandVisualIdentityContext => ({
  primaryColors: [{ hex: "#0b1f3a", name: "Navy" }],
  secondaryColors: [{ hex: "#0d9488" }],
  accentColors: [{ hex: "#2dd4bf" }],
  photographyStyle: "PHOTOGRAPHIC",
  styleRefinement: "Soft daylight",
  moodTags: ["calm", "trustworthy"],
  compositionNotes: "Negative space",
  backgroundTone: "DARK",
  alwaysInclude: ["natural light"],
  alwaysAvoid: ["stock smiles"],
  referenceImageAssetId: null,
  template: {
    enabled: true,
    logoPosition: "TOP_LEFT",
    logoSizePercent: 20,
    logoMarginPercent: 5,
    accentBarEnabled: false,
    accentBarColorHex: null,
    accentBarHeightPercent: 5,
    accentBarPosition: "TOP",
  },
  ...overrides,
});

describe("DEFAULT_KIT_TEMPLATE", () => {
  it("stays identical to the template defaults used at generation time", () => {
    expect(DEFAULT_KIT_TEMPLATE).toEqual(DEFAULT_TEMPLATE_CONFIG);
  });
});

describe("buildBrandKit", () => {
  it("uses the role-labelled identity when it has colours", () => {
    const kit = buildBrandKit({
      legacyColors: [{ hex: "#111111" }],
      fonts: ["Inter"],
      logoAssetId: "light-1",
      darkLogoAssetId: "dark-1",
      identity: identity(),
    });
    expect(kit.paletteHasRoles).toBe(true);
    expect(kit.palette.primary).toEqual([{ hex: "#0b1f3a", name: "Navy" }]);
    expect(kit.palette.secondary).toEqual([{ hex: "#0d9488" }]);
    expect(kit.palette.accent).toEqual([{ hex: "#2dd4bf" }]);
    expect(kit.logos).toEqual({ light: "light-1", dark: "dark-1" });
    expect(kit.style).toMatchObject({
      photographyStyle: "PHOTOGRAPHIC",
      moodTags: ["calm", "trustworthy"],
      backgroundTone: "DARK",
      alwaysAvoid: ["stock smiles"],
    });
    expect(kit.template.logoPosition).toBe("TOP_LEFT");
    expect(kit.hasIdentity).toBe(true);
  });

  it("falls back to the unlabelled legacy colours and default template", () => {
    const kit = buildBrandKit({
      legacyColors: [{ hex: "#123456" }, { hex: "#abcdef" }],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: null,
    });
    expect(kit.paletteHasRoles).toBe(false);
    expect(kit.palette.primary).toHaveLength(2);
    expect(kit.palette.secondary).toEqual([]);
    expect(kit.template).toEqual(DEFAULT_KIT_TEMPLATE);
    expect(kit.hasIdentity).toBe(false);
  });

  it("treats an identity row with no colours like no roles", () => {
    const kit = buildBrandKit({
      legacyColors: [{ hex: "#123456" }],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: identity({ primaryColors: [], secondaryColors: [], accentColors: [] }),
    });
    expect(kit.paletteHasRoles).toBe(false);
    expect(kit.palette.primary).toEqual([{ hex: "#123456" }]);
    // ...but its style and template still apply.
    expect(kit.hasIdentity).toBe(true);
    expect(kit.style.moodTags).toEqual(["calm", "trustworthy"]);
  });
});

describe("kitIsEmpty", () => {
  it("is true only when there is nothing visual at all", () => {
    const empty = buildBrandKit({
      legacyColors: [],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: null,
    });
    expect(kitIsEmpty(empty)).toBe(true);
    expect(kitIsEmpty({ ...empty, fonts: ["Inter"] })).toBe(false);
    expect(kitIsEmpty({ ...empty, logos: { light: null, dark: "d" } })).toBe(false);
  });
});

describe("pickLogoForBackground", () => {
  const both = { light: "L", dark: "D" };

  it("uses the light logo on dark backgrounds and the dark logo on light ones", () => {
    expect(pickLogoForBackground(both, "#0b1f3a")).toEqual({ assetId: "L", variant: "light" });
    expect(pickLogoForBackground(both, "#f3f4f6")).toEqual({ assetId: "D", variant: "dark" });
  });

  it("never substitutes the wrong variant (that would be invisible)", () => {
    expect(pickLogoForBackground({ light: null, dark: "D" }, "#0b1f3a")).toBeNull();
    expect(pickLogoForBackground({ light: "L", dark: null }, "#ffffff")).toBeNull();
  });
});

describe("helpers", () => {
  const kit = buildBrandKit({
    legacyColors: [],
    fonts: [],
    logoAssetId: "L",
    darkLogoAssetId: null,
    identity: identity({
      primaryColors: [{ hex: "#0B1F3A" }],
      secondaryColors: [{ hex: "#0b1f3a" }, { hex: "#0d9488" }], // duplicate of primary
      accentColors: [],
    }),
  });

  it("prefers the dark logo for light surfaces but accepts what exists", () => {
    expect(anyLogoForLightSurface({ light: "L", dark: "D" })).toBe("D");
    expect(anyLogoForLightSurface(kit.logos)).toBe("L");
    expect(anyLogoForLightSurface({ light: null, dark: null })).toBeNull();
  });

  it("finds the brand surface colour and a de-duplicated palette strip", () => {
    expect(brandSurfaceColor(kit)).toBe("#0B1F3A");
    expect(allPaletteHexes(kit)).toEqual(["#0B1F3A", "#0d9488"]);
  });

  it("has no surface colour when the palette is empty", () => {
    const empty = buildBrandKit({
      legacyColors: [],
      fonts: [],
      logoAssetId: null,
      darkLogoAssetId: null,
      identity: null,
    });
    expect(brandSurfaceColor(empty)).toBeNull();
    expect(allPaletteHexes(empty)).toEqual([]);
  });
});
