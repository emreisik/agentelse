import { beforeEach, describe, expect, it, vi } from "vitest";

// One post, one picture (docs/works.md "Shared picture"): a job with
// payload.adaptFromAssetId never draws a new picture. The post's picture goes
// to the image model as the picture to edit, re-laid out for this format at
// its pixel size; the brand template is stamped on the result. A picture that
// cannot be read or adapted fails the job instead of finishing it bare.

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
const applyBrandTemplate = vi.fn();
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));
const loadStyleReferences = vi.fn();
vi.mock("@/server/media/style-references", async (original) => ({
  ...(await original<typeof import("@/server/media/style-references")>()),
  loadStyleReferences,
}));
const readPictureForAdapting = vi.fn();
vi.mock("@/server/media/adapt-picture", async (original) => ({
  ...(await original<typeof import("@/server/media/adapt-picture")>()),
  readPictureForAdapting,
}));

const { OpenAiCreativeProvider } = await import("./openai-creative.provider");

const picture = { data: "BASE64", mimeType: "image/png" };
const rendered = {
  storageKey: "r2://story.png",
  filename: "story.png",
  mimeType: "image/png",
  size: 1,
  provider: "openai",
  width: 1080,
  height: 1920,
};

async function run(payload: Record<string, unknown>) {
  const provider = new OpenAiCreativeProvider();
  await provider.execute({
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
      request: "a brief",
      platform: "INSTAGRAM",
      contentFormat: "STORY",
      ...payload,
    },
  });
  return provider.getStatus("corr-1");
}

beforeEach(() => {
  vi.clearAllMocks();
  runOpenAIStructured.mockResolvedValue({
    raw: { caption: "cap", copy: "copy", imagePrompt: "NEW-PICTURE" },
  });
  applyBrandTemplate.mockResolvedValue(null);
  generateCreativeImage.mockResolvedValue(rendered);
  readPictureForAdapting.mockResolvedValue(picture);
});

describe("adapting the post's picture to another format", () => {
  it("edits the post's picture at this format's size instead of drawing one", async () => {
    const status = await run({ adaptFromAssetId: "asset-a" });

    expect(status.status).toBe("COMPLETED");
    expect(readPictureForAdapting).toHaveBeenCalledWith("asset-a");
    expect(generateCreativeImage).toHaveBeenCalledTimes(1);
    const [prompt, options] = generateCreativeImage.mock.calls[0]!;
    expect(prompt).toContain("Adapt this exact social media design");
    expect(prompt).toContain("1080x1920");
    expect(prompt).not.toContain("NEW-PICTURE");
    expect(options).toMatchObject({
      baseImage: picture,
      imageSize: { width: 1080, height: 1920 },
    });
    // It follows its own picture, not the kit's examples.
    expect(loadStyleReferences).not.toHaveBeenCalled();
    expect(applyBrandTemplate).toHaveBeenCalledTimes(1);
  });

  it("fails the job when the post's picture cannot be read", async () => {
    readPictureForAdapting.mockResolvedValue(undefined);
    const status = await run({ adaptFromAssetId: "gone" });
    expect(status.status).toBe("FAILED");
    expect(generateCreativeImage).not.toHaveBeenCalled();
  });

  it("fails the job when the picture cannot be adapted", async () => {
    generateCreativeImage.mockResolvedValue(null);
    const status = await run({ adaptFromAssetId: "asset-a" });
    expect(status.status).toBe("FAILED");
  });
});
