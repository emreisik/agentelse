import { describe, expect, it } from "vitest";

import {
  MediaAnalysisSchema,
  cleanTags,
  mediaCatalogLine,
  orientationOf,
} from "./brand-media";

describe("orientationOf", () => {
  it("names the shape of a photo", () => {
    expect(orientationOf(4000, 3000)).toBe("landscape");
    expect(orientationOf(3000, 4000)).toBe("portrait");
    expect(orientationOf(1000, 1050)).toBe("square");
    expect(orientationOf(null, 100)).toBeNull();
  });
});

describe("cleanTags", () => {
  it("lower-cases the Turkish way, drops hashtags, blanks and duplicates", () => {
    expect(cleanTags(["#Kahve", "KAHVE", "  İstanbul ", "", 7, "çay  evi"])).toEqual([
      "kahve",
      "istanbul",
      "çay evi",
    ]);
  });

  it("keeps at most 14, each at most 32 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    expect(cleanTags(many)).toHaveLength(14);
    expect(cleanTags(["x".repeat(80)])[0]).toHaveLength(32);
  });
});

describe("MediaAnalysisSchema", () => {
  it("reads a good answer", () => {
    const parsed = MediaAnalysisSchema.parse({
      description: "A barista pours milk into a cup.",
      tags: ["Kahve", "latte art"],
      subjects: ["barista", "cup"],
      setting: "cafe bar",
      mood: "warm, busy",
      shotType: "medium",
      hasPeople: true,
      quality: 88,
      dominantColors: ["#B9772F", "nope"],
      focalX: 0.4,
      focalY: 0.6,
    });
    expect(parsed).toMatchObject({
      tags: ["kahve", "latte art"],
      hasPeople: true,
      quality: 88,
      dominantColors: ["#b9772f"],
      focalX: 0.4,
    });
  });

  it("falls back safely when fields are missing or wrong, instead of failing", () => {
    const parsed = MediaAnalysisSchema.parse({
      shotType: "selfie",
      quality: "high",
      hasPeople: "yes",
      tags: "not a list",
      focalX: 4,
    });
    expect(parsed).toMatchObject({
      shotType: "other",
      quality: 60,
      hasPeople: false,
      tags: [],
      description: "",
    });
    expect(parsed.focalX).toBeUndefined();
  });

  it("clamps the quality into 0-100", () => {
    expect(MediaAnalysisSchema.parse({ quality: 250 }).quality).toBe(100);
    expect(MediaAnalysisSchema.parse({ quality: -4 }).quality).toBe(0);
  });
});

describe("mediaCatalogLine", () => {
  it("gives the id, the shape, the description and the first tags", () => {
    expect(
      mediaCatalogLine({
        id: "m1",
        description: "A barista at work.",
        tags: ["kahve", "barista"],
        orientation: "portrait",
      }),
    ).toBe("m1 [portrait] A barista at work. (kahve, barista)");
  });
});
