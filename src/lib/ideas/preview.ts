// How an idea card draws its post (docs/ideas.md): the layout the post will
// really be made with, at its format's real shape, so the card shows what
// "Make this post" produces. Pure and isomorphic.

import type { BrandKit } from "@/lib/brand-kit";
import {
  buildPresetLayouts,
  resolveLayout,
  type AspectClass,
  type LayoutTemplate,
} from "@/lib/layout-templates";
import { assetUrl } from "@/lib/asset-url";

export type PreviewFormat = {
  aspect: AspectClass;
  // Width / height of the real post.
  ratio: number;
};

// creative-platform-format.ts: an Instagram feed post is 3:4, a Story 9:16, a
// Facebook post 4:5.
const FORMATS: Record<string, PreviewFormat> = {
  "instagram.post": { aspect: "portrait", ratio: 3 / 4 },
  "instagram.carousel": { aspect: "portrait", ratio: 3 / 4 },
  "instagram.story": { aspect: "vertical", ratio: 9 / 16 },
  "facebook.post": { aspect: "portrait", ratio: 4 / 5 },
};

const DEFAULT_FORMAT: PreviewFormat = { aspect: "portrait", ratio: 4 / 5 };

export function previewFormatOf(formatKey: string | undefined): PreviewFormat {
  return (formatKey && FORMATS[formatKey]) || DEFAULT_FORMAT;
}

// The format keys a social idea can be looked at in, for the detail view's
// tabs: its own, then the other picture formats of its channels.
export function previewFormatsFor(
  channels: readonly string[],
  own: string | undefined,
): string[] {
  const keys: string[] = [];
  const push = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
  };
  if (own && FORMATS[own]) push(own);
  if (channels.includes("instagram")) {
    push("instagram.post");
    push("instagram.story");
  }
  if (channels.includes("facebook")) push("facebook.post");
  if (keys.length === 0) push("instagram.post");
  return keys;
}

// The layout the post gets: the idea's own among the brand's saved layouts,
// else the brand's default for this shape. A brand without saved layouts
// posts with its base template (logo and stripe, no words on the picture):
// the "Classic" preset is exactly that. A switched-off template draws neither.
export function ideaLayoutOf(
  kit: BrandKit,
  layoutId: string | undefined,
  aspect: AspectClass,
): LayoutTemplate {
  const layout = kit.layouts
    ? resolveLayout(kit.layouts, { id: layoutId ?? null, aspect })!
    : (() => {
        const presets = buildPresetLayouts(kit.template);
        return (
          presets.items.find((item) => item.id === "classic") ??
          presets.items[0]!
        );
      })();
  if (kit.template.enabled) return layout;
  return {
    ...layout,
    bar: { ...layout.bar, enabled: false },
  };
}

export function previewLogosOf(kit: BrandKit): {
  light: string | null;
  dark: string | null;
} {
  if (!kit.template.enabled) return { light: null, dark: null };
  return {
    light: kit.logos.light ? assetUrl(kit.logos.light, "thumb") : null,
    dark: kit.logos.dark ? assetUrl(kit.logos.dark, "thumb") : null,
  };
}

// The brand's layouts a person can pick for an idea: the ones that put words
// on the picture, plus the one in use.
export function pickableLayouts(
  kit: BrandKit,
  current: string | undefined,
): LayoutTemplate[] {
  if (!kit.layouts) return [];
  return kit.layouts.items.filter(
    (layout) => layout.headline.enabled || layout.id === current,
  );
}
