import { beforeEach, describe, expect, it, vi } from "vitest";

const openai = vi.hoisted(() => ({ runOpenAIStructured: vi.fn() }));
vi.mock("@/server/reasoning/openai-client", () => ({
  openaiModelForTier: () => "test-model",
  runOpenAIStructured: openai.runOpenAIStructured,
}));

import {
  artContextOf,
  buildArtDirectorPrompt,
  directImage,
} from "./art-director";

const brandContext = {
  country: "TR",
  language: "tr",
  positioning: "Mahalle fırını: her sabah taze",
  toneOfVoice: "sıcak, samimi",
  targetAudiences: [{ label: "Aileler" }, "Öğrenciler"],
  products: [{ name: "Simit" }, "Poğaça"],
  brandConstitution: {
    summary: "Kadıköy'de 1984'ten beri taş fırında üretim",
    payload: {
      businessModel: "Mahalle fırını",
      differentiators: ["Taş fırın", "Günlük üretim"],
    },
  },
  brandLearnings: [{ insight: "Yakın çekim ürün fotoğrafları iyi çalışıyor" }],
  negativeBrief: [{ rule: "Plastik ambalaj gösterme" }],
  recentApprovedCreatives: [
    { versions: [{ generationMetadata: { prompt: "A tray of simit on a marble counter" } }] },
  ],
  visualIdentity: {
    photographyStyle: "PHOTOGRAPHIC",
    styleRefinement: "soft natural light",
    moodTags: ["warm", "rustic"],
    alwaysInclude: ["steam"],
    alwaysAvoid: ["neon"],
    primaryColors: [{ name: "Crust", hex: "#b9772f" }],
    secondaryColors: [],
    accentColors: [{ hex: "#2b1d12" }],
  },
  visualGuidelines: "noise that must not reach the director",
  brandFacts: ["noise"],
};

describe("artContextOf", () => {
  it("reads who the brand is, who it serves and how its pictures look", () => {
    const context = artContextOf(brandContext);
    expect(context).toMatchObject({
      country: "TR",
      about: "Kadıköy'de 1984'ten beri taş fırında üretim",
      business: "Mahalle fırını",
      audiences: ["Aileler", "Öğrenciler"],
      products: ["Simit", "Poğaça"],
      differentiators: ["Taş fırın", "Günlük üretim"],
      whatWorks: ["Yakın çekim ürün fotoğrafları iyi çalışıyor"],
      neverShow: ["Plastik ambalaj gösterme"],
      recentScenes: ["A tray of simit on a marble counter"],
    });
    expect(context.look).toMatchObject({
      photographyStyle: "PHOTOGRAPHIC",
      mood: ["warm", "rustic"],
      alwaysInclude: ["steam"],
      alwaysAvoid: ["neon"],
      primary: ["Crust #b9772f"],
      accent: ["#2b1d12"],
    });
  });

  it("leaves out what a picture does not need", () => {
    const context = artContextOf(brandContext);
    expect(JSON.stringify(context)).not.toContain("noise");
  });

  it("copes with an empty or odd context", () => {
    expect(artContextOf(null)).toMatchObject({ audiences: [], products: [], look: null });
    expect(artContextOf("x")).toMatchObject({ audiences: [] });
  });
});

describe("buildArtDirectorPrompt", () => {
  const base = {
    brandContext,
    brief: "Autumn menu launch",
    caption: "Sonbahar geldi",
    draft: "A table with autumn dishes",
    platformLabel: "Instagram",
    formatLabel: "Post",
    pixelSize: { width: 1080, height: 1440 },
  };

  it("teaches the craft: brand first, concept, a shot list, brand fit, no text, no AI tells", () => {
    const { system } = buildArtDirectorPrompt(base);
    for (const part of [
      "Understand the brand first",
      "Find the concept",
      "lens focal length",
      "NATURALLY",
      "NO text",
      "AI tells",
      "Keep what is asked",
    ]) {
      expect(system).toContain(part);
    }
  });

  it("gives the brand, the brief, the draft, the format and the calm area", () => {
    const { user } = buildArtDirectorPrompt({
      ...base,
      calmArea: "in the upper third of the frame",
      reservedZones: "the bottom-left corner (the logo).",
    });
    expect(user).toContain("Mahalle fırını");
    expect(user).toContain("POST BRIEF: Autumn menu launch");
    expect(user).toContain("DRAFT PICTURE PROMPT: A table with autumn dishes");
    expect(user).toContain("FORMAT: Instagram Post (1080x1440px)");
    expect(user).toContain("CALM AREA: the post's headline is typeset in the upper third");
    expect(user).toContain("RESERVED AREAS: the bottom-left corner");
  });

  it("asks for alternatives only when more than one picture is made", () => {
    expect(buildArtDirectorPrompt(base).system).not.toContain("`alternatives`");
    const three = buildArtDirectorPrompt({ ...base, pictures: 3 }).system;
    expect(three).toContain("exactly 2 more complete");
  });

  it("defers to the example posts and to real product photos when there are some", () => {
    const { system } = buildArtDirectorPrompt({
      ...base,
      followsExamples: true,
      hasProductPhotos: true,
    });
    expect(system).toContain("decide the DESIGN");
    expect(system).toContain("show exactly that product");
  });
});

describe("directImage", () => {
  beforeEach(() => vi.resetAllMocks());

  const answer = {
    concept: "Morning ritual",
    subject: "Fresh simit on a linen cloth",
    setting: "Stone oven counter",
    composition: "Low angle",
    lighting: "Warm window light",
    technique: "85mm f/2",
    texture: "Sesame seeds and flour dust",
    mood: "Warm",
    avoid: ["plastic packaging"],
  };

  it("returns the direction the model gave", async () => {
    openai.runOpenAIStructured.mockResolvedValue({ raw: answer });
    const result = await directImage({ brandContext, brief: "x" });
    expect(result).toMatchObject({ concept: "Morning ritual", avoid: ["plastic packaging"] });
    const call = openai.runOpenAIStructured.mock.calls[0]![0];
    expect(call.model).toBe("test-model");
    expect(call.jsonSchema.properties).toHaveProperty("lighting");
  });

  it("is null for an answer with a gap, or when the call fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openai.runOpenAIStructured.mockResolvedValue({ raw: { ...answer, subject: "" } });
    expect(await directImage({ brandContext, brief: "x" })).toBeNull();
    openai.runOpenAIStructured.mockRejectedValue(new Error("boom"));
    expect(await directImage({ brandContext, brief: "x" })).toBeNull();
    quiet.mockRestore();
  });
});
