import { beforeEach, describe, expect, it, vi } from "vitest";

// Inline (chat-driven) creative generation: the conversation model already
// wrote the copy and image prompt, so the provider must skip its own text LLM
// call, honour the requested quality, and — only when somebody is watching —
// stream previews and skip the Gemini detour.

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
vi.mock("@/server/media/creative-template", () => ({
  applyBrandTemplate: vi.fn().mockResolvedValue(null),
}));

const { applyBrandTemplate } = await import("@/server/media/creative-template");
const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");
const { OpenAiCreativeProvider } = await import("./openai-creative.provider");
const { subscribeCreativeProgress } = await import(
  "@/server/media/creative-progress"
);

const image = {
  storageKey: "r2://x.png",
  filename: "x.png",
  mimeType: "image/png",
  size: 1,
  provider: "openai",
  width: 1080,
  height: 1350,
};

function request(payload: Record<string, unknown>) {
  return {
    executionJobId: "job-1",
    correlationId: "corr-1",
    idempotencyKey: "k",
    capability: "CREATE_SOCIAL_CREATIVE" as const,
    context: {
      workspaceId: "w",
      projectId: "p",
      brandId: "b",
      taskId: "t",
      capability: "CREATE_SOCIAL_CREATIVE" as const,
      riskLevel: "LOW" as const,
    },
    payload,
  };
}

const preset = { caption: "Cap", copy: "Copy", imagePrompt: "A calm clinic" };

beforeEach(() => {
  vi.clearAllMocks();
  generateCreativeImage.mockResolvedValue(image);
});

describe("OpenAiCreativeProvider inline generation", () => {
  it("skips its text LLM call when the chat supplied a preset", async () => {
    const provider = new OpenAiCreativeProvider();
    const { executionReference } = await provider.execute(
      request({ request: "brief", preset, quality: "medium" }),
    );

    expect(runOpenAIStructured).not.toHaveBeenCalled();
    const status = await provider.getStatus(executionReference);
    expect(status).toMatchObject({
      status: "COMPLETED",
      rawResult: { caption: "Cap", copy: "Copy" },
    });
    const [prompt, options] = generateCreativeImage.mock.calls[0]!;
    expect(prompt).toContain("A calm clinic");
    expect(options.quality).toBe("medium");
  });

  it("does not stream or skip Gemini when nobody is watching", async () => {
    await new OpenAiCreativeProvider().execute(
      request({ request: "brief", preset, quality: "medium" }),
    );
    const options = generateCreativeImage.mock.calls[0]![1];
    expect(options.onPartial).toBeUndefined();
    expect(options.skipGemini).toBeUndefined();
  });

  it("streams previews to the watcher and skips Gemini", async () => {
    const seen: unknown[] = [];
    const off = subscribeCreativeProgress("job-1", (e) => seen.push(e));
    generateCreativeImage.mockImplementation(async (_p, options) => {
      options.onPartial({ index: 0, b64: "AAA" });
      return image;
    });

    await new OpenAiCreativeProvider().execute(
      request({ request: "brief", preset }),
    );
    off();

    expect(seen).toEqual([
      { type: "partial", index: 0, dataUrl: "data:image/png;base64,AAA" },
    ]);
    expect(generateCreativeImage.mock.calls[0]![1].skipGemini).toBe(true);
  });

  it("falls back to its own LLM when there is no valid preset (worker path)", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: { caption: "c", copy: "d", imagePrompt: "p" },
    });
    await new OpenAiCreativeProvider().execute(request({ request: "brief" }));

    expect(runOpenAIStructured).toHaveBeenCalledTimes(1);
    // No quality in the payload: the image client's own default ("high").
    expect(generateCreativeImage.mock.calls[0]![1].quality).toBeUndefined();
  });

  it("headline mode: adds only the headline, no imposed style, and still composites the brand logo", async () => {
    await new OpenAiCreativeProvider().execute({
      ...request({
        request: "brief",
        preset: {
          ...preset,
          overlay: {
            headline: "Klinik siteniz ilk soruları yanıtlıyor mu?",
            highlight: "ilk soruları",
          },
        },
      }),
    });

    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).toContain("TYPOGRAPHY:");
    expect(prompt).toContain('"Klinik siteniz ilk soruları yanıtlıyor mu?"');
    expect(prompt).toContain('"ilk soruları"');
    // The design is the brand's, not a house style baked into the code.
    expect(prompt).not.toMatch(/marble|olive|glass panels|editorial concept photography/i);
    // No AI-drawn wordmark / site address: the logo is composited for real.
    expect(prompt).not.toMatch(/wordmark|letter-spaced/i);
    expect(prompt).not.toContain("completely textless");
    expect(applyBrandTemplate).toHaveBeenCalledTimes(1);
  });

  it("without an overlay the classic textless prompt and logo template are unchanged", async () => {
    await new OpenAiCreativeProvider().execute(
      request({ request: "brief", preset }),
    );
    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("TYPOGRAPHY:");
    expect(prompt).toContain("completely textless");
    expect(applyBrandTemplate).toHaveBeenCalledTimes(1);
  });
});

// A brand's saved post layouts steer BOTH halves of a post: the prompt (where
// the scene keeps clear, where the headline goes) and the deterministic
// compositing (logo / bar / band). Brands without layouts must be untouched.
describe("OpenAiCreativeProvider with post layouts", () => {
  const brandContext = (withLayouts: boolean) => ({
    logoAssetId: "logo-light",
    darkLogoAssetId: null,
    approvedColors: null,
    visualIdentity: {
      primaryColors: [{ hex: "#0b1f3a" }],
      secondaryColors: [{ hex: "#0d9488" }],
      accentColors: [{ hex: "#2dd4bf" }],
      photographyStyle: null,
      styleRefinement: null,
      moodTags: [],
      compositionNotes: null,
      backgroundTone: null,
      alwaysInclude: [],
      alwaysAvoid: [],
      referenceImageAssetId: null,
      layoutTemplates: withLayouts ? buildPresetLayouts(DEFAULT_KIT_TEMPLATE) : null,
      template: { ...DEFAULT_KIT_TEMPLATE },
    },
  });

  const templateArgs = () =>
    vi.mocked(applyBrandTemplate).mock.calls[0]![0] as Parameters<
      typeof applyBrandTemplate
    >[0];

  it("applies the requested layout to the prompt, the compositing and the stored result", async () => {
    const provider = new OpenAiCreativeProvider();
    const { executionReference } = await provider.execute(
      request({
        request: "brief",
        platform: "INSTAGRAM",
        brandContext: brandContext(true),
        preset: { ...preset, layoutId: "bottom-band" },
      }),
    );

    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).toContain("bottom part of the frame stays plain");
    expect(prompt).toContain("bottom 13% of the frame");
    expect(prompt).toContain("completely textless");

    const args = templateArgs();
    expect(args.template).toMatchObject({
      enabled: true,
      logoOnBar: true,
      accentBarColorHex: "#0b1f3a",
      accentBarHeightPercent: 13,
    });
    // A feed post has no platform UI bands to keep the logo out of.
    expect(args.safeZone).toBeUndefined();
    // With a layout the logo's padding is cropped so size / margin are exact.
    expect(args.trimLogo).toBe(true);

    expect(await provider.getStatus(executionReference)).toMatchObject({
      status: "COMPLETED",
      rawResult: { layoutTemplate: { id: "bottom-band", name: "Brand band" } },
    });
  });

  it("uses the layout made for a Story and keeps the logo out of Instagram's own UI", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        platform: "INSTAGRAM",
        contentFormat: "STORY",
        brandContext: brandContext(true),
        preset,
      }),
    );

    const args = templateArgs();
    expect(args.safeZone).toEqual({ top: 13, bottom: 17.7 });
    expect(args.template).toMatchObject({
      accentBarEnabled: false,
      logoPosition: "CENTER_BOTTOM",
    });
  });

  it("places the headline where the layout says", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        platform: "INSTAGRAM",
        brandContext: brandContext(true),
        preset: {
          ...preset,
          layoutId: "headline-top",
          overlay: { headline: "Sitenizi taratın", highlight: "taratın" },
        },
      }),
    );

    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).toContain("TYPOGRAPHY:");
    expect(prompt).toContain("upper third of the frame");
    expect(prompt).not.toContain("Place it on a calm area of the scene");
  });

  it("brands without saved layouts keep the base template and record no layout", async () => {
    const provider = new OpenAiCreativeProvider();
    const { executionReference } = await provider.execute(
      request({
        request: "brief",
        platform: "INSTAGRAM",
        contentFormat: "STORY",
        brandContext: brandContext(false),
        // A stale id from a since-removed layout is simply ignored.
        preset: { ...preset, layoutId: "bottom-band" },
      }),
    );

    const args = templateArgs();
    expect(args.template).toEqual(DEFAULT_KIT_TEMPLATE);
    expect(args.safeZone).toBeUndefined();
    // No layout: the logo is placed as stored, exactly as before layouts.
    expect(args.trimLogo).toBe(false);
    expect(await provider.getStatus(executionReference)).toMatchObject({
      rawResult: { layoutTemplate: null },
    });
  });
});
