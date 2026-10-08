import { z } from "zod";

// What the library understands about a brand's own photo (BrandMedia), read off
// the picture once so ideas and posts can find and use it. Pure and client-safe.

// Bump when the prompt or the schema below changes meaning: the worker then
// analyses the library again (brand-media-analysis tick step).
export const MEDIA_ANALYSIS_VERSION = 1;

export const MEDIA_MAX_SIDE = 2400;
export const MEDIA_MIN_SIDE = 400;
export const MEDIA_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MEDIA_ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  // iPhone photos: converted to JPEG when the server's image library can read
  // them.
  "image/heic",
  "image/heif",
]);
// Analyses one project may run in a day, so a bulk upload cannot use up the
// day's shared AI calls.
export const MEDIA_ANALYSES_PER_DAY = 60;
export const MEDIA_MAX_TAGS = 14;

export const SHOT_TYPES = [
  "closeup",
  "detail",
  "medium",
  "wide",
  "aerial",
  "flatlay",
  "portrait",
  "interior",
  "exterior",
  "other",
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

export type MediaOrientation = "landscape" | "portrait" | "square";

export function orientationOf(
  width: number | null | undefined,
  height: number | null | undefined,
): MediaOrientation | null {
  if (!width || !height) return null;
  const ratio = width / height;
  if (ratio > 1.12) return "landscape";
  if (ratio < 0.89) return "portrait";
  return "square";
}

// Tags as the library keeps them: trimmed, lower-case, no hashtags, no
// duplicates, short.
export function cleanTags(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const tag = value
      .replace(/^#+/, "")
      .trim()
      .toLocaleLowerCase("tr")
      .replace(/\s+/g, " ")
      .slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MEDIA_MAX_TAGS) break;
  }
  return out;
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.slice(0, max))
    .catch("");

// The model's answer. Lenient on purpose: a field it skips or mangles falls
// back to a safe value instead of failing the whole analysis.
export const MediaAnalysisSchema = z.object({
  description: text(300),
  tags: z.array(z.unknown()).catch([]).transform((list) => cleanTags(list)),
  subjects: z
    .array(z.unknown())
    .catch([])
    .transform((list) => cleanTags(list).slice(0, 8)),
  setting: text(120),
  mood: text(80),
  shotType: z.enum(SHOT_TYPES).catch("other"),
  hasPeople: z.boolean().catch(false),
  // How good it is as the picture of a post: sharp, well lit, well composed,
  // with room for a headline.
  quality: z
    .number()
    .catch(60)
    .transform((value) => Math.max(0, Math.min(100, Math.round(value)))),
  dominantColors: z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      list
        .filter((c): c is string => typeof c === "string")
        .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
        .map((c) => c.toLowerCase())
        .slice(0, 3),
    ),
  // Where the main subject sits, as fractions of the width and the height.
  focalX: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .catch(undefined),
  focalY: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .catch(undefined),
});
export type MediaAnalysis = z.infer<typeof MediaAnalysisSchema>;

// A short line for a catalog (the idea engine, the chat): enough to choose by.
export function mediaCatalogLine(media: {
  id: string;
  description: string | null;
  tags: readonly string[];
  orientation: string | null;
}): string {
  const tags = media.tags.slice(0, 8).join(", ");
  return `${media.id} [${media.orientation ?? "?"}] ${media.description ?? ""}${tags ? ` (${tags})` : ""}`.trim();
}
