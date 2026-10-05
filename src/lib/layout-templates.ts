import { z } from "zod";

import type { KitTemplate } from "@/lib/brand-kit";

// Post layout templates: a brand's named, reusable "how a post is laid out"
// definitions. A layout drives two things at generation time:
//
//  1. DETERMINISTIC pixels, composited after the image exists (the logo, the
//     colour bar / brand band and the post's headline, typeset in the
//     headline zone) — identical on every post that uses it.
//  2. A written brief for the image model (where to keep the scene calm,
//     which areas the compositing will cover) — the model draws no text.
//
// Stored as JSON on BrandVisualIdentity.layoutTemplates. This module is pure
// and client-safe: the same functions build the gallery previews, the
// presets, and the generation-time settings.

export const LAYOUT_LOGO_POSITIONS = [
  "TOP_LEFT",
  "TOP_CENTER",
  "TOP_RIGHT",
  "BOTTOM_LEFT",
  "CENTER_BOTTOM",
  "BOTTOM_RIGHT",
] as const;
export type LayoutLogoPosition = (typeof LAYOUT_LOGO_POSITIONS)[number];

export const HEADLINE_ZONES = [
  "TOP",
  "UPPER_LEFT",
  "CENTER",
  "LEFT_COLUMN",
  "BOTTOM",
] as const;
export type HeadlineZone = (typeof HEADLINE_ZONES)[number];

// Aspect classes a layout can declare itself suited to.
export const ASPECT_CLASSES = [
  "portrait",
  "square",
  "landscape",
  "vertical",
] as const;
export type AspectClass = (typeof ASPECT_CLASSES)[number];

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const COLOR_ROLES = ["primary", "secondary", "accent"] as const;

const ColorRefSchema = z.union([z.enum(COLOR_ROLES), z.string().regex(HEX6)]);

export const LayoutTemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(160).default(""),
  // Empty = suits every format.
  formats: z.array(z.enum(ASPECT_CLASSES)).max(4).default([]),
  logo: z.object({
    position: z.enum(LAYOUT_LOGO_POSITIONS),
    sizePercent: z.number().int().min(8).max(30),
    marginPercent: z.number().int().min(1).max(15),
    // Sit inside the solid brand band instead of in the corner above it.
    onBand: z.boolean().default(false),
  }),
  bar: z.object({
    enabled: z.boolean(),
    position: z.enum(["TOP", "BOTTOM"]),
    heightPercent: z.number().int().min(2).max(20),
    // "line": the thin translucent accent stripe; "band": an opaque, taller
    // brand-colour band.
    style: z.enum(["line", "band"]),
    // A brand colour role, or a fixed #rrggbb.
    color: ColorRefSchema,
  }),
  headline: z.object({
    enabled: z.boolean(),
    zone: z.enum(HEADLINE_ZONES),
    align: z.enum(["left", "center"]),
    maxLines: z.number().int().min(1).max(5),
    scale: z.enum(["M", "L", "XL"]),
  }),
  // Free-text scene guidance for the image model (subject placement, where to
  // keep the frame calm). Empty = no extra guidance.
  composition: z.string().trim().max(240).default(""),
});

export type LayoutTemplate = z.infer<typeof LayoutTemplateSchema>;

export const LayoutTemplatesSchema = z
  .object({
    version: z.literal(1),
    defaultId: z.string(),
    items: z.array(LayoutTemplateSchema).min(1).max(12),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Layout ids must be unique",
        });
      }
      ids.add(item.id);
    }
    if (!ids.has(value.defaultId)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultId"],
        message: "defaultId must be one of the layouts",
      });
    }
  });

export type LayoutTemplates = z.infer<typeof LayoutTemplatesSchema>;

// Reads whatever is stored. One corrupt layout must not take the others down,
// so a value that fails as a whole is retried item by item; nothing usable
// yields null (callers then use the brand's base template as before).
export function parseLayoutTemplates(value: unknown): LayoutTemplates | null {
  const whole = LayoutTemplatesSchema.safeParse(value);
  if (whole.success) return whole.data;
  if (!value || typeof value !== "object") return null;

  const raw = value as { items?: unknown; defaultId?: unknown };
  if (!Array.isArray(raw.items)) return null;
  const seen = new Set<string>();
  const items: LayoutTemplate[] = [];
  for (const candidate of raw.items) {
    const parsed = LayoutTemplateSchema.safeParse(candidate);
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id);
      items.push(parsed.data);
    }
  }
  if (items.length === 0) return null;
  const defaultId =
    typeof raw.defaultId === "string" && seen.has(raw.defaultId)
      ? raw.defaultId
      : items[0]!.id;
  return { version: 1, defaultId, items: items.slice(0, 12) };
}

// --- presets ------------------------------------------------------------------

type BarDefaults = LayoutTemplate["bar"];
type HeadlineDefaults = LayoutTemplate["headline"];

const NO_BAR: BarDefaults = {
  enabled: false,
  position: "BOTTOM",
  heightPercent: 5,
  style: "line",
  color: "accent",
};
const NO_HEADLINE: HeadlineDefaults = {
  enabled: false,
  zone: "TOP",
  align: "center",
  maxLines: 3,
  scale: "L",
};

// The starter set every brand gets: deterministic (no model involved), each
// tuned to a different job. "classic" is the brand's own current template, so
// adopting layouts changes nothing until someone picks another one.
export function buildPresetLayouts(base: KitTemplate): LayoutTemplates {
  const classic: LayoutTemplate = {
    id: "classic",
    name: "Classic",
    description: "Logo in the corner with a thin color bar. Image only.",
    // Not for Story / Reel: a bar on the bottom edge would sit under the
    // app's own controls there.
    formats: ["portrait", "square", "landscape"],
    logo: {
      position: base.logoPosition,
      sizePercent: base.logoSizePercent,
      marginPercent: base.logoMarginPercent,
      onBand: false,
    },
    bar: {
      enabled: base.accentBarEnabled,
      position: base.accentBarPosition,
      heightPercent: base.accentBarHeightPercent,
      style: "line",
      color:
        base.accentBarColorHex && HEX6.test(base.accentBarColorHex)
          ? base.accentBarColorHex
          : "accent",
    },
    headline: NO_HEADLINE,
    composition: "",
  };

  return {
    version: 1,
    defaultId: "classic",
    items: [
      classic,
      {
        id: "headline-top",
        name: "Headline on top",
        description:
          "A centered headline over a calm upper third; subject below.",
        formats: ["portrait", "square"],
        logo: {
          position: "BOTTOM_LEFT",
          sizePercent: 14,
          marginPercent: 5,
          onBand: false,
        },
        bar: {
          enabled: true,
          position: "BOTTOM",
          heightPercent: 4,
          style: "line",
          color: "accent",
        },
        headline: {
          enabled: true,
          zone: "TOP",
          align: "center",
          maxLines: 3,
          scale: "L",
        },
        composition:
          "Keep the upper third calm and low-detail so the headline reads clearly; place the main subject in the lower two thirds.",
      },
      {
        id: "left-column",
        name: "Left column",
        description:
          "Headline in a left text column; the subject sits on the right.",
        formats: ["portrait", "square", "landscape"],
        logo: {
          position: "TOP_LEFT",
          sizePercent: 14,
          marginPercent: 5,
          onBand: false,
        },
        bar: {
          enabled: true,
          position: "BOTTOM",
          heightPercent: 3,
          style: "line",
          color: "accent",
        },
        headline: {
          enabled: true,
          zone: "LEFT_COLUMN",
          align: "left",
          maxLines: 4,
          scale: "M",
        },
        composition:
          "Place the main subject in the right half of the frame; keep the left 55% calm and uncluttered as a text column.",
      },
      {
        id: "center-statement",
        name: "Center statement",
        description: "One large centered statement over a soft, quiet scene.",
        formats: [],
        logo: {
          position: "TOP_CENTER",
          sizePercent: 18,
          marginPercent: 6,
          onBand: false,
        },
        bar: NO_BAR,
        headline: {
          enabled: true,
          zone: "CENTER",
          align: "center",
          maxLines: 4,
          scale: "XL",
        },
        composition:
          "Use a soft, low-contrast, low-detail scene so a large centered statement stays perfectly legible; the subject is subtle or abstract.",
      },
      {
        id: "bottom-band",
        name: "Brand band",
        description:
          "A solid brand-color band with the logo on it; headline above.",
        formats: ["portrait", "square", "landscape"],
        logo: {
          position: "BOTTOM_LEFT",
          sizePercent: 16,
          marginPercent: 4,
          onBand: true,
        },
        bar: {
          enabled: true,
          position: "BOTTOM",
          heightPercent: 13,
          style: "band",
          color: "primary",
        },
        headline: {
          enabled: true,
          zone: "BOTTOM",
          align: "left",
          maxLines: 3,
          scale: "L",
        },
        composition:
          "Keep the main subject in the upper two thirds; the bottom part of the frame stays plain because a solid brand-color band is added there.",
      },
      {
        id: "story-full",
        name: "Story / Reel",
        description:
          "Full-bleed vertical with content clear of the app's UI zones.",
        formats: ["vertical"],
        logo: {
          position: "CENTER_BOTTOM",
          sizePercent: 24,
          marginPercent: 6,
          onBand: false,
        },
        bar: NO_BAR,
        headline: {
          enabled: true,
          zone: "CENTER",
          align: "center",
          maxLines: 4,
          scale: "L",
        },
        composition:
          "Full-bleed vertical composition. Keep all key content between the top 13% and the bottom 18% of the frame, which the platform's own controls cover.",
      },
      {
        id: "minimal-corner",
        name: "Image only",
        description:
          "A single focal subject, no headline, a small corner logo.",
        formats: [],
        logo: {
          position: "TOP_RIGHT",
          sizePercent: 12,
          marginPercent: 4,
          onBand: false,
        },
        bar: NO_BAR,
        headline: NO_HEADLINE,
        composition:
          "Let the image speak: one clear focal subject and no text.",
      },
    ],
  };
}

// --- selection ---------------------------------------------------------------

export function aspectClassOf(size: {
  width: number;
  height: number;
}): AspectClass {
  const ratio = size.width / size.height;
  if (ratio < 0.6) return "vertical";
  if (ratio < 0.9) return "portrait";
  if (ratio <= 1.1) return "square";
  return "landscape";
}

function suits(
  layout: LayoutTemplate,
  aspect: AspectClass | undefined,
): boolean {
  return (
    !aspect || layout.formats.length === 0 || layout.formats.includes(aspect)
  );
}

// The layout a post should use: the one asked for by id, else the brand's
// default, else the first layout that suits the format. A requested id that
// no longer exists degrades to the default rather than failing the post.
export function resolveLayout(
  templates: LayoutTemplates | null | undefined,
  options: { id?: string | null; aspect?: AspectClass } = {},
): LayoutTemplate | null {
  if (!templates) return null;
  const byId = options.id
    ? templates.items.find((item) => item.id === options.id)
    : undefined;
  if (byId) return byId;

  const fallback =
    templates.items.find((item) => item.id === templates.defaultId) ??
    templates.items[0]!;
  // The brand's default wins unless it does not suit this format; then a
  // layout made for exactly this format beats a generic one.
  if (suits(fallback, options.aspect)) return fallback;
  return (
    templates.items.find(
      (item) => options.aspect && item.formats.includes(options.aspect),
    ) ??
    templates.items.find((item) => suits(item, options.aspect)) ??
    fallback
  );
}

// Makes `id` the brand's default: what new posts use. The same object back
// when it already is (or the id is not one of the layouts), so callers can
// tell nothing changed.
export function setDefaultLayout(
  templates: LayoutTemplates,
  id: string,
): LayoutTemplates {
  if (
    templates.defaultId === id ||
    !templates.items.some((item) => item.id === id)
  ) {
    return templates;
  }
  return { ...templates, defaultId: id };
}

// The app's post shapes, in the words the client knows them by. "landscape" is
// not offered as a post format, so it is left out.
export const POST_SHAPES: { aspect: AspectClass; label: string }[] = [
  { aspect: "portrait", label: "Post 3:4" },
  { aspect: "square", label: "Square 1:1" },
  { aspect: "vertical", label: "Story / Reel 9:16" },
];

// Where the default is NOT what a post gets: a layout made for other shapes
// hands them to the layout made for this one (resolveLayout). Shown next to
// the default so "I made it the default and it still came out different" has
// its answer on the screen.
export function defaultOverrides(
  templates: LayoutTemplates,
): { label: string; layout: LayoutTemplate }[] {
  const overrides: { label: string; layout: LayoutTemplate }[] = [];
  for (const { aspect, label } of POST_SHAPES) {
    const used = resolveLayout(templates, { aspect });
    if (used && used.id !== templates.defaultId) {
      overrides.push({ label, layout: used });
    }
  }
  return overrides;
}

// --- colour + compositing settings --------------------------------------------

export type LayoutPalette = {
  primary?: string | null;
  secondary?: string | null;
  accent?: string | null;
};

const ROLE_FALLBACK: Record<
  (typeof COLOR_ROLES)[number],
  (keyof LayoutPalette)[]
> = {
  primary: ["primary", "secondary", "accent"],
  secondary: ["secondary", "primary", "accent"],
  accent: ["accent", "primary", "secondary"],
};

// A layout's bar colour to a concrete hex: a fixed hex as-is, a role through
// the brand palette (falling back to the neighbouring roles), else null.
export function resolveLayoutColor(
  color: LayoutTemplate["bar"]["color"],
  palette: LayoutPalette,
): string | null {
  if (HEX6.test(color)) return color;
  for (const key of ROLE_FALLBACK[color as (typeof COLOR_ROLES)[number]]) {
    const value = palette[key];
    if (value) return value;
  }
  return null;
}

// The exact settings applyBrandTemplate() takes (creative-template.ts).
export type LayoutTemplateConfig = {
  enabled: true;
  logoPosition: LayoutLogoPosition;
  logoSizePercent: number;
  logoMarginPercent: number;
  accentBarEnabled: boolean;
  accentBarColorHex: string | null;
  accentBarHeightPercent: number;
  accentBarPosition: "TOP" | "BOTTOM";
  accentBarOpacity: number;
  logoOnBar: boolean;
};

const LINE_OPACITY = 0.85;

export function layoutToTemplateConfig(
  layout: LayoutTemplate,
  palette: LayoutPalette,
): LayoutTemplateConfig {
  const barColor = layout.bar.enabled
    ? resolveLayoutColor(layout.bar.color, palette)
    : null;
  const band = layout.bar.style === "band";
  return {
    enabled: true,
    logoPosition: layout.logo.position,
    logoSizePercent: layout.logo.sizePercent,
    logoMarginPercent: layout.logo.marginPercent,
    accentBarEnabled: layout.bar.enabled && Boolean(barColor),
    accentBarColorHex: barColor,
    accentBarHeightPercent: layout.bar.heightPercent,
    accentBarPosition: layout.bar.position,
    accentBarOpacity: band ? 1 : LINE_OPACITY,
    // Only meaningful with a real band underneath.
    logoOnBar:
      layout.logo.onBand && layout.bar.enabled && band && Boolean(barColor),
  };
}

// --- words for the image model --------------------------------------------------

const ZONE_PHRASE: Record<HeadlineZone, string> = {
  TOP: "in the upper third of the frame",
  UPPER_LEFT:
    "in the upper-left area of the frame, no wider than about two thirds of it",
  CENTER: "centered in the middle of the frame",
  LEFT_COLUMN:
    "in a column along the left side of the frame, about 55% of its width, vertically centered",
  BOTTOM:
    "in the lower third of the frame, sitting above any band or bar at the bottom edge",
};

const SCALE_PHRASE: Record<LayoutTemplate["headline"]["scale"], string> = {
  M: "medium-large",
  L: "large",
  XL: "very large and dominant",
};

const CORNER_PHRASE: Record<LayoutLogoPosition, string> = {
  TOP_LEFT: "the top-left corner",
  TOP_CENTER: "the top center",
  TOP_RIGHT: "the top-right corner",
  BOTTOM_LEFT: "the bottom-left corner",
  CENTER_BOTTOM: "the bottom center",
  BOTTOM_RIGHT: "the bottom-right corner",
};

// Where a post's on-image words go and how big they are: a layout's headline
// settings without the on/off switch. The words are typeset onto the picture
// after it is made (creative-text.ts), never drawn by the image model.
export type TextPlacement = Omit<LayoutTemplate["headline"], "enabled">;

// Words a post carries when its layout has no headline zone (no saved
// layouts, a layout without one, or compositing switched off): large and
// centered in the upper third.
export const FALLBACK_TEXT_PLACEMENT: TextPlacement = {
  zone: "TOP",
  align: "center",
  maxLines: 3,
  scale: "L",
};

// The zone in words, for the image model ("in the upper third of the frame").
export function headlineZonePhrase(zone: HeadlineZone): string {
  return ZONE_PHRASE[zone];
}

// Where and how the headline is set, for the TYPOGRAPHY block of the prompt.
export function headlinePlacement(
  headline: LayoutTemplate["headline"],
): string {
  return `${SCALE_PHRASE[headline.scale]}, ${headline.align === "center" ? "centered" : "left-aligned"}, at most ${headline.maxLines} line${headline.maxLines === 1 ? "" : "s"}, placed ${ZONE_PHRASE[headline.zone]}`;
}

// Areas the deterministic compositing will cover, so the image model keeps
// text and detail out of them.
export function layoutReservedZones(
  layout: LayoutTemplate,
  options: { hasLogo: boolean },
): string | undefined {
  const zones: string[] = [];
  const band = layout.bar.style === "band";

  if (layout.bar.enabled) {
    const edge = layout.bar.position === "TOP" ? "top" : "bottom";
    zones.push(
      band
        ? `the ${edge} ${layout.bar.heightPercent}% of the frame (a solid brand-color band is added there)`
        : `a thin band along the ${edge} edge (a brand color bar is added there)`,
    );
  }
  const logoOnBand = layout.logo.onBand && layout.bar.enabled && band;
  if (options.hasLogo && !logoOnBand) {
    zones.push(
      `${CORNER_PHRASE[layout.logo.position]} (the brand logo, about ${layout.logo.sizePercent}% of the width, is added there)`,
    );
  }
  return zones.length ? `${zones.join(" and ")}.` : undefined;
}

// One human-readable line for tool output and tooltips.
export function describeLayout(layout: LayoutTemplate): string {
  const parts: string[] = [];
  parts.push(
    layout.headline.enabled
      ? `headline ${layout.headline.zone.toLowerCase().replace("_", " ")}, ${layout.headline.align}`
      : "no headline",
  );
  parts.push(
    `logo ${CORNER_PHRASE[layout.logo.position].replace(/^the /, "")}`,
  );
  parts.push(
    layout.bar.enabled
      ? layout.bar.style === "band"
        ? `brand band ${layout.bar.position.toLowerCase()}`
        : `thin bar ${layout.bar.position.toLowerCase()}`
      : "no bar",
  );
  return parts.join(" · ");
}

// --- editing (pure, so the editor UI is thin and testable) -----------------------

export const MAX_LAYOUTS = 12;

export type BarMode = "none" | "line" | "band";

export function barModeOf(layout: LayoutTemplate): BarMode {
  if (!layout.bar.enabled) return "none";
  return layout.bar.style === "band" ? "band" : "line";
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

// Switching the bar mode keeps the rest coherent: a line is thin, a band is
// tall, and a logo can only sit ON a band, so leaving the band mode puts the
// logo back in the corner.
export function withBarMode(
  layout: LayoutTemplate,
  mode: BarMode,
): LayoutTemplate {
  if (mode === "none") {
    return {
      ...layout,
      bar: { ...layout.bar, enabled: false },
      logo: { ...layout.logo, onBand: false },
    };
  }
  if (mode === "line") {
    return {
      ...layout,
      bar: {
        ...layout.bar,
        enabled: true,
        style: "line",
        heightPercent: clampInt(layout.bar.heightPercent, 2, 8),
      },
      logo: { ...layout.logo, onBand: false },
    };
  }
  return {
    ...layout,
    bar: {
      ...layout.bar,
      enabled: true,
      style: "band",
      heightPercent: clampInt(layout.bar.heightPercent, 8, 20),
    },
  };
}

function uniqueCopyId(value: LayoutTemplates, id: string): string {
  const base = id.replace(/-copy(-\d+)?$/, "").slice(0, 32);
  const taken = new Set(value.items.map((item) => item.id));
  let candidate = `${base}-copy`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-copy-${n}`;
  return candidate;
}

// A copy of a layout, appended to the set. Null when the set is full or the
// layout does not exist.
export function duplicateLayout(
  value: LayoutTemplates,
  id: string,
): { value: LayoutTemplates; newId: string } | null {
  const source = value.items.find((item) => item.id === id);
  if (!source || value.items.length >= MAX_LAYOUTS) return null;
  const newId = uniqueCopyId(value, id);
  const copy: LayoutTemplate = {
    ...source,
    id: newId,
    name: `${source.name || "Layout"} copy`.slice(0, 40),
  };
  return { value: { ...value, items: [...value.items, copy] }, newId };
}

// Removes a layout. The default and the last remaining layout cannot go.
export function removeLayout(
  value: LayoutTemplates,
  id: string,
): LayoutTemplates | null {
  if (value.items.length <= 1 || id === value.defaultId) return null;
  if (!value.items.some((item) => item.id === id)) return null;
  return { ...value, items: value.items.filter((item) => item.id !== id) };
}

// The editor lets a name be cleared while typing; a saved layout needs one.
export function normalizeLayoutNames(value: LayoutTemplates): LayoutTemplates {
  return {
    ...value,
    items: value.items.map((item) => ({
      ...item,
      name: item.name.trim().slice(0, 40) || "Layout",
    })),
  };
}
