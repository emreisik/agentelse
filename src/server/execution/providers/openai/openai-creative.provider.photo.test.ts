import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Photo mode (docs/brand-media.md): the brand's own photo is the picture of the
// post. No image model, no art director; the photo is cut to the format, a COPY
// goes through the brand compositing, and the library's original is never
// touched. The post's other formats are cut from the same photo again.

const runOpenAIStructured = vi.fn();
vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => true,
  openaiModelForTier: () => "gpt-test",
  runOpenAIStructured,
}));
const artDirector = vi.hoisted(() => ({ directImage: vi.fn() }));
vi.mock("@/server/media/art-director", () => artDirector);
const generateCreativeImage = vi.fn();
// No image key at all: photo mode must not need one.
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage,
  isCreativeImageConfigured: () => false,
}));
const styleRefs = vi.hoisted(() => ({
  loadStyleReferences: vi.fn(),
  NO_STYLE_REFERENCES: {
    images: [],
    section: undefined,
    matchStyle: false,
    legacyBoard: false,
    exampleCount: 0,
    productCount: 0,
  },
}));
vi.mock("@/server/media/style-references", () => styleRefs);
const applyBrandTemplate = vi.fn();
vi.mock("@/server/media/creative-template", () => ({ applyBrandTemplate }));
const copywriter = vi.hoisted(() => ({ writeOnImageText: vi.fn() }));
vi.mock("@/server/media/headline-copywriter", () => copywriter);
const storage = vi.hoisted(() => ({
  readAsset: vi.fn(),
  putAsset: vi.fn(),
  deleteAsset: vi.fn(),
  overwriteAsset: vi.fn(),
}));
vi.mock("@/server/storage/asset-storage", () => storage);
const db = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  mediaFindUnique: vi.fn(),
  mediaUpdateMany: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    asset: { findFirst: db.assetFindFirst },
    brandMedia: {
      findUnique: db.mediaFindUnique,
      updateMany: db.mediaUpdateMany,
    },
  },
}));
const readPictureForAdapting = vi.fn();
vi.mock("@/server/media/adapt-picture", async (original) => ({
  ...(await original<typeof import("@/server/media/adapt-picture")>()),
  readPictureForAdapting,
}));

const { DEFAULT_KIT_TEMPLATE } = await import("@/lib/brand-kit");
const { buildPresetLayouts } = await import("@/lib/layout-templates");
const { OpenAiCreativeProvider } = await import("./openai-creative.provider");

function brandContext() {
  const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
  return {
    logoAssetId: "logo-light",
    darkLogoAssetId: null,
    approvedColors: null,
    approvedFonts: ["Montserrat"],
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
      layoutTemplates: { ...layouts, defaultId: "headline-top" },
      template: { ...DEFAULT_KIT_TEMPLATE },
    },
  };
}

async function run(payload: Record<string, unknown>) {
  const provider = new OpenAiCreativeProvider();
  const { executionReference } = await provider.execute({
    executionJobId: "job-1",
    correlationId: `corr-${Math.random()}`,
    idempotencyKey: "k",
    capability: "CREATE_SOCIAL_CREATIVE",
    context: {
      workspaceId: "w",
      projectId: "project-1",
      brandId: "b",
      taskId: "t",
      capability: "CREATE_SOCIAL_CREATIVE",
      riskLevel: "LOW",
    },
    payload: {
      request: "Instagram post: Weekend brunch",
      platform: "INSTAGRAM",
      brandContext: brandContext(),
      ...payload,
    },
  });
  return provider.getStatus(executionReference);
}

let photoBytes: Buffer;

beforeEach(async () => {
  vi.clearAllMocks();
  photoBytes = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: "#7a6a55" },
  })
    .jpeg()
    .toBuffer();
  runOpenAIStructured.mockResolvedValue({
    raw: {
      caption: "Brunch is back",
      copy: "Copy",
      imagePrompt: "A sunlit brunch table",
      headline: "Pazar kahvaltısı geri döndü",
      lines: [],
    },
  });
  copywriter.writeOnImageText.mockResolvedValue(null);
  applyBrandTemplate.mockResolvedValue({ size: 2, textDrawn: true });
  db.assetFindFirst.mockResolvedValue({
    id: "photo-1",
    storageKey: "r2://original.jpg",
  });
  db.mediaFindUnique.mockResolvedValue({
    focalX: 0.7,
    focalY: 0.5,
    description: "A sunlit brunch table on a terrace.",
  });
  db.mediaUpdateMany.mockResolvedValue({ count: 1 });
  storage.readAsset.mockResolvedValue(photoBytes);
  let n = 0;
  storage.putAsset.mockImplementation(async () => ({
    storageKey: `r2://copy-${++n}.jpg`,
    filename: `copy-${n}.jpg`,
  }));
  storage.deleteAsset.mockResolvedValue(true);
});

describe("photo mode", () => {
  it("makes the post from the photo with no image model and no art director", async () => {
    const status = await run({ photoAssetIds: ["photo-1"] });
    expect(status.status).toBe("COMPLETED");
    expect(generateCreativeImage).not.toHaveBeenCalled();
    expect(artDirector.directImage).not.toHaveBeenCalled();
    expect(styleRefs.loadStyleReferences).not.toHaveBeenCalled();
    const result = status.rawResult as {
      image: { storageKey: string; width: number; height: number };
      photoSource: { assetId: string; fit: string };
    };
    expect(result.image.width).toBe(1080);
    expect(result.image.height).toBe(1440);
    expect(result.photoSource).toEqual({ assetId: "photo-1", fit: "cover" });
  });

  it("looks the photo up inside the post's own project", async () => {
    await run({ photoAssetIds: ["photo-1"] });
    expect(db.assetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "photo-1", projectId: "project-1", type: "IMAGE" },
      }),
    );
  });

  it("fails the job when the photo is not in this project", async () => {
    db.assetFindFirst.mockResolvedValue(null);
    const status = await run({ photoAssetIds: ["someone-elses"] });
    expect(status.status).toBe("FAILED");
    expect(applyBrandTemplate).not.toHaveBeenCalled();
  });

  it("puts the design on a copy and never touches the library's original", async () => {
    await run({ photoAssetIds: ["photo-1"] });
    expect(storage.overwriteAsset).not.toHaveBeenCalled();
    expect(storage.deleteAsset).not.toHaveBeenCalledWith("r2://original.jpg");
    const stamped = applyBrandTemplate.mock.calls[0]![0] as {
      storageKey: string;
      text?: { headline: string };
    };
    expect(stamped.storageKey).toBe("r2://copy-1.jpg");
    expect(stamped.storageKey).not.toBe("r2://original.jpg");
    expect(stamped.text?.headline).toBeTruthy();
  });

  it("tells the text step what the photo shows", async () => {
    await run({ photoAssetIds: ["photo-1"] });
    const call = runOpenAIStructured.mock.calls[0]![0] as { user: string };
    expect(call.user).toContain("A sunlit brunch table on a terrace.");
  });

  it("counts the use of the photo", async () => {
    await run({ photoAssetIds: ["photo-1"] });
    expect(db.mediaUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assetId: "photo-1" },
        data: expect.objectContaining({ useCount: { increment: 1 } }),
      }),
    );
  });

  it("makes one picture even when variants are asked for", async () => {
    const status = await run({
      photoAssetIds: ["photo-1"],
      variantCount: 3,
    });
    const result = status.rawResult as { alternatives?: unknown };
    expect(result.alternatives).toBeUndefined();
    expect(storage.putAsset).toHaveBeenCalledTimes(2); // the cut + the clean copy
  });

  it("another format of a photo post is cut from the same photo, not redrawn", async () => {
    readPictureForAdapting.mockResolvedValue({
      data: "ignored",
      mimeType: "image/jpeg",
      text: { headline: "Pazar kahvaltısı geri döndü" },
      photoSource: { assetId: "photo-1", fit: "cover" },
    });
    const status = await run({
      adaptFromAssetId: "post-picture",
      contentFormat: "STORY",
    });
    expect(status.status).toBe("COMPLETED");
    expect(generateCreativeImage).not.toHaveBeenCalled();
    const result = status.rawResult as {
      adaptedFrom: string;
      photoSource: { assetId: string; fit: string };
      image: { width: number; height: number };
    };
    expect(result.adaptedFrom).toBe("post-picture");
    expect(result.photoSource.assetId).toBe("photo-1");
    // A landscape photo on a Story: shown whole over a blurred copy.
    expect(result.photoSource.fit).toBe("extend");
    expect(result.image.height).toBe(1920);
    // The same post: not a new use of the photo.
    expect(db.mediaUpdateMany).not.toHaveBeenCalled();
    // The words are set again on the new format.
    expect(
      (applyBrandTemplate.mock.calls[0]![0] as { text?: { headline: string } })
        .text?.headline,
    ).toBe("Pazar kahvaltısı geri döndü");
  });
});
