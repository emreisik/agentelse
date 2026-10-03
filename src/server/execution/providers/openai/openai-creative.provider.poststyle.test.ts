import { beforeEach, describe, expect, it, vi } from "vitest";

// The brand's Post Style Kit on a render: the example posts and the real
// product's pictures go to the image model as an ordered set, the prompt says
// what each is, the standing instructions are in it, and the text step also
// writes the design's on-image words. A brand without a kit is untouched.

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
const loadReferenceImage = vi.fn();
vi.mock("@/server/media/brand-logo", () => ({ loadReferenceImage }));
vi.mock("@/server/media/creative-template", () => ({
  applyBrandTemplate: vi.fn().mockResolvedValue(null),
}));

const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");
const { OpenAiCreativeProvider } = await import("./openai-creative.provider");

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

const preset = { caption: "Cap", copy: "Copy", imagePrompt: "iPhone 16 Pro Max auction" };

const analysis = (recipe: string) => ({
  summary: "Dark premium product ad",
  layout: "",
  typography: "",
  colors: "",
  product: "",
  graphics: "",
  background: "",
  mood: "",
  recipe,
});

function brandContext(over: {
  postStyle?: unknown;
  referenceImageAssetId?: string | null;
} = {}) {
  return {
    logoAssetId: null,
    darkLogoAssetId: null,
    approvedColors: null,
    visualIdentity: {
      primaryColors: [],
      secondaryColors: [],
      accentColors: [],
      photographyStyle: null,
      styleRefinement: null,
      moodTags: [],
      compositionNotes: null,
      backgroundTone: null,
      alwaysInclude: [],
      alwaysAvoid: [],
      referenceImageAssetId: over.referenceImageAssetId ?? null,
      ...(over.postStyle ? { postStyle: over.postStyle } : {}),
      layoutTemplates: null,
      template: { ...DEFAULT_KIT_TEMPLATE },
    },
  };
}

const kit = (fidelity: "match" | "inspired" = "match") => ({
  fidelity,
  directives: "Always product-focused, dark gradient.",
  examples: [
    { assetId: "ex-1", label: "A", analysis: analysis("Dark card, hero phone centre.") },
    { assetId: "ex-2", label: "B", analysis: analysis("Purple button bottom.") },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  generateCreativeImage.mockResolvedValue(image);
  loadReferenceImage.mockImplementation(async (id: string | null | undefined) =>
    id ? { data: `data-${id}`, mimeType: "image/png" } : null,
  );
});

describe("OpenAiCreativeProvider with a Post Style Kit", () => {
  it("sends the examples, then the real product, as an ordered set of reference pictures", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        platform: "INSTAGRAM",
        brandContext: brandContext({ postStyle: kit() }),
        preset: { ...preset, productAssetIds: ["product-1"] },
      }),
    );
    const [prompt, options] = generateCreativeImage.mock.calls[0]!;
    expect(options.referenceImages).toEqual([
      { data: "data-ex-1", mimeType: "image/png" },
      { data: "data-ex-2", mimeType: "image/png" },
      { data: "data-product-1", mimeType: "image/png" },
    ]);
    expect(options).not.toHaveProperty("referenceImage");
    expect(prompt).toContain("POST STYLE KIT:");
    expect(prompt).toContain("the first 2 attached images are example posts");
    expect(prompt).toContain("next attached image shows the REAL product");
    expect(prompt).toContain("- Dark card, hero phone centre.");
    expect(prompt).toContain("Always product-focused, dark gradient.");
    // The kit's section comes right after the subject, before every other taste.
    expect(prompt.indexOf("POST STYLE KIT:")).toBeLessThan(prompt.indexOf("STYLE & LIGHTING:"));
  });

  it("follows only the examples the agent named", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        brandContext: brandContext({ postStyle: kit() }),
        preset: { ...preset, styleExampleIds: ["ex-2"] },
      }),
    );
    expect(generateCreativeImage.mock.calls[0]![1].referenceImages).toEqual([
      { data: "data-ex-2", mimeType: "image/png" },
    ]);
  });

  it("headline and further texts are rendered exactly, where the reference posts put them", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        brandContext: brandContext({ postStyle: kit() }),
        preset: {
          ...preset,
          overlay: {
            headline: "iPhone 16 Pro Max",
            highlight: "Pro Max",
            lines: ["Başlangıç 1 TL", "Teklif ver"],
          },
        },
      }),
    );
    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).toContain("Render exactly these texts");
    expect(prompt).toContain('HEADLINE: "iPhone 16 Pro Max"');
    expect(prompt).toContain('"Başlangıç 1 TL", "Teklif ver"');
    expect(prompt).toContain("in the reference posts");
    expect(prompt).toContain("Place every text where the reference posts place that kind of text.");
  });

  it("when the kit follows its examples the layout's own scene notes stand aside; the compositing still reserves its areas", async () => {
    const withLayouts = (fidelity: "match" | "inspired") => {
      const context = brandContext({ postStyle: kit(fidelity) });
      (context.visualIdentity as { layoutTemplates: unknown }).layoutTemplates =
        buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
      return context;
    };
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        platform: "INSTAGRAM",
        brandContext: withLayouts("inspired"),
        preset: { ...preset, layoutId: "bottom-band" },
      }),
    );
    expect(generateCreativeImage.mock.calls[0]![0]).toContain(
      "bottom part of the frame stays plain",
    );

    vi.clearAllMocks();
    generateCreativeImage.mockResolvedValue(image);
    loadReferenceImage.mockImplementation(async (id: string | null | undefined) =>
      id ? { data: `data-${id}`, mimeType: "image/png" } : null,
    );
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        platform: "INSTAGRAM",
        brandContext: withLayouts("match"),
        preset: { ...preset, layoutId: "bottom-band" },
      }),
    );
    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("bottom part of the frame stays plain");
    // The logo band is still added afterwards, so its area is still kept clear.
    expect(prompt).toContain("covered afterwards");
  });

  it("the worker path: the text step also writes the design's words, and a post can have none", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: {
        caption: "c",
        copy: "d",
        imagePrompt: "p",
        headline: "iPhone 16 Pro Max",
        lines: ["Teklif ver"],
      },
    });
    await new OpenAiCreativeProvider().execute(
      request({ request: "brief", brandContext: brandContext({ postStyle: kit() }) }),
    );
    const call = runOpenAIStructured.mock.calls[0]![0] as {
      system: string;
      jsonSchema: { properties: Record<string, unknown> };
    };
    expect(call.jsonSchema.properties).toHaveProperty("headline");
    expect(call.system).toContain("ALSO produce: `headline`");
    const prompt = generateCreativeImage.mock.calls[0]![0] as string;
    expect(prompt).toContain('HEADLINE: "iPhone 16 Pro Max"');
    expect(prompt).toContain('"Teklif ver"');

    // The examples carry no text: the model leaves the headline empty.
    vi.clearAllMocks();
    generateCreativeImage.mockResolvedValue(image);
    loadReferenceImage.mockResolvedValue({ data: "d", mimeType: "image/png" });
    runOpenAIStructured.mockResolvedValue({
      raw: { caption: "c", copy: "d", imagePrompt: "p", headline: "  " },
    });
    await new OpenAiCreativeProvider().execute(
      request({ request: "brief", brandContext: brandContext({ postStyle: kit() }) }),
    );
    expect(generateCreativeImage.mock.calls[0]![0]).not.toContain("TYPOGRAPHY:");
  });

  it("inspired: a direction, not a replica, and no text step change", async () => {
    runOpenAIStructured.mockResolvedValue({
      raw: { caption: "c", copy: "d", imagePrompt: "p" },
    });
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        brandContext: brandContext({ postStyle: kit("inspired") }),
      }),
    );
    const call = runOpenAIStructured.mock.calls[0]![0] as {
      system: string;
      jsonSchema: { properties: Record<string, unknown> };
    };
    expect(call.jsonSchema.properties).not.toHaveProperty("headline");
    expect(generateCreativeImage.mock.calls[0]![0]).toContain("as the design direction");
  });

  it("instructions without examples still reach every post", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        brandContext: brandContext({
          postStyle: { fidelity: "match", directives: "Always dark.", examples: [] },
        }),
        preset,
      }),
    );
    const [prompt, options] = generateCreativeImage.mock.calls[0]!;
    expect(prompt).toContain("override any other taste: Always dark.");
    expect(options.referenceImage).toBeUndefined();
    expect(options).not.toHaveProperty("referenceImages");
  });
});

describe("a brand without a kit", () => {
  it("keeps the one style board exactly as before", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        brandContext: brandContext({ referenceImageAssetId: "board" }),
        preset,
      }),
    );
    const [prompt, options] = generateCreativeImage.mock.calls[0]!;
    expect(options.referenceImage).toEqual({ data: "data-board", mimeType: "image/png" });
    expect(options).not.toHaveProperty("referenceImages");
    expect(prompt).toContain("A brand style-reference image is attached as the first image");
    expect(prompt).not.toContain("POST STYLE KIT");
  });

  it("a real product picture alone goes along with its own wording", async () => {
    await new OpenAiCreativeProvider().execute(
      request({
        request: "brief",
        brandContext: brandContext(),
        preset: { ...preset, productAssetIds: ["product-1"] },
      }),
    );
    const [prompt, options] = generateCreativeImage.mock.calls[0]!;
    expect(options.referenceImages).toEqual([
      { data: "data-product-1", mimeType: "image/png" },
    ]);
    expect(prompt).toContain("REAL product");
    expect(prompt).not.toContain("REFERENCE POSTS");
  });

  it("no pictures at all: no reference option carries a picture", async () => {
    await new OpenAiCreativeProvider().execute(
      request({ request: "brief", brandContext: brandContext(), preset }),
    );
    const options = generateCreativeImage.mock.calls[0]![1];
    expect(options.referenceImage).toBeUndefined();
    expect(options).not.toHaveProperty("referenceImages");
  });
});
