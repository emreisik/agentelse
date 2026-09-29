import { isDarkColor } from "@/lib/color-contrast";
import type { ColorSwatch } from "@/lib/color-swatches";
import type { LayoutPalette, LayoutTemplates } from "@/lib/layout-templates";
import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";

// The Brand tab's read model: everything visual about a brand in one plain,
// serializable object (logos, role-labelled palette, fonts, style, post
// template). Built on the server from data the app already stores and handed
// to presentational components; nothing here touches the database, so it is
// safe to import from client components and trivial to test.

export type LogoPosition =
  "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | "CENTER_BOTTOM";

export type KitTemplate = {
  enabled: boolean;
  logoPosition: LogoPosition;
  logoSizePercent: number;
  logoMarginPercent: number;
  accentBarEnabled: boolean;
  accentBarColorHex: string | null;
  accentBarHeightPercent: number;
  accentBarPosition: "TOP" | "BOTTOM";
};

// Mirrors DEFAULT_TEMPLATE_CONFIG in src/server/media/creative-template.ts
// (a server-only module this file must not import). brand-kit.test.ts asserts
// the two stay identical, so a change to one fails the build until the other
// follows.
export const DEFAULT_KIT_TEMPLATE: KitTemplate = {
  enabled: true,
  logoPosition: "BOTTOM_RIGHT",
  logoSizePercent: 16,
  logoMarginPercent: 4,
  accentBarEnabled: true,
  accentBarColorHex: null,
  accentBarHeightPercent: 5,
  accentBarPosition: "BOTTOM",
};

export type BrandKit = {
  logos: {
    // The app's two logo slots. `light` holds the LIGHT-coloured mark
    // (legible on dark backgrounds); `dark` holds the DARK-coloured mark
    // (legible on light backgrounds). Asset ids, served from /api/assets/<id>.
    light: string | null;
    dark: string | null;
  };
  palette: {
    primary: ColorSwatch[];
    secondary: ColorSwatch[];
    accent: ColorSwatch[];
  };
  // false: the colours came from an unlabelled legacy list (all placed in
  // `primary`), so the UI must not present them as having roles.
  paletteHasRoles: boolean;
  fonts: string[];
  style: {
    photographyStyle: string | null;
    backgroundTone: string | null;
    moodTags: string[];
    refinement: string | null;
    composition: string | null;
    alwaysInclude: string[];
    alwaysAvoid: string[];
  };
  // The effective base post template: the brand's own, or the defaults every
  // brand without a Visual Identity row already gets at generation time.
  template: KitTemplate;
  // The brand's saved named layouts; null when it has none (posts then use
  // `template` above).
  layouts: LayoutTemplates | null;
  // A structured Visual Identity row exists.
  hasIdentity: boolean;
};

export function buildBrandKit(input: {
  // BrandTwin.visualDNA.colors: a flat list (identity colours merged, or the
  // legacy approvedColors when no identity is configured).
  legacyColors: ColorSwatch[];
  fonts: string[];
  logoAssetId: string | null;
  darkLogoAssetId: string | null;
  identity: BrandVisualIdentityContext | null;
}): BrandKit {
  const { identity } = input;
  const hasRoles = Boolean(
    identity &&
    (identity.primaryColors.length ||
      identity.secondaryColors.length ||
      identity.accentColors.length),
  );

  return {
    logos: { light: input.logoAssetId, dark: input.darkLogoAssetId },
    palette: hasRoles
      ? {
          primary: identity!.primaryColors,
          secondary: identity!.secondaryColors,
          accent: identity!.accentColors,
        }
      : { primary: input.legacyColors, secondary: [], accent: [] },
    paletteHasRoles: hasRoles,
    fonts: input.fonts,
    style: {
      photographyStyle: identity?.photographyStyle ?? null,
      backgroundTone: identity?.backgroundTone ?? null,
      moodTags: identity?.moodTags ?? [],
      refinement: identity?.styleRefinement ?? null,
      composition: identity?.compositionNotes ?? null,
      alwaysInclude: identity?.alwaysInclude ?? [],
      alwaysAvoid: identity?.alwaysAvoid ?? [],
    },
    template: identity?.template ?? DEFAULT_KIT_TEMPLATE,
    layouts: identity?.layoutTemplates ?? null,
    hasIdentity: Boolean(identity),
  };
}

export function kitIsEmpty(kit: BrandKit): boolean {
  return (
    !kit.logos.light &&
    !kit.logos.dark &&
    kit.palette.primary.length === 0 &&
    kit.palette.secondary.length === 0 &&
    kit.palette.accent.length === 0 &&
    kit.fonts.length === 0
  );
}

export type LogoChoice = { assetId: string; variant: "light" | "dark" };

// The logo variant that is legible on the given background, or null when the
// brand has no such variant. Deliberately strict: falling back to the OTHER
// variant would put a dark mark on a dark surface, which is exactly the
// invisible-logo bug the two slots exist to prevent.
export function pickLogoForBackground(
  logos: BrandKit["logos"],
  backgroundHex: string,
): LogoChoice | null {
  if (isDarkColor(backgroundHex)) {
    return logos.light ? { assetId: logos.light, variant: "light" } : null;
  }
  return logos.dark ? { assetId: logos.dark, variant: "dark" } : null;
}

// Whichever logo is available, preferring the one that reads on white — for
// surfaces that draw their own light backing (the post-layout preview badge).
export function anyLogoForLightSurface(
  logos: BrandKit["logos"],
): string | null {
  return logos.dark ?? logos.light;
}

// The colour of the brand-coloured surfaces (hero card): the first primary
// colour, then any other colour, else null (callers fall back to the theme).
export function brandSurfaceColor(kit: BrandKit): string | null {
  return (
    kit.palette.primary[0]?.hex ??
    kit.palette.secondary[0]?.hex ??
    kit.palette.accent[0]?.hex ??
    null
  );
}

// The three brand colour roles as single hex values, for layout previews and
// for resolving a layout's bar colour.
export function kitLayoutPalette(kit: BrandKit): LayoutPalette {
  return {
    primary: kit.palette.primary[0]?.hex ?? null,
    secondary: kit.palette.secondary[0]?.hex ?? null,
    accent: kit.palette.accent[0]?.hex ?? null,
  };
}

// Every palette colour in display order, for the signature strip.
export function allPaletteHexes(kit: BrandKit): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const swatch of [
    ...kit.palette.primary,
    ...kit.palette.secondary,
    ...kit.palette.accent,
  ]) {
    const hex = swatch.hex.toLowerCase();
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(swatch.hex);
    }
  }
  return out;
}

export const LOGO_POSITION_LABEL: Record<LogoPosition, string> = {
  TOP_LEFT: "Top left",
  TOP_RIGHT: "Top right",
  BOTTOM_LEFT: "Bottom left",
  BOTTOM_RIGHT: "Bottom right",
  CENTER_BOTTOM: "Bottom center",
};

export const PHOTOGRAPHY_STYLE_LABEL: Record<string, string> = {
  PHOTOGRAPHIC: "Photographic",
  ILLUSTRATED: "Illustrated",
  THREE_D_RENDER: "3D render",
  FLAT_DESIGN: "Flat design",
  MIXED: "Mixed",
};

export const BACKGROUND_TONE_LABEL: Record<string, string> = {
  LIGHT: "Light backgrounds",
  DARK: "Dark backgrounds",
  BRAND_COLORED: "Brand-colored backgrounds",
  NO_PREFERENCE: "Any background",
};
