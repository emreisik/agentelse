import { beforeEach, describe, expect, it, vi } from "vitest";

// A post's on-image words on the worker path (a Works plan's pieces): when the
// brand's layout has a headline zone, the text step writes a short headline
// (and an optional sub-line), the image model gets a textless brief that keeps
// the zone calm, and the compositing typesets the words in the layout's zone.
// The post's other formats are laid out from its clean picture and get the
// same words again. A brand with no layout and no kit is untouched.

const runOpenAIStructured = vi.fn();
vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => true,
  openaiModelForTier: () => "gpt-test",
  runOpenAIStructured,
}));

const generateCreativeImage = vi.fn();
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage,
  isCreativeImageConfigured: () => true,
}));
vi.mock("@/server/media/brand-logo", () => ({
  loadReferenceImage: vi.fn().mockResolvedValue(null),
}));
const applyBrandTemplate = vi.fn();
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));
const storage = vi.hoisted(() => ({
  readAsset: vi.fn(),
  putAsset: vi.fn(),
  deleteAsset: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => storage);
const readPictureForAdapting = vi.fn();
vi.mock("@/server/media/adapt-picture", async (original) => ({
  ...(await original<typeof import("@/server/media/adapt-picture")>()),
  readPictureForAdapting,
}));

const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");
const { OpenAiCreativeProvider } = await import("./openai-creative.provider");

const rendered = {
  storageKey: "r2://post.png",
  filename: "post.png",
  mimeType: "image/png",
  size: 1,
  provider: "openai",
  width: 1080,
  height: 1350,
};

// The brand's saved layouts with `defaultId` as the default (null: none saved).
function brandContext(defaultId: string | null) {
  const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
  return {
    logoAssetId: "logo-light",
    darkLogoAssetId: null,
    approvedColors: null,
    approvedFonts: ["Montserrat", "Open Sans"],
    visualIdentity: {
      primaryColors: [{ hex: "#0b1f3a" }],
      secondaryColors: [],
      accentColors: [{ hex: "#f97316" }],
      photographyStyle: null,
      styleRefinement: null,
      moodTags: [],
      compositionNotes: null,
      backgroundTone: null,
      alwaysInclude: [],
      alwaysAvoid: [],
      referenceImageAssetId: null,
      layoutTemplates: defaultId ? { ...layouts, defaultId } : null,
      template: { ...DEFAULT_KIT_TEMPLATE },
    },
  };
}

async function run(payload: Record<string, unknown>) {
  const provider = new OpenAiCreativeProvider();
  const { executionReference } = await provider.execute({
    executionJobId: "job-1",
    correlationId: "corr-1",
    idempotencyKey: "k",
    capability: "CREATE_SOCIAL_CREATIVE",
    context: {
      workspaceId: "w",
      projectId: "p",
      brandId: "b",
      taskId: "t",
      capability: "CREATE_SOCIAL_CREATIVE",
      riskLevel: "LOW",
    },
    payload: {
      request: "Instagram post: Weekend brunch\nIdea: our new brunch menu",
      platform: "INSTAGRAM",
      ...payload,
    },
  });
  return provider.getStatus(executionReference);
}

const textStep = () =>
  runOpenAIStructured.mock.calls[0]![0] as {
    system: string;
    jsonSchema: { properties: Record<string, unknown> };
  };
const imagePrompt = (call = 0) =>
  generateCreativeImage.mock.calls[call]![0] as string;
const templateText = (call = 0) => applyBrandTemplate.mock.calls[call]![0].text;

beforeEach(() => {
  vi.clearAllMocks();
  runOpenAIStructured.mockResolvedValue({
    raw: {
      caption: "Brunch is back",
      copy: "Copy",
      imagePrompt: "A sunlit brunch table",
      headline: "Pazar kahvaltısı geri döndü",
      highlight: "geri döndü",
      lines: ["Rezervasyon profilde"],
    },
  });
  generateCreativeImage.mockResolvedValue(rendered);
  applyBrandTemplate.mockResolvedValue({ size: 2, textDrawn: true });
  storage.readAsset.mockResolvedValue(Buffer.from("clean-bytes"));
  storage.putAsset.mockResolvedValue({
    storageKey: "r2://clean.png",
    filename: "clean.png",
  });
  storage.deleteAsset.mockResolvedValue(true);
});

describe("a layout with a headline zone (Works plan path)", () => {
  it("asks the text step for a short headline, keeps the picture textless and typesets the words in the zone", async () => {
    const status = await run({ brandContext: brandContext("headline-top") });

    expect(textStep().jsonSchema.properties).toHaveProperty("headline");
    expect(textStep().jsonSchema.properties).toHaveProperty("lines");
    expect(textStep().system).toContain("at most 6 words");
    expect(textStep().system).toContain("same language as the caption");

    const prompt = imagePrompt();
    expect(prompt).toContain("completely textless");
    expect(prompt).toContain(
      "The post's headline is typeset onto the image afterwards in the upper third of the frame",
    );
    expect(prompt).not.toContain("Pazar kahvaltısı");
    expect(prompt).not.toContain("TYPOGRAPHY:");

    expect(templateText()).toEqual({
      headline: "Pazar kahvaltısı geri döndü",
      highlight: "geri döndü",
      lines: ["Rezervasyon profilde"],
      placement: { zone: "TOP", align: "center", maxLines: 3, scale: "L" },
      fontFamily: "Montserrat",
      darkInk: "#0b1f3a",
      accentHex: "#f97316",
      // A feed post: no platform UI to keep clear of.
      safeZone: undefined,
    });

    // The clean picture is kept (before the words went on) for the post's
    // other formats, and both are recorded on the result.
    expect(storage.putAsset).toHaveBeenCalledWith(
      Buffer.from("clean-bytes"),
      "png",
      "image/png",
    );
    expect(status).toMatchObject({
      status: "COMPLETED",
      rawResult: {
        layoutTemplate: { id: "headline-top", name: "Headline on top" },
        onImageText: {
          headline: "Pazar kahvaltısı geri döndü",
          highlight: "geri döndü",
          lines: ["Rezervasyon profilde"],
        },
        cleanPicture: { storageKey: "r2://clean.png", mimeType: "image/png" },
      },
    });
  });

  it("keeps a Story's words out of the app's own interface", async () => {
    generateCreativeImage.mockResolvedValue({
      ...rendered,
      width: 1080,
      height: 1920,
    });
    await run({
      brandContext: brandContext("headline-top"),
      contentFormat: "STORY",
    });
    // The Story's own layout (centered statement), clear of Instagram's UI.
    expect(templateText()).toMatchObject({
      placement: { zone: "CENTER" },
      safeZone: { top: 13, bottom: 17.7 },
    });
  });

  it("records no words and drops the clean copy when none could be set", async () => {
    applyBrandTemplate.mockResolvedValue({ size: 2, textDrawn: false });
    const status = await run({ brandContext: brandContext("headline-top") });
    expect(storage.deleteAsset).toHaveBeenCalledWith("r2://clean.png");
    const raw = (status as { rawResult: Record<string, unknown> }).rawResult;
    expect(raw).not.toHaveProperty("onImageText");
    expect(raw).not.toHaveProperty("cleanPicture");
  });

  it("an empty headline from the text step means a post without words", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: { caption: "c", copy: "d", imagePrompt: "p", headline: " " },
    });
    await run({ brandContext: brandContext("headline-top") });
    expect(templateText()).toBeUndefined();
    expect(imagePrompt()).not.toContain("typeset onto the image afterwards");
    expect(storage.putAsset).not.toHaveBeenCalled();
  });

  it("variants carry the same words on every picture", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: {
        caption: "c",
        copy: "d",
        imagePrompt: "p1",
        alternativeImagePrompts: ["p2", "p3"],
        headline: "Pazar kahvaltısı",
      },
    });
    await run({ brandContext: brandContext("headline-top"), variantCount: 3 });
    expect(textStep().jsonSchema.properties).toHaveProperty(
      "alternativeImagePrompts",
    );
    expect(textStep().jsonSchema.properties).toHaveProperty("headline");
    expect(applyBrandTemplate).toHaveBeenCalledTimes(3);
    for (const call of [0, 1, 2]) {
      expect(templateText(call)).toMatchObject({
        headline: "Pazar kahvaltısı",
      });
    }
  });
});

describe("no words to set", () => {
  it("a layout without a headline zone keeps the textless post and the plain text step", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: { caption: "c", copy: "d", imagePrompt: "p" },
    });
    await run({ brandContext: brandContext("classic") });
    expect(textStep().jsonSchema.properties).not.toHaveProperty("headline");
    expect(templateText()).toBeUndefined();
    expect(storage.putAsset).not.toHaveBeenCalled();
  });

  it("a brand with no layouts and no kit is exactly as before", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: { caption: "c", copy: "d", imagePrompt: "p" },
    });
    const status = await run({ brandContext: brandContext(null) });
    expect(textStep().jsonSchema.properties).not.toHaveProperty("headline");
    expect(textStep().system).not.toContain("ALSO produce");
    expect(imagePrompt()).toContain("completely textless");
    expect(imagePrompt()).not.toContain("typeset onto the image afterwards");
    expect(templateText()).toBeUndefined();
    const raw = (status as { rawResult: Record<string, unknown> }).rawResult;
    expect(raw).not.toHaveProperty("onImageText");
  });
});

describe("another format of a post with words", () => {
  it("is laid out from the clean picture and gets the same words again in its own layout", async () => {
    readPictureForAdapting.mockResolvedValue({
      data: "CLEAN",
      mimeType: "image/png",
      text: {
        headline: "Pazar kahvaltısı geri döndü",
        lines: ["Rezervasyon profilde"],
      },
    });
    generateCreativeImage.mockResolvedValue({
      ...rendered,
      width: 1080,
      height: 1920,
    });
    await run({
      brandContext: brandContext("headline-top"),
      contentFormat: "STORY",
      adaptFromAssetId: "post-picture",
    });

    // Its words come from the post, not from a second headline.
    expect(textStep().jsonSchema.properties).not.toHaveProperty("headline");
    const [prompt, options] = generateCreativeImage.mock.calls[0]!;
    expect(prompt).toContain(
      "The picture carries no text and must stay that way",
    );
    expect(prompt).not.toContain("Keep every word of on-image text");
    expect(options.baseImage).toEqual({ data: "CLEAN", mimeType: "image/png" });
    expect(templateText()).toMatchObject({
      headline: "Pazar kahvaltısı geri döndü",
      lines: ["Rezervasyon profilde"],
      placement: { zone: "CENTER" },
    });
    // An adaptation keeps no clean copy of its own.
    expect(storage.putAsset).not.toHaveBeenCalled();
  });

  it("a post picture that already carries its words keeps them as they are", async () => {
    readPictureForAdapting.mockResolvedValue({
      data: "FINISHED",
      mimeType: "image/png",
    });
    await run({
      brandContext: brandContext("headline-top"),
      adaptFromAssetId: "old-post",
    });
    expect(imagePrompt()).toContain(
      "Keep every word of on-image text exactly as written",
    );
    expect(templateText()).toBeUndefined();
  });
});
