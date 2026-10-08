import "server-only";

import { prisma } from "@/lib/prisma";
import { parseColorSwatches, type ColorSwatch } from "@/lib/color-swatches";
import {
  parseLayoutTemplates,
  type LayoutTemplates,
} from "@/lib/layout-templates";
import { parseDesignProfile, type DesignProfile } from "@/lib/design-profile";
import type { PostStyleContext } from "@/lib/post-style";
import { loadPostStyleContext } from "@/server/brand/post-style-store";
import type {
  LogoPositionValue,
  AccentBarPositionValue,
} from "@/server/media/creative-template";

// The single shared source of "what does this brand look like" — the fix
// for a real bug: image generation runs through two divergent paths (the
// automated agency pipeline via context-builder.ts's frozen
// ExecutionContextSnapshot, and the manual "Visual Studio" regenerate
// button via ConstitutionService.getBrandContext()), and the manual path's
// getBrandContext() return shape never contains `approvedColors` or
// `visualGuidelines` — so brand colors silently never reached the image
// prompt on that path. Both paths now call this one function instead of
// reading BrandDossier/BrandVisualIdentity ad hoc.
//
// Deliberately NOT folded into ConstitutionService.getBrandContext() itself
// — that function has 9 other call sites (council/opportunity/goal engines,
// baseline audits, etc.), all consuming it for text/strategy reasoning;
// adding image-pipeline fields there would leak into every one of those
// unrelated prompts.

export type BrandVisualIdentityContext = {
  primaryColors: ColorSwatch[];
  secondaryColors: ColorSwatch[];
  accentColors: ColorSwatch[];
  photographyStyle: string | null;
  styleRefinement: string | null;
  moodTags: string[];
  compositionNotes: string | null;
  backgroundTone: string | null;
  // Brand-specific ADDITIONS to creative-prompt-builder.ts's hardcoded
  // global STYLE_AND_LIGHTING/AVOID baseline — not a replacement for it.
  alwaysInclude: string[];
  alwaysAvoid: string[];
  referenceImageAssetId: string | null;
  // The brand's Post Style Kit (example posts and standing instructions), when
  // it has one: every render follows it. Absent otherwise.
  postStyle?: PostStyleContext | null;
  // The brand's named post layouts, or null when it has none (then `template`
  // below is the only layout, as it always was). Optional so existing callers
  // and fixtures need no change.
  layoutTemplates?: LayoutTemplates | null;
  // The look a person chose for the automatic post design, if any.
  designProfile?: DesignProfile | null;
  template: {
    enabled: boolean;
    logoPosition: LogoPositionValue;
    logoSizePercent: number;
    logoMarginPercent: number;
    accentBarEnabled: boolean;
    accentBarColorHex: string | null;
    accentBarHeightPercent: number;
    accentBarPosition: AccentBarPositionValue;
  };
};

export type BrandStyleContext = {
  logoAssetId: string | null;
  darkLogoAssetId: string | null;
  // Legacy BrandDossier fields, passed through as-is for callers that still
  // need creative-prompt-builder.ts's/creative-template.ts's existing
  // defensive summarization (a brand with no BrandVisualIdentity row keeps
  // getting exactly today's behavior from these).
  legacyApprovedColors: unknown;
  legacyVisualGuidelines: unknown;
  // Structured data — null until a brand has actually configured Visual
  // Identity (see brand-visual-identity-actions.ts, Phase 2).
  visualIdentity: BrandVisualIdentityContext | null;
};

export async function resolveBrandStyleContext(
  brandId: string,
): Promise<BrandStyleContext> {
  const [dossier, identity, postStyle] = await Promise.all([
    prisma.brandDossier.findUnique({
      where: { brandId },
      select: {
        logoAssetId: true,
        darkLogoAssetId: true,
        approvedColors: true,
        visualGuidelines: true,
      },
    }),
    prisma.brandVisualIdentity.findUnique({ where: { brandId } }),
    // Best-effort: a brand's look must never fail to load over the kit.
    loadPostStyleContext(brandId).catch(() => null),
  ]);

  return {
    logoAssetId: dossier?.logoAssetId ?? null,
    darkLogoAssetId: dossier?.darkLogoAssetId ?? null,
    legacyApprovedColors: dossier?.approvedColors ?? null,
    legacyVisualGuidelines: dossier?.visualGuidelines ?? null,
    visualIdentity: identity
      ? {
          primaryColors: parseColorSwatches(identity.primaryColors),
          secondaryColors: parseColorSwatches(identity.secondaryColors),
          accentColors: parseColorSwatches(identity.accentColors),
          photographyStyle: identity.photographyStyle,
          styleRefinement: identity.styleRefinement,
          moodTags: identity.moodTags,
          compositionNotes: identity.compositionNotes,
          backgroundTone: identity.backgroundTone,
          alwaysInclude: identity.alwaysInclude,
          alwaysAvoid: identity.alwaysAvoid,
          referenceImageAssetId: identity.referenceImageAssetId,
          ...(postStyle ? { postStyle } : {}),
          layoutTemplates: parseLayoutTemplates(identity.layoutTemplates),
          designProfile: parseDesignProfile(identity.designProfile),
          template: {
            enabled: identity.templateEnabled,
            logoPosition: identity.logoPosition,
            logoSizePercent: identity.logoSizePercent,
            logoMarginPercent: identity.logoMarginPercent,
            accentBarEnabled: identity.accentBarEnabled,
            accentBarColorHex: identity.accentBarColorHex,
            accentBarHeightPercent: identity.accentBarHeightPercent,
            accentBarPosition: identity.accentBarPosition,
          },
        }
      : null,
  };
}
