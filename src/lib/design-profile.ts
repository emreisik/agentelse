import { isArchetype, type Archetype } from "@/lib/auto-layout";
import type { AspectClass } from "@/lib/layout-templates";

// The one setting of the automatic post design: which design each post format
// takes. A feed post, a square, a landscape and a Story can each have their own;
// a format with no pick follows what the brand is (classifyArchetype). Stored as
// JSON on BrandVisualIdentity.designProfile and read defensively.

export const DESIGN_FORMATS = ["feed", "square", "landscape", "story"] as const;
export type DesignFormat = (typeof DESIGN_FORMATS)[number];

export const DESIGN_FORMAT_LABEL: Record<DesignFormat, string> = {
  feed: "Feed",
  square: "Square",
  landscape: "Landscape",
  story: "Story",
};

// A post format and the kind of canvas the layout code knows it by.
const ASPECT_OF_FORMAT: Record<DesignFormat, AspectClass> = {
  feed: "portrait",
  square: "square",
  landscape: "landscape",
  story: "vertical",
};

export function aspectOfDesignFormat(format: DesignFormat): AspectClass {
  return ASPECT_OF_FORMAT[format];
}

export function designFormatOfAspect(aspect: AspectClass): DesignFormat {
  return DESIGN_FORMATS.find((format) => ASPECT_OF_FORMAT[format] === aspect)!;
}

export type DesignProfile = {
  // The designs a person picked, per format. A format that is missing follows
  // the brand.
  formats: Partial<Record<DesignFormat, Archetype>>;
  // Only a person's choice is stored today; the field leaves room for a design
  // that was worked out and saved by the system.
  source: "user";
};

export function parseDesignProfile(value: unknown): DesignProfile | null {
  if (!value || typeof value !== "object") return null;
  const { formats, archetype, source } = value as {
    formats?: unknown;
    archetype?: unknown;
    source?: unknown;
  };
  if (source !== "user") return null;

  const picked: Partial<Record<DesignFormat, Archetype>> = {};
  // The first shape of this setting: one design for every format.
  if (isArchetype(archetype)) {
    for (const format of DESIGN_FORMATS) picked[format] = archetype;
  }
  if (formats && typeof formats === "object") {
    for (const format of DESIGN_FORMATS) {
      const design = (formats as Record<string, unknown>)[format];
      if (isArchetype(design)) picked[format] = design;
    }
  }
  return Object.keys(picked).length > 0 ? { formats: picked, source } : null;
}

// The design a person picked for a canvas, or null when the brand decides.
export function designForAspect(
  profile: DesignProfile | null | undefined,
  aspect: AspectClass,
): Archetype | null {
  return profile?.formats[designFormatOfAspect(aspect)] ?? null;
}

// The profile after a change: `design` for one format, or for all of them with
// `"all"`; null removes the pick (one format back to automatic, or everything).
// Null when nothing is left, which is how "all automatic" is stored.
export function withDesign(
  profile: DesignProfile | null | undefined,
  format: DesignFormat | "all",
  design: Archetype | null,
): DesignProfile | null {
  const formats: Partial<Record<DesignFormat, Archetype>> = {
    ...(profile?.formats ?? {}),
  };
  const targets = format === "all" ? DESIGN_FORMATS : [format];
  for (const target of targets) {
    if (design) formats[target] = design;
    else delete formats[target];
  }
  return Object.keys(formats).length > 0 ? { formats, source: "user" } : null;
}
