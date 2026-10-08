import type { ReasoningDef } from "../types";
import {
  MediaAnalysisSchema,
  SHOT_TYPES,
  cleanTags,
  type MediaAnalysis,
} from "@/lib/brand-media";

// One of a brand's own photos, read so ideas can find it and posts can use it.
// Mechanical, high-volume and cheap: the "lite" vision tier, one 768px picture.
// People are described only generically: the library must never identify
// anyone or guess personal traits.
export const brandMediaDef: ReasoningDef<MediaAnalysis> = {
  purpose: "brand.media.analyze",
  schema: MediaAnalysisSchema,
  tier: "lite" as const,
  maxTokens: 900,

  buildPrompt(context) {
    const filename =
      typeof context.filename === "string" ? context.filename : "";
    return {
      system: [
        "You catalogue ONE photograph from a brand's own library so that a social-media team can find the right picture for a post idea. Describe what is really visible; never invent.",
        "",
        "description: one or two plain sentences saying what the picture shows and how it feels (subject, place, light). No marketing language.",
        "tags: 8-14 short lowercase search tags in the project language: the subject, the place, the activity, the product or dish, the season or time of day, the mood. Specific words a person would search for, never generic filler like 'photo' or 'image'.",
        "subjects: the 1-5 main things in the picture, as short nouns.",
        "setting: the place in a few words (for example 'cafe interior', 'workshop', 'outdoor terrace').",
        "mood: two or three words.",
        `shotType: exactly one of ${SHOT_TYPES.join(", ")}.`,
        "hasPeople: true if any person is clearly visible. Describe people only generically ('a customer', 'two staff members', 'a chef at work'). NEVER identify anyone, and never guess age, ethnicity, health or any personal trait.",
        "quality: 0-100, how good this is as the picture of a social post: sharp, well exposed, well composed, free of clutter and watermarks, with some calm area where a headline could go. Blurry, dark, screenshots, documents or heavily cropped pictures score low.",
        "dominantColors: up to three dominant colours as #rrggbb.",
        "focalX and focalY: where the main subject's centre sits, from 0 (left / top) to 1 (right / bottom).",
        "",
        "Base everything strictly on what is visible. Read any text in the picture only to understand it, never to name a business.",
      ].join("\n"),
      user: filename
        ? `The file is called "${filename}". Catalogue the attached photo.`
        : "Catalogue the attached photo.",
    };
  },

  buildMock(context) {
    const filename =
      typeof context.filename === "string" ? context.filename : "photo";
    const words = cleanTags(
      filename
        .replace(/\.[a-z0-9]+$/i, "")
        .split(/[\s._-]+/)
        .filter((word) => word.length > 2),
    );
    return {
      description: `Mock description of ${filename}.`,
      tags: words.length > 0 ? words : ["mock"],
      subjects: words.slice(0, 3),
      setting: "mock setting",
      mood: "calm",
      shotType: "medium",
      hasPeople: false,
      quality: 70,
      dominantColors: [],
      focalX: 0.5,
      focalY: 0.5,
    };
  },
};
