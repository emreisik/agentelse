import {
  aspectClassOf,
  buildPresetLayouts,
  headlinePlacement,
  layoutReservedZones,
  layoutToTemplateConfig,
  resolveLayout,
  type LayoutTemplate,
  type TextPlacement,
} from "@/lib/layout-templates";
import { DEFAULT_KIT_TEMPLATE } from "@/lib/brand-kit";
import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";
import type { AppliedTemplateConfig } from "@/server/media/creative-template";

// Decides, for ONE generation, which layout applies and turns it into the
// three things the pipeline needs: the deterministic compositing settings
// (logo / bar / band), the written brief for the image model (headline
// placement, scene guidance, areas to keep clear) and the record of what was
// used. Pure: the provider, the Studio revise action and the weekly planner
// all call it, so every path lays a post out the same way.

const FALLBACK_HEADLINE_PLACEMENT =
  "large, centered, at most 3 lines, placed in the upper third of the frame";

export type CreativeLayoutPlan = {
  // The layout used; null = the brand has none saved (its base template applies).
  layout: LayoutTemplate | null;
  // Settings for applyBrandTemplate. Undefined = its own defaults, exactly as
  // before layouts existed (a brand with no Visual Identity row).
  template: Partial<AppliedTemplateConfig> | undefined;
  // Areas the compositing will cover: keep text and key subject out of them.
  reservedZones: string | undefined;
  // Scene guidance from the layout ("subject in the lower two thirds"...).
  composition: string | undefined;
  // How the on-image headline is set; only when a headline is requested.
  headlinePlacement: string | undefined;
  // The layout's headline zone, when it has one: where the post's words are
  // typeset (creative-text.ts). Null = the layout carries no words.
  textPlacement: TextPlacement | null;
  // What to record on the creative version.
  meta: { id: string; name: string } | null;
};

export function planCreativeLayout(input: {
  visualIdentity: BrandVisualIdentityContext | null | undefined;
  hasLogo: boolean;
  // A layout id the caller asked for (the chat's pick, or a revise of a post
  // made with one). Unknown ids fall back to the brand's default.
  requestedId?: string | null;
  pixelSize?: { width: number; height: number };
  // The post carries a headline the image model must draw.
  hasHeadline: boolean;
}): CreativeLayoutPlan {
  const identity = input.visualIdentity;
  const baseTemplate = identity?.template;

  // The brand switched compositing off in Visual Identity: honour it, layouts
  // included. Nothing is added, so nothing needs to be kept clear.
  if (baseTemplate && !baseTemplate.enabled) {
    return {
      layout: null,
      template: baseTemplate,
      reservedZones: undefined,
      composition: undefined,
      headlinePlacement: input.hasHeadline ? FALLBACK_HEADLINE_PLACEMENT : undefined,
      textPlacement: null,
      meta: null,
    };
  }

  const saved = identity?.layoutTemplates ?? null;
  if (!saved) {
    // No layouts: today's behaviour, byte for byte. The "classic" preset is
    // the base template written as a layout, used only to describe the
    // reserved areas in words.
    const classic = buildPresetLayouts(baseTemplate ?? DEFAULT_KIT_TEMPLATE)
      .items[0]!;
    return {
      layout: null,
      template: baseTemplate ?? undefined,
      reservedZones: layoutReservedZones(classic, { hasLogo: input.hasLogo }),
      composition: undefined,
      headlinePlacement: undefined,
      textPlacement: null,
      meta: null,
    };
  }

  const layout = resolveLayout(saved, {
    id: input.requestedId,
    aspect: input.pixelSize ? aspectClassOf(input.pixelSize) : undefined,
  })!;
  const palette = {
    primary: identity?.primaryColors[0]?.hex ?? null,
    secondary: identity?.secondaryColors[0]?.hex ?? null,
    accent: identity?.accentColors[0]?.hex ?? null,
  };

  return {
    layout,
    template: layoutToTemplateConfig(layout, palette),
    reservedZones: layoutReservedZones(layout, { hasLogo: input.hasLogo }),
    composition: layout.composition || undefined,
    // A headline the client asked for wins over a layout that has none: the
    // client's explicit request is not dropped, it just gets a sensible spot.
    headlinePlacement: input.hasHeadline
      ? layout.headline.enabled
        ? headlinePlacement(layout.headline)
        : FALLBACK_HEADLINE_PLACEMENT
      : undefined,
    textPlacement: layout.headline.enabled
      ? {
          zone: layout.headline.zone,
          align: layout.headline.align,
          maxLines: layout.headline.maxLines,
          scale: layout.headline.scale,
        }
      : null,
    meta: { id: layout.id, name: layout.name },
  };
}

// Platform UI bands in px -> percent of the canvas height, the unit
// applyBrandTemplate takes (the image is normalized to pixelSize first).
export function safeZonePercent(
  safeZone: { top?: number; bottom?: number } | undefined,
  pixelSize: { width: number; height: number } | undefined,
): { top?: number; bottom?: number } | undefined {
  if (!safeZone || !pixelSize || pixelSize.height <= 0) return undefined;
  const pct = (px?: number) =>
    px ? Math.min(40, Math.round((px / pixelSize.height) * 1000) / 10) : undefined;
  const top = pct(safeZone.top);
  const bottom = pct(safeZone.bottom);
  return top || bottom ? { top, bottom } : undefined;
}

// The layout recorded on a finished generation — an execution job's
// `rawResult` or a version's `generationMetadata`. Tolerant of anything else
// stored there (older versions have no such key).
export function readLayoutMeta(
  stored: unknown,
): { id: string; name: string } | null {
  if (!stored || typeof stored !== "object") return null;
  const layout = (stored as { layoutTemplate?: unknown }).layoutTemplate;
  if (!layout || typeof layout !== "object") return null;
  const { id, name } = layout as { id?: unknown; name?: unknown };
  return typeof id === "string" && id !== "" && typeof name === "string"
    ? { id, name }
    : null;
}

// Which layout a REVISION of an existing creative starts from.
//  - Editing feeds the current image to the model, and that image already
//    carries its layout's logo and band, which are drawn again afterwards; so
//    the same layout must be used, or a second logo / band would stack on the
//    first. An image made before layouts existed is composed exactly as it
//    was (`keepLegacy`: ignore the brand's saved layouts).
//  - A fresh render keeps the previous layout too, unless the Studio picker
//    chose another or the format changed shape (a Post layout is not the
//    layout to reuse on a Story) — then the brand picks for the new format.
export function revisionLayoutRequest(input: {
  mode: "edit" | "new";
  // The Studio picker's choice, if any.
  chosenId?: string | null;
  // The current version's generationMetadata.
  previous: unknown;
  pixelSize: { width: number; height: number };
}): { requestedId: string | undefined; keepLegacy: boolean } {
  const previous = readLayoutMeta(input.previous);

  if (input.mode === "edit") {
    return { requestedId: previous?.id, keepLegacy: !previous };
  }

  const chosen = input.chosenId?.trim();
  if (chosen) return { requestedId: chosen, keepLegacy: false };

  const before = storedPixelSize(input.previous);
  const sameShape =
    !before || aspectClassOf(before) === aspectClassOf(input.pixelSize);
  return {
    requestedId: previous && sameShape ? previous.id : undefined,
    keepLegacy: false,
  };
}

function storedPixelSize(
  stored: unknown,
): { width: number; height: number } | null {
  if (!stored || typeof stored !== "object") return null;
  const { targetWidth, targetHeight } = stored as {
    targetWidth?: unknown;
    targetHeight?: unknown;
  };
  return typeof targetWidth === "number" &&
    typeof targetHeight === "number" &&
    targetWidth > 0 &&
    targetHeight > 0
    ? { width: targetWidth, height: targetHeight }
    : null;
}
